import { createHash, timingSafeEqual } from 'node:crypto'
import { chmod, lstat, mkdir, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { connect, type Server, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isRecord, isStringArray, writeJsonLine } from './json-lines.js'
import { listenFresh } from './listen-fresh.js'
import {
  configPath,
  packageRoot,
  runtimeDir,
  socketDir,
  socketPath,
  stateDir,
  userRuntimeDir,
} from './paths.js'
import { type Reply, RequestError } from './protocol.js'
import { BackendError, Screen } from './screen.js'
import { screenVerbs } from './screen-verbs.js'

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

async function readMaxScreens(env: NodeJS.ProcessEnv): Promise<number> {
  const path = configPath(env)
  let config: unknown
  try {
    config = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultMaxScreens
    process.stderr.write(`screens: ${path} is not valid JSON; maxScreens is ${defaultMaxScreens}\n`)
    return defaultMaxScreens
  }
  if (!isRecord(config) || config.maxScreens === undefined) return defaultMaxScreens
  const value = config.maxScreens
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= maxScreensRange.minimum &&
    value <= maxScreensRange.maximum
  ) {
    return value
  }
  process.stderr.write(
    `screens: maxScreens in ${path} must be a whole number from ${maxScreensRange.minimum} to ${maxScreensRange.maximum}; using the default ${defaultMaxScreens}\n`,
  )
  return defaultMaxScreens
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

export class Daemon {
  private readonly screens = new Map<string, Screen>()
  private server: Server | undefined
  private shutdownStarted: Promise<void> | undefined
  private maxScreens = defaultMaxScreens

  constructor(private readonly env: NodeJS.ProcessEnv) {}

  async run(): Promise<number> {
    const path = socketPath(this.env)
    await ensurePrivateFolder(socketDir(this.env))
    if (await existingDaemonIsLive(path)) {
      process.stderr.write(`screens: a daemon is already listening on ${path}\n`)
      return 1
    }
    this.maxScreens = await readMaxScreens(this.env)
    await ensurePrivateFolder(stateDir(this.env))
    for (const leftover of await readdir(stateDir(this.env))) {
      await rm(join(stateDir(this.env), leftover), { recursive: true, force: true })
    }
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
    this.handle(message)
      .catch(failureReply)
      .then((reply) => {
        writeJsonLine(socket, reply)
        socket.end()
        if (isRecord(message) && message.verb === 'daemon-stop') process.exit(0)
      })
  }

  private async view(socket: Socket, message: Record<string, unknown>): Promise<void> {
    const screen = this.viewerAuthorized(message)
    await screen.attachViewer(socket, (viewer) => writeJsonLine(socket, { ok: true, viewer }))
  }

  private async handle(message: unknown): Promise<Reply> {
    if (!isRecord(message) || typeof message.verb !== 'string') {
      throw new RequestError('usage', 'malformed request')
    }
    switch (message.verb) {
      case 'list':
        return { ok: true, screens: [...this.screens.values()].map((screen) => screen.summary()) }
      case 'create':
        return this.create(message)
      case 'stop': {
        const screen = this.authorized(message)
        await screen.stop()
        return { ok: true, id: screen.id }
      }
      case 'allow':
      case 'deny': {
        const screen = this.viewerAuthorized(message)
        const host = typeof message.host === 'string' ? message.host : ''
        if (!/^[A-Za-z0-9.:[\]_-]+$/.test(host)) {
          throw new RequestError('usage', 'host must be a host name or address')
        }
        screen.answerNetwork(host, message.verb === 'allow')
        return { ok: true, host: host.toLowerCase(), allow: message.verb === 'allow' }
      }
      case 'takeover':
      case 'giveback': {
        const screen = this.viewerAuthorized(message)
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
        return { ok: true, ...(await verb(screen, message)) }
      }
    }
  }

  private subscribe(socket: Socket, message: Record<string, unknown>): void {
    let screen: Screen
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

  private viewerAuthorized(message: Record<string, unknown>): Screen {
    const screen = this.authorized(message)
    const token = typeof message.token === 'string' ? message.token : ''
    if (!sameToken(token, screen.viewerToken)) {
      throw new RequestError('refused', 'only the viewer token takes over, gives back or views')
    }
    return screen
  }

  private authorized(message: Record<string, unknown>): Screen {
    const id = stringField(message, 'id')
    const screen = this.screens.get(id)
    if (!screen) throw new RequestError('not-found', `no screen ${id}`)
    const token = typeof message.token === 'string' ? message.token : ''
    if (!sameToken(token, screen.agentToken) && !sameToken(token, screen.viewerToken)) {
      throw new RequestError('refused', 'token does not open this screen')
    }
    return screen
  }

  private async create(message: Record<string, unknown>): Promise<Reply> {
    if (this.shutdownStarted) throw new RequestError('refused', 'the daemon is stopping')
    if (this.screens.size >= this.maxScreens) {
      throw new RequestError('refused', `limit: at most ${this.maxScreens} screens run at once`)
    }
    const allow = message.allow ?? []
    if (!isStringArray(allow)) throw new RequestError('usage', 'allow must be a list of domains')
    const label = typeof message.label === 'string' ? message.label : ''
    const screen = new Screen(
      {
        stateDir: stateDir(this.env),
        width: sideField(message, 'width', defaultWidth),
        height: sideField(message, 'height', defaultHeight),
        label,
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
      },
      (gone) => this.screens.delete(gone.id),
    )
    this.screens.set(screen.id, screen)
    await screen.start()
    return {
      ok: true,
      id: screen.id,
      agentToken: screen.agentToken,
      viewerToken: screen.viewerToken,
      width: screen.summary().width,
      height: screen.summary().height,
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
