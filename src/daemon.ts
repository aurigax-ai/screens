import { createHash, timingSafeEqual } from 'node:crypto'
import { chmod, lstat, mkdir, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { connect, type Server, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ScreenBackend } from './backend.js'
import { type Backend, chooseBackend } from './backend-choice.js'
import { screenImage } from './image-ref.js'
import { isRecord, isStringArray, writeJsonLine } from './json-lines.js'
import { listenFresh } from './listen-fresh.js'
import { OciBackend } from './oci-backend.js'
import {
  daemonLabel,
  detectRuntime,
  ensureImage,
  installHint,
  type RuntimeName,
  removeContainersOf,
  runtimeAnswers,
  runtimeNames,
  seccompProfile,
} from './oci-runtime.js'
import {
  configPath,
  packageRoot,
  runtimeDir,
  socketDir,
  socketPath,
  stateDir,
  userRuntimeDir,
} from './paths.js'
import { PhoneScreen } from './phone-screen.js'
import { phoneVerbs } from './phone-verbs.js'
import { type Reply, RequestError } from './protocol.js'
import { BackendError, newScreenId, Screen } from './screen.js'
import { screenVerbs } from './screen-verbs.js'
import { XvncBackend } from './xvnc-backend.js'

const containerSockets = [
  '/run/docker.sock',
  '/var/run/docker.sock',
  '/run/containerd/containerd.sock',
  '/run/podman/podman.sock',
  '/run/crio/crio.sock',
]

const maximumRequestBytes = 1024 * 1024
const defaultMaxScreens = 4
const maxScreensRange = { minimum: 1, maximum: 16 }
const minimumSide = 64
const maximumSide = 8192
const defaultWidth = 1280
const defaultHeight = 800

async function ensurePrivateFolder(folder: string): Promise<void> {
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const info = await lstat(folder)
  if (!info.isDirectory() || info.uid !== process.getuid?.()) {
    throw new Error(`${folder} is not a folder owned by this user`)
  }
  await chmod(folder, 0o700)
}

function isLive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(path)
    probe.on('connect', () => {
      probe.destroy()
      resolve(true)
    })
    probe.on('error', () => resolve(false))
  })
}

async function existingDaemonIsLive(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    return info.isSocket() && (await isLive(path))
  } catch {
    return false
  }
}

async function reachableContainerSockets(): Promise<string[]> {
  const reachable = new Set<string>()
  for (const path of containerSockets) {
    try {
      const real = await realpath(path)
      if ((await lstat(real)).isSocket() && (await isLive(real))) reachable.add(real)
    } catch {}
  }
  return [...reachable]
}

type DaemonConfig = { maxScreens: number; defaultBackend: Backend | undefined }

async function readConfig(env: NodeJS.ProcessEnv): Promise<DaemonConfig> {
  const path = configPath(env)
  const defaults: DaemonConfig = { maxScreens: defaultMaxScreens, defaultBackend: undefined }
  let config: unknown
  try {
    config = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaults
    process.stderr.write(`screens: ${path} is not valid JSON; maxScreens is ${defaultMaxScreens}\n`)
    return defaults
  }
  if (!isRecord(config)) return defaults
  const value = config.maxScreens
  let maxScreens = defaultMaxScreens
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= maxScreensRange.minimum &&
    value <= maxScreensRange.maximum
  ) {
    maxScreens = value
  } else if (value !== undefined) {
    process.stderr.write(
      `screens: maxScreens in ${path} must be a whole number from ${maxScreensRange.minimum} to ${maxScreensRange.maximum}; using the default ${defaultMaxScreens}\n`,
    )
  }
  let defaultBackend: Backend | undefined
  if (config.defaultBackend === 'xvnc' || config.defaultBackend === 'oci') {
    defaultBackend = config.defaultBackend
  } else if (config.defaultBackend !== undefined) {
    process.stderr.write(`screens: defaultBackend in ${path} must be xvnc or oci; ignoring it\n`)
  }
  return { maxScreens, defaultBackend }
}

type Progress = (line: string) => void

function progressWriter(socket: Socket, message: unknown): Progress {
  if (!isRecord(message) || message.progress !== true) return () => {}
  return (line) => writeJsonLine(socket, { type: 'progress', message: line })
}

function failureReply(error: unknown): Reply {
  if (error instanceof RequestError) return { ok: false, code: error.code, message: error.message }
  if (error instanceof BackendError) return { ok: false, code: 'backend', message: error.message }
  return { ok: false, code: 'backend', message: String(error) }
}

function sameToken(given: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(given), digest(expected))
}

function stringField(request: Record<string, unknown>, name: string): string {
  const value = request[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new RequestError('usage', `missing ${name}`)
  }
  return value
}

function sideField(request: Record<string, unknown>, name: string, fallback: number): number {
  const value = request[name] ?? fallback
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < minimumSide ||
    value > maximumSide
  ) {
    throw new RequestError(
      'usage',
      `${name} must be a whole number from ${minimumSide} to ${maximumSide}`,
    )
  }
  return value
}

type AnyScreen = Screen | PhoneScreen

function notOnPhone(screen: AnyScreen, what: string): Screen {
  if (screen instanceof PhoneScreen) {
    throw new RequestError('refused', `a phone screen has no ${what}; only the phone pauses it`)
  }
  return screen
}

export class Daemon {
  private readonly screens = new Map<string, AnyScreen>()
  private server: Server | undefined
  private shutdownStarted: Promise<void> | undefined
  private maxScreens = defaultMaxScreens
  private defaultBackend: Backend | undefined
  private detectedRuntime: Promise<RuntimeName | undefined> | undefined
  private seccompProfiles = new Map<RuntimeName, Promise<string | undefined>>()
  private cleaned: Promise<void> = Promise.resolve()

  constructor(private readonly env: NodeJS.ProcessEnv) {}

  async run(): Promise<number> {
    const path = socketPath(this.env)
    await ensurePrivateFolder(socketDir(this.env))
    if (await existingDaemonIsLive(path)) {
      process.stderr.write(`screens: a daemon is already listening on ${path}\n`)
      return 1
    }
    const config = await readConfig(this.env)
    this.maxScreens = config.maxScreens
    this.defaultBackend = config.defaultBackend
    await ensurePrivateFolder(stateDir(this.env))
    for (const leftover of await readdir(stateDir(this.env))) {
      await rm(join(stateDir(this.env), leftover), { recursive: true, force: true })
    }
    this.cleaned = this.removeLeftoverContainers()
    this.server = await listenFresh(path, (socket) => this.serve(socket))
    process.on('SIGTERM', () => void this.shutdown().then(() => process.exit(0)))
    process.on('SIGINT', () => void this.shutdown().then(() => process.exit(0)))
    return new Promise<number>(() => {})
  }

  private serve(socket: Socket): void {
    socket.on('error', () => socket.destroy())
    let pending = Buffer.alloc(0)
    const onData = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])
      const newline = pending.indexOf(10)
      if (newline < 0) {
        if (pending.length > maximumRequestBytes) socket.destroy()
        return
      }
      socket.off('data', onData)
      socket.pause()
      const rest = pending.subarray(newline + 1)
      if (rest.length > 0) socket.unshift(rest)
      let message: unknown
      try {
        message = JSON.parse(pending.subarray(0, newline).toString('utf8'))
      } catch {
        message = undefined
      }
      this.dispatch(socket, message)
    }
    socket.on('data', onData)
  }

  private dispatch(socket: Socket, message: unknown): void {
    if (isRecord(message) && message.verb === 'events') {
      this.subscribe(socket, message)
      return
    }
    if (isRecord(message) && message.verb === 'view') {
      this.view(socket, message).catch((error: unknown) => {
        writeJsonLine(socket, failureReply(error))
        socket.end()
      })
      return
    }
    if (isRecord(message) && message.verb === 'create' && message.backend === 'phone') {
      this.phoneCreate(socket, message)
      return
    }
    if (isRecord(message) && message.verb === 'create' && message.lease === true) {
      this.leasedCreate(socket, message)
      return
    }
    this.handle(message, progressWriter(socket, message))
      .catch(failureReply)
      .then((reply) => {
        writeJsonLine(socket, reply)
        socket.end()
        if (isRecord(message) && message.verb === 'daemon-stop') process.exit(0)
      })
  }

  private phoneCreate(socket: Socket, message: Record<string, unknown>): void {
    try {
      if (message.lease !== true) {
        throw new RequestError(
          'usage',
          'a phone screen needs --lease: its connection relays to the phone',
        )
      }
      if (message.allow !== undefined || message.runtime !== undefined) {
        throw new RequestError('usage', '--allow and --runtime do not apply to a phone screen')
      }
      if (this.shutdownStarted) throw new RequestError('refused', 'the daemon is stopping')
      if (this.screens.size >= this.maxScreens) {
        throw new RequestError('refused', `limit: at most ${this.maxScreens} screens run at once`)
      }
      const label = typeof message.label === 'string' ? message.label : ''
      const width = sideField(message, 'width', defaultWidth)
      const height = sideField(message, 'height', defaultHeight)
      const screen = new PhoneScreen({ id: newScreenId(), width, height, label }, socket, (gone) =>
        this.screens.delete(gone.id),
      )
      this.screens.set(screen.id, screen)
      writeJsonLine(socket, {
        ok: true,
        id: screen.id,
        agentToken: screen.agentToken,
        viewerToken: screen.viewerToken,
        width,
        height,
        backend: 'phone',
      })
      screen.start()
    } catch (error) {
      writeJsonLine(socket, failureReply(error))
      socket.end()
    }
  }

  private leasedCreate(socket: Socket, message: Record<string, unknown>): void {
    let released = false
    let leased: AnyScreen | undefined
    const release = () => {
      released = true
      void leased?.stop()
    }
    socket.once('close', release)
    socket.resume()
    this.handle(message, progressWriter(socket, message))
      .catch(failureReply)
      .then((reply) => {
        writeJsonLine(socket, reply)
        if (!reply.ok) {
          socket.end()
          return
        }
        leased = this.screens.get(String(reply.id))
        if (released) void leased?.stop()
        leased?.events.on('event', (event: Record<string, unknown>) => {
          if (event.type === 'stopped') socket.end()
        })
      })
  }

  private async view(socket: Socket, message: Record<string, unknown>): Promise<void> {
    const screen = notOnPhone(this.viewerAuthorized(message), 'viewer')
    await screen.attachViewer(socket, (viewer) => writeJsonLine(socket, { ok: true, viewer }))
  }

  private async handle(message: unknown, progress: Progress): Promise<Reply> {
    if (!isRecord(message) || typeof message.verb !== 'string') {
      throw new RequestError('usage', 'malformed request')
    }
    switch (message.verb) {
      case 'list':
        return { ok: true, screens: [...this.screens.values()].map((screen) => screen.summary()) }
      case 'create':
        return this.create(message, progress)
      case 'stop': {
        const screen = this.authorized(message)
        await screen.stop()
        return { ok: true, id: screen.id }
      }
      case 'allow':
      case 'deny': {
        const screen = notOnPhone(this.viewerAuthorized(message), 'network to answer for')
        const host = typeof message.host === 'string' ? message.host : ''
        if (!/^[A-Za-z0-9.:[\]_-]+$/.test(host)) {
          throw new RequestError('usage', 'host must be a host name or address')
        }
        screen.answerNetwork(host, message.verb === 'allow')
        return { ok: true, host: host.toLowerCase(), allow: message.verb === 'allow' }
      }
      case 'takeover':
      case 'giveback': {
        const screen = notOnPhone(this.viewerAuthorized(message), 'takeover')
        const viewer = typeof message.viewer === 'string' ? message.viewer : ''
        if (message.verb === 'takeover') screen.takeover(viewer)
        else screen.giveback(viewer)
        return { ok: true, owner: screen.owner }
      }
      case 'daemon-status':
        return {
          ok: true,
          pid: process.pid,
          screens: this.screens.size,
          maxScreens: this.maxScreens,
        }
      case 'daemon-stop':
        await this.shutdown()
        return { ok: true }
      default: {
        const verb = screenVerbs[message.verb]
        if (!verb || !Object.hasOwn(screenVerbs, message.verb)) {
          throw new RequestError('usage', `unknown verb ${message.verb}`)
        }
        const screen = this.authorized(message)
        if (screen instanceof PhoneScreen) {
          const phoneVerb = phoneVerbs[message.verb]
          if (!phoneVerb || !Object.hasOwn(phoneVerbs, message.verb)) {
            throw new RequestError(
              'unsupported',
              `${message.verb} is not supported on a phone screen`,
            )
          }
          return { ok: true, ...(await phoneVerb(screen, message)) }
        }
        return { ok: true, ...(await verb(screen, message)) }
      }
    }
  }

  private subscribe(socket: Socket, message: Record<string, unknown>): void {
    let screen: AnyScreen
    try {
      screen = this.authorized(message)
    } catch (error) {
      const failure = error as RequestError
      writeJsonLine(socket, { ok: false, code: failure.code, message: failure.message })
      socket.end()
      return
    }
    const forward = (event: Record<string, unknown>) => {
      writeJsonLine(socket, event)
      if (event.type === 'stopped') socket.end()
    }
    screen.events.on('event', forward)
    socket.resume()
    socket.on('close', () => screen.events.off('event', forward))
    writeJsonLine(socket, { ok: true })
  }

  private viewerAuthorized(message: Record<string, unknown>): AnyScreen {
    const screen = this.authorized(message)
    const token = typeof message.token === 'string' ? message.token : ''
    if (!sameToken(token, screen.viewerToken)) {
      throw new RequestError('refused', 'only the viewer token takes over, gives back or views')
    }
    return screen
  }

  private authorized(message: Record<string, unknown>): AnyScreen {
    const id = stringField(message, 'id')
    const screen = this.screens.get(id)
    if (!screen) throw new RequestError('not-found', `no screen ${id}`)
    const token = typeof message.token === 'string' ? message.token : ''
    if (!sameToken(token, screen.agentToken) && !sameToken(token, screen.viewerToken)) {
      throw new RequestError('refused', 'token does not open this screen')
    }
    return screen
  }

  private label(): string {
    return daemonLabel(socketPath(this.env))
  }

  private runtime(): Promise<RuntimeName | undefined> {
    this.detectedRuntime ??= detectRuntime(process.platform, this.env)
    return this.detectedRuntime
  }

  private async removeLeftoverContainers(): Promise<void> {
    const runtime = await this.runtime()
    if (runtime) await removeContainersOf(runtime, this.label(), this.env)
  }

  private seccomp(runtime: RuntimeName): Promise<string | undefined> {
    let profile = this.seccompProfiles.get(runtime)
    if (!profile) {
      profile = seccompProfile(runtime, stateDir(this.env), this.env)
      this.seccompProfiles.set(runtime, profile)
    }
    return profile
  }

  private async chosenRuntime(requested: unknown): Promise<RuntimeName> {
    if (requested !== undefined) {
      if (!runtimeNames.includes(requested as RuntimeName)) {
        throw new RequestError('usage', `runtime must be one of ${runtimeNames.join(', ')}`)
      }
      const runtime = requested as RuntimeName
      if (!(await runtimeAnswers(runtime, this.env))) {
        throw new BackendError(`${runtime} does not answer; ${installHint(process.platform)}`)
      }
      return runtime
    }
    const runtime = await this.runtime()
    if (!runtime) {
      throw new BackendError(`no container runtime answers; ${installHint(process.platform)}`)
    }
    return runtime
  }

  private async create(message: Record<string, unknown>, progress: Progress): Promise<Reply> {
    if (this.shutdownStarted) throw new RequestError('refused', 'the daemon is stopping')
    const requested = message.backend
    if (requested !== undefined && requested !== 'xvnc' && requested !== 'oci') {
      throw new RequestError('usage', 'backend must be xvnc, oci or phone')
    }
    const backendName = chooseBackend({
      platform: process.platform,
      requested,
      configured: this.defaultBackend,
    })
    if (this.screens.size >= this.maxScreens) {
      throw new RequestError('refused', `limit: at most ${this.maxScreens} screens run at once`)
    }
    const allow = message.allow ?? []
    if (!isStringArray(allow)) throw new RequestError('usage', 'allow must be a list of domains')
    const label = typeof message.label === 'string' ? message.label : ''
    const width = sideField(message, 'width', defaultWidth)
    const height = sideField(message, 'height', defaultHeight)
    const id = newScreenId()
    const folder = join(stateDir(this.env), id)
    let backend: ScreenBackend
    if (backendName === 'oci') {
      await this.cleaned
      const runtime = await this.chosenRuntime(message.runtime)
      const image = await screenImage(this.env)
      if (!image) {
        throw new BackendError('no screen image is pinned in this package; set SCREENS_OCI_IMAGE')
      }
      await ensureImage(runtime, image, this.env, progress)
      backend = new OciBackend({
        id,
        folder,
        width,
        height,
        allowedDomains: allow,
        runtime,
        image,
        seccomp: await this.seccomp(runtime),
        daemon: this.label(),
        env: this.env,
      })
    } else {
      if (message.runtime !== undefined) {
        throw new RequestError('usage', '--runtime applies to the oci backend only')
      }
      backend = new XvncBackend({
        folder,
        width,
        height,
        allowedDomains: allow,
        deniedFolders: [
          homedir(),
          runtimeDir(this.env),
          userRuntimeDir(),
          '/tmp',
          socketDir(this.env),
          stateDir(this.env),
          ...(await reachableContainerSockets()),
        ],
        readableFolders: [packageRoot],
      })
    }
    if (this.screens.size >= this.maxScreens) {
      throw new RequestError('refused', `limit: at most ${this.maxScreens} screens run at once`)
    }
    const screen = new Screen({ id, width, height, label }, backend, (gone) =>
      this.screens.delete(gone.id),
    )
    this.screens.set(screen.id, screen)
    await screen.start()
    const summary = screen.summary()
    return {
      ok: true,
      id: screen.id,
      agentToken: screen.agentToken,
      viewerToken: screen.viewerToken,
      width: summary.width,
      height: summary.height,
      backend: summary.backend,
      ...(summary.runtime ? { runtime: summary.runtime } : {}),
    }
  }

  shutdown(): Promise<void> {
    this.shutdownStarted ??= (async () => {
      this.server?.close()
      await Promise.all([...this.screens.values()].map((screen) => screen.stop()))
    })()
    return this.shutdownStarted
  }
}
