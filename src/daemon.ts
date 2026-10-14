import { createHash, timingSafeEqual } from 'node:crypto'
import { chmod, lstat, mkdir, readdir, rm } from 'node:fs/promises'
import { connect, type Server, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isRecord, isStringArray, onJsonLines, writeJsonLine } from './json-lines.js'
import { listenFresh } from './listen-fresh.js'
import {
  packageRoot,
  runtimeDir,
  socketDir,
  socketPath,
  stateDir,
  userRuntimeDir,
} from './paths.js'
import { type Reply, RequestError } from './protocol.js'
import { BackendError, Screen } from './screen.js'

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

  constructor(private readonly env: NodeJS.ProcessEnv) {}

  async run(): Promise<number> {
    const path = socketPath(this.env)
    await ensurePrivateFolder(socketDir(this.env))
    if (await existingDaemonIsLive(path)) {
      process.stderr.write(`screens: a daemon is already listening on ${path}\n`)
      return 1
    }
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
    let answered = false
    socket.on('error', () => socket.destroy())
    onJsonLines(socket, (message) => {
      if (answered) return
      answered = true
      this.handle(message)
        .catch((error: unknown): Reply => {
          if (error instanceof RequestError) {
            return { ok: false, code: error.code, message: error.message }
          }
          if (error instanceof BackendError) {
            return { ok: false, code: 'backend', message: error.message }
          }
          return { ok: false, code: 'backend', message: String(error) }
        })
        .then((reply) => {
          writeJsonLine(socket, reply)
          socket.end()
          if (isRecord(message) && message.verb === 'daemon-stop') process.exit(0)
        })
    })
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
      case 'screenshot': {
        const screen = this.authorized(message)
        const shot = await screen.screenshot()
        return {
          ok: true,
          width: shot.width,
          height: shot.height,
          png: shot.png.toString('base64'),
        }
      }
      case 'launch': {
        const screen = this.authorized(message)
        if (!isStringArray(message.argv) || message.argv.length === 0) {
          throw new RequestError('usage', 'launch needs a program')
        }
        return { ok: true, pid: await screen.launch(message.argv) }
      }
      case 'stop': {
        const screen = this.authorized(message)
        await screen.stop()
        return { ok: true, id: screen.id }
      }
      case 'daemon-status':
        return { ok: true, pid: process.pid, screens: this.screens.size }
      case 'daemon-stop':
        await this.shutdown()
        return { ok: true }
      default:
        throw new RequestError('usage', `unknown verb ${message.verb}`)
    }
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
