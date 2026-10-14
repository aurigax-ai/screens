import { type ChildProcess, fork } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { openSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import type { Server, Socket } from 'node:net'
import { join } from 'node:path'
import { ActionLog } from './action-log.js'
import type { Raster } from './image.js'
import { isRecord, onJsonLines, writeJsonLine } from './json-lines.js'
import { listenFresh } from './listen-fresh.js'
import { screenHostPath } from './paths.js'
import { RequestError } from './protocol.js'
import { RfbClient } from './rfb-client.js'
import { ClientMessageFilter } from './rfb-filter.js'
import type { ScreenHostConfig } from './screen-host.js'

export type ScreenOptions = {
  stateDir: string
  width: number
  height: number
  label: string
  allowedDomains: string[]
  deniedFolders: string[]
  readableFolders: string[]
}

export type ScreenSummary = {
  id: string
  width: number
  height: number
  label: string
  owner: 'agent' | 'human'
  state: 'starting' | 'running' | 'stopping'
}

const startTimeoutMs = 15_000
const relayTimeoutMs = 5_000
const launchTimeoutMs = 10_000
const hostExitTimeoutMs = 5_000

export class BackendError extends Error {}

function newToken(): string {
  return randomBytes(32).toString('hex')
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new BackendError(`${what} timed out`)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export class Screen {
  readonly id = randomBytes(4).toString('hex')
  readonly agentToken = newToken()
  readonly viewerToken = newToken()
  readonly folder: string
  readonly screenFolder: string
  readonly linkFolder: string
  readonly bridgeFolder: string
  owner: 'agent' | 'human' = 'agent'
  state: ScreenSummary['state'] = 'starting'
  private servers: Server[] = []
  private host: ChildProcess | undefined
  private hostExited: Promise<void> = Promise.resolve()
  private wrapPid: number | undefined
  private control: Socket | undefined
  private readyWaiter: (() => void) | undefined
  private rfbWaiters: ((socket: Socket) => void)[] = []
  private rfb: RfbClient | undefined
  private nextRequestId = 1
  private initWaiters = new Map<
    number,
    { resolve: (message: Record<string, unknown>) => void; reject: (error: Error) => void }
  >()
  readonly log = new ActionLog()
  readonly events = new EventEmitter()
  cursor: { x: number; y: number }
  private buttons = 0
  private viewers = new Map<string, Socket>()
  private controller: string | undefined
  private stopped: Promise<void> | undefined

  constructor(
    private readonly options: ScreenOptions,
    private readonly onGone: (screen: Screen) => void,
  ) {
    this.folder = join(options.stateDir, this.id)
    this.screenFolder = join(this.folder, 'screen')
    this.linkFolder = join(this.folder, 'link')
    this.bridgeFolder = join(this.folder, 'bridge')
    this.cursor = { x: Math.floor(options.width / 2), y: Math.floor(options.height / 2) }
  }

  get width(): number {
    return this.options.width
  }

  get height(): number {
    return this.options.height
  }

  summary(): ScreenSummary {
    return {
      id: this.id,
      width: this.options.width,
      height: this.options.height,
      label: this.options.label,
      owner: this.owner,
      state: this.state,
    }
  }

  async start(): Promise<void> {
    try {
      await withTimeout(this.boot(), startTimeoutMs, 'screen start')
      this.state = 'running'
    } catch (error) {
      await this.stop()
      throw error instanceof BackendError ? error : new BackendError(String(error))
    }
  }

  private async boot(): Promise<void> {
    for (const folder of [this.folder, this.screenFolder, this.linkFolder, this.bridgeFolder]) {
      await mkdir(folder, { mode: 0o700 })
    }
    this.servers.push(
      await listenFresh(join(this.linkFolder, 'launch.sock'), (socket) =>
        this.acceptControl(socket),
      ),
      await listenFresh(join(this.linkFolder, 'rfb.sock'), (socket) => this.acceptRelay(socket)),
    )
    const ready = new Promise<void>((resolve) => {
      this.readyWaiter = resolve
    })
    const log = openSync(join(this.folder, 'screen.log'), 'a')
    const host = fork(screenHostPath, [], {
      cwd: this.bridgeFolder,
      env: { ...process.env, TMPDIR: this.bridgeFolder },
      stdio: ['ignore', log, log, 'ipc'],
    })
    this.host = host
    this.hostExited = new Promise((resolve) => host.once('exit', () => resolve()))
    const failed = new Promise<never>((_resolve, reject) => {
      host.on('message', (message: unknown) => {
        if (!isRecord(message)) return
        if (message.type === 'started' && typeof message.wrapPid === 'number') {
          this.wrapPid = message.wrapPid
        } else if (message.type === 'failed') {
          reject(new BackendError(`sandbox failed: ${String(message.message)}`))
        } else if (message.type === 'wrap-exited') {
          reject(new BackendError('screen exited during start'))
          void this.stop()
        }
      })
      host.once('exit', () => {
        reject(new BackendError('sandbox host exited'))
        void this.stop()
      })
    })
    failed.catch(() => {})
    const config: ScreenHostConfig = {
      screenFolder: this.screenFolder,
      linkFolder: this.linkFolder,
      width: this.options.width,
      height: this.options.height,
      allowedDomains: this.options.allowedDomains,
      deniedFolders: this.options.deniedFolders,
      readableFolders: [this.bridgeFolder, ...this.options.readableFolders],
    }
    host.send({ type: 'start', config })
    await Promise.race([ready, failed])
    this.rfb = await Promise.race([this.openRfb(), failed])
  }

  private acceptControl(socket: Socket): void {
    if (this.control || this.state !== 'starting') {
      socket.destroy()
      return
    }
    this.control = socket
    socket.on('error', () => socket.destroy())
    socket.on('close', () => void this.stop())
    onJsonLines(socket, (message) => this.handleInitMessage(message))
  }

  private acceptRelay(socket: Socket): void {
    const waiter = this.rfbWaiters.shift()
    if (!waiter) {
      socket.destroy()
      return
    }
    waiter(socket)
  }

  private handleInitMessage(message: unknown): void {
    if (!isRecord(message)) return
    if (message.type === 'ready') {
      this.readyWaiter?.()
      this.readyWaiter = undefined
      return
    }
    const requestId = message.requestId
    if (typeof requestId !== 'number') return
    const waiter = this.initWaiters.get(requestId)
    if (!waiter) return
    this.initWaiters.delete(requestId)
    if (message.type === 'launched' || message.type === 'ran') waiter.resolve(message)
    else waiter.reject(new BackendError(String(message.message ?? 'launch failed')))
  }

  private async openRelay(): Promise<Socket> {
    const control = this.control
    if (!control) throw new BackendError('screen is not connected')
    const relay = new Promise<Socket>((resolve) => this.rfbWaiters.push(resolve))
    writeJsonLine(control, { type: 'rfb' })
    return withTimeout(relay, relayTimeoutMs, 'screen relay')
  }

  private async openRfb(): Promise<RfbClient> {
    const socket = await this.openRelay()
    const client = await withTimeout(RfbClient.connect(socket), relayTimeoutMs, 'RFB handshake')
    void client.closed.then(() => void this.stop())
    return client
  }

  async attachViewer(viewer: Socket, accepted: (viewerId: string) => void): Promise<void> {
    if (this.state !== 'running') throw new BackendError('screen is not running')
    const relay = await this.openRelay()
    const viewerId = randomBytes(4).toString('hex')
    const filter = new ClientMessageFilter(
      () => this.controller === viewerId,
      (x, y) => {
        this.cursor = { x, y }
      },
    )
    this.viewers.set(viewerId, viewer)
    const detach = () => {
      viewer.destroy()
      relay.destroy()
      if (!this.viewers.delete(viewerId)) return
      if (this.controller === viewerId) this.setController(undefined)
    }
    viewer.on('close', detach)
    relay.on('close', detach)
    viewer.on('error', detach)
    relay.on('error', detach)
    accepted(viewerId)
    relay.pipe(viewer)
    viewer.on('data', (chunk: Buffer) => {
      const { forward, failure } = filter.push(chunk)
      for (const bytes of forward) relay.write(bytes)
      if (failure) detach()
    })
    viewer.resume()
  }

  takeover(viewerId: string): void {
    if (!this.viewers.has(viewerId))
      throw new RequestError('not-found', `no viewer ${viewerId} on this screen`)
    this.setController(viewerId)
  }

  giveback(viewerId: string): void {
    if (this.controller !== viewerId)
      throw new RequestError('refused', 'this viewer does not hold the input')
    this.setController(undefined)
  }

  private setController(viewerId: string | undefined): void {
    this.controller = viewerId
    this.owner = viewerId === undefined ? 'agent' : 'human'
    this.log.add(viewerId === undefined ? 'giveback' : 'takeover', {})
    this.events.emit('event', { type: 'owner', id: this.id, owner: this.owner })
  }

  async frame(): Promise<Raster> {
    if (!this.rfb || this.state !== 'running') throw new BackendError('screen is not running')
    return withTimeout(this.rfb.capture(), relayTimeoutMs, 'screenshot')
  }

  pointer(x: number, y: number, buttons: number): void {
    if (!this.rfb || this.state !== 'running') throw new BackendError('screen is not running')
    this.cursor = { x, y }
    this.buttons = buttons
    this.rfb.pointer(x, y, buttons)
  }

  get pressedButtons(): number {
    return this.buttons
  }

  key(keysym: number, down: boolean): void {
    if (!this.rfb || this.state !== 'running') throw new BackendError('screen is not running')
    this.rfb.key(keysym, down)
  }

  private askInit(
    message: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const control = this.control
    if (!control || this.state !== 'running') {
      return Promise.reject(new BackendError('screen is not running'))
    }
    const requestId = this.nextRequestId++
    const answered = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.initWaiters.set(requestId, { resolve, reject })
    })
    writeJsonLine(control, { ...message, requestId })
    return withTimeout(answered, timeoutMs, String(message.type)).finally(() =>
      this.initWaiters.delete(requestId),
    )
  }

  async launch(argv: string[]): Promise<number> {
    const answer = await this.askInit({ type: 'launch', argv }, launchTimeoutMs)
    return Number(answer.pid)
  }

  async run(argv: string[]): Promise<{ code: number; stdout: string }> {
    const answer = await this.askInit({ type: 'run', argv }, launchTimeoutMs)
    return { code: Number(answer.code), stdout: String(answer.stdout ?? '') }
  }

  stop(): Promise<void> {
    this.stopped ??= this.teardown()
    return this.stopped
  }

  private async teardown(): Promise<void> {
    this.state = 'stopping'
    if (this.control) writeJsonLine(this.control, { type: 'stop' })
    if (this.host?.connected) this.host.send({ type: 'stop' })
    const hostGone = await Promise.race([
      this.hostExited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), hostExitTimeoutMs)),
    ])
    if (!hostGone) {
      this.host?.kill('SIGKILL')
      if (this.wrapPid !== undefined) {
        try {
          process.kill(this.wrapPid, 'SIGKILL')
        } catch {}
      }
      await this.hostExited
    }
    for (const waiter of this.initWaiters.values())
      waiter.reject(new BackendError('screen stopped'))
    this.initWaiters.clear()
    this.rfb?.close()
    this.control?.destroy()
    for (const viewer of this.viewers.values()) viewer.destroy()
    for (const server of this.servers) server.close()
    await rm(this.folder, { recursive: true, force: true })
    this.events.emit('event', { type: 'stopped', id: this.id })
    this.onGone(this)
  }
}
