import { type ChildProcess, fork } from 'node:child_process'
import { openSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import type { Server, Socket } from 'node:net'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import {
  BackendError,
  type BackendEvents,
  type ScreenBackend,
  waitForExit,
  withTimeout,
} from './backend.js'
import { isRecord, onJsonLines, writeJsonLine } from './json-lines.js'
import { listenFresh } from './listen-fresh.js'
import { screenHostPath } from './paths.js'
import type { ScreenHostConfig } from './screen-host.js'

const relayTimeoutMs = 5_000
const hostExitTimeoutMs = 5_000

export type XvncOptions = {
  folder: string
  width: number
  height: number
  allowedDomains: string[]
  deniedFolders: string[]
  readableFolders: string[]
}

export class XvncBackend implements ScreenBackend {
  readonly name = 'xvnc'
  readonly runtime = undefined
  private readonly screenFolder: string
  private readonly linkFolder: string
  private readonly bridgeFolder: string
  private servers: Server[] = []
  private host: ChildProcess | undefined
  private hostExited: Promise<void> = Promise.resolve()
  private wrapPid: number | undefined
  private control: Socket | undefined
  private rfbWaiters: ((socket: Socket) => void)[] = []
  private accepting = true

  constructor(private readonly options: XvncOptions) {
    this.screenFolder = join(options.folder, 'screen')
    this.linkFolder = join(options.folder, 'link')
    this.bridgeFolder = join(options.folder, 'bridge')
  }

  async start(events: BackendEvents): Promise<void> {
    for (const folder of [
      this.options.folder,
      this.screenFolder,
      this.linkFolder,
      this.bridgeFolder,
    ]) {
      await mkdir(folder, { mode: 0o700 })
    }
    this.servers.push(
      await listenFresh(join(this.linkFolder, 'launch.sock'), (socket) =>
        this.acceptControl(socket, events),
      ),
      await listenFresh(join(this.linkFolder, 'rfb.sock'), (socket) => this.acceptRelay(socket)),
    )
    const log = openSync(join(this.options.folder, 'screen.log'), 'a')
    const host = fork(screenHostPath, [], {
      cwd: this.bridgeFolder,
      env: { ...process.env, TMPDIR: this.bridgeFolder },
      stdio: ['ignore', log, log, 'ipc'],
    })
    this.host = host
    this.hostExited = new Promise((resolve) => host.once('exit', () => resolve()))
    host.on('message', (message: unknown) => {
      if (!isRecord(message)) return
      if (message.type === 'started' && typeof message.wrapPid === 'number') {
        this.wrapPid = message.wrapPid
      } else if (message.type === 'failed') {
        events.gone(`sandbox failed: ${String(message.message)}`)
      } else if (
        message.type === 'ask' &&
        typeof message.requestId === 'number' &&
        typeof message.host === 'string'
      ) {
        const requestId = message.requestId
        void events
          .ask(message.host, typeof message.port === 'number' ? message.port : undefined)
          .then((allow) => {
            if (host.connected) host.send({ type: 'answer', requestId, allow })
          })
      } else if (message.type === 'wrap-exited') {
        events.gone('the screen exited')
      }
    })
    host.once('exit', () => events.gone('the sandbox host exited'))
    const config: ScreenHostConfig = {
      mode: 'screen',
      screenFolder: this.screenFolder,
      linkFolder: this.linkFolder,
      width: this.options.width,
      height: this.options.height,
      allowedDomains: this.options.allowedDomains,
      deniedFolders: this.options.deniedFolders,
      readableFolders: [this.bridgeFolder, ...this.options.readableFolders],
    }
    host.send({ type: 'start', config })
  }

  private acceptControl(socket: Socket, events: BackendEvents): void {
    if (this.control || !this.accepting) {
      socket.destroy()
      return
    }
    this.control = socket
    this.accepting = false
    socket.on('error', () => socket.destroy())
    socket.on('close', () => events.gone('screens-init closed its connection'))
    onJsonLines(socket, (message) => {
      if (isRecord(message)) events.message(message)
    })
  }

  private acceptRelay(socket: Socket): void {
    const waiter = this.rfbWaiters.shift()
    if (!waiter) {
      socket.destroy()
      return
    }
    waiter(socket)
  }

  send(message: Record<string, unknown>): void {
    if (this.control) writeJsonLine(this.control, message)
  }

  openRelay(): Promise<Duplex> {
    if (!this.control) return Promise.reject(new BackendError('screen is not connected'))
    const relay = new Promise<Socket>((resolve) => this.rfbWaiters.push(resolve))
    this.send({ type: 'rfb' })
    return withTimeout(relay, relayTimeoutMs, 'screen relay')
  }

  async stop(): Promise<void> {
    this.accepting = false
    if (this.host?.connected) this.host.send({ type: 'stop' })
    if (!(await waitForExit(this.hostExited, hostExitTimeoutMs))) {
      this.host?.kill('SIGKILL')
      if (this.wrapPid !== undefined) {
        try {
          process.kill(this.wrapPid, 'SIGKILL')
        } catch {}
      }
      await this.hostExited
    }
    this.control?.destroy()
    for (const server of this.servers) server.close()
    await rm(this.options.folder, { recursive: true, force: true })
  }
}
