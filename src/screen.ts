import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { ActionLog } from './action-log.js'
import { BackendError, type ScreenBackend, withTimeout } from './backend.js'
import type { Raster } from './image.js'
import { RequestError } from './protocol.js'
import { RfbClient } from './rfb-client.js'
import { ClientMessageFilter } from './rfb-filter.js'

export { BackendError } from './backend.js'

export type ScreenSummary = {
  id: string
  width: number
  height: number
  label: string
  owner: 'agent' | 'human'
  state: 'starting' | 'running' | 'stopping'
  backend: string
  runtime?: string
}

const startTimeoutMs = 60_000
const relayTimeoutMs = 5_000
const launchTimeoutMs = 10_000
const domainAnswerTimeoutMs = 60_000

export function newToken(): string {
  return randomBytes(32).toString('hex')
}

export function newScreenId(): string {
  return randomBytes(4).toString('hex')
}

export type ScreenOptions = { id: string; width: number; height: number; label: string }

export class Screen {
  readonly id: string
  readonly agentToken = newToken()
  readonly viewerToken = newToken()
  owner: 'agent' | 'human' = 'agent'
  state: ScreenSummary['state'] = 'starting'
  readonly log = new ActionLog()
  readonly events = new EventEmitter()
  cursor: { x: number; y: number }
  private readyWaiter: (() => void) | undefined
  private goneWaiter: ((reason: string) => void) | undefined
  private rfb: RfbClient | undefined
  private nextRequestId = 1
  private initWaiters = new Map<
    number,
    { resolve: (message: Record<string, unknown>) => void; reject: (error: Error) => void }
  >()
  private buttons = 0
  private viewers = new Map<string, Socket>()
  private networkAnswers = new Map<string, boolean>()
  private pendingAsks = new Map<
    string,
    { decided: Promise<boolean>; settle: (allow: boolean) => void; timer: NodeJS.Timeout }
  >()
  private controller: string | undefined
  private stopped: Promise<void> | undefined

  constructor(
    private readonly options: ScreenOptions,
    private readonly backend: ScreenBackend,
    private readonly onGone: (screen: Screen) => void,
  ) {
    this.id = options.id
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
      backend: this.backend.name,
      ...(this.backend.runtime ? { runtime: this.backend.runtime } : {}),
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
    const gone = new Promise<never>((_resolve, reject) => {
      this.goneWaiter = (reason) => reject(new BackendError(reason))
    })
    gone.catch(() => {})
    const ready = new Promise<void>((resolve) => {
      this.readyWaiter = resolve
    })
    await Promise.race([
      this.backend.start({
        message: (message) => this.handleInitMessage(message),
        ask: (host, port) => this.askNetwork(host, port),
        gone: (reason) => {
          this.goneWaiter?.(reason)
          void this.stop()
        },
      }),
      gone,
    ])
    await Promise.race([ready, gone])
    this.rfb = await Promise.race([this.openRfb(), gone])
  }

  private handleInitMessage(message: Record<string, unknown>): void {
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

  private async openRfb(): Promise<RfbClient> {
    const relay = await this.backend.openRelay()
    const client = await withTimeout(RfbClient.connect(relay), relayTimeoutMs, 'RFB handshake')
    void client.closed.then(() => void this.stop())
    return client
  }

  async attachViewer(viewer: Socket, accepted: (viewerId: string) => void): Promise<void> {
    if (this.state !== 'running') throw new BackendError('screen is not running')
    const relay = await this.backend.openRelay()
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

  askNetwork(hostName: string, port: number | undefined): Promise<boolean> {
    const name = hostName.toLowerCase()
    const known = this.networkAnswers.get(name)
    if (known !== undefined) return Promise.resolve(known)
    const pending = this.pendingAsks.get(name)
    if (pending) return pending.decided
    let settle: (allow: boolean) => void = () => {}
    const decided = new Promise<boolean>((resolve) => {
      settle = resolve
    })
    const timer = setTimeout(() => this.answerNetwork(name, false), domainAnswerTimeoutMs)
    this.pendingAsks.set(name, { decided, settle, timer })
    this.log.add('domain-request', { host: name, port })
    this.events.emit('event', { type: 'domain-request', id: this.id, host: name, port })
    return decided
  }

  answerNetwork(hostName: string, allow: boolean): void {
    const name = hostName.toLowerCase()
    this.networkAnswers.set(name, allow)
    const pending = this.pendingAsks.get(name)
    if (pending) {
      clearTimeout(pending.timer)
      this.pendingAsks.delete(name)
      pending.settle(allow)
    }
    this.log.add(allow ? 'allow' : 'deny', { host: name })
    this.events.emit('event', { type: 'domain-answer', id: this.id, host: name, allow })
  }

  takeover(viewerId: string): void {
    if (!this.viewers.has(viewerId)) {
      throw new RequestError('not-found', `no viewer ${viewerId} on this screen`)
    }
    this.setController(viewerId)
  }

  giveback(viewerId: string): void {
    if (this.controller !== viewerId) {
      throw new RequestError('refused', 'this viewer does not hold the input')
    }
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
    if (this.state !== 'running') return Promise.reject(new BackendError('screen is not running'))
    const requestId = this.nextRequestId++
    const answered = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.initWaiters.set(requestId, { resolve, reject })
    })
    this.backend.send({ ...message, requestId })
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
    this.backend.send({ type: 'stop' })
    await this.backend.stop()
    for (const waiter of this.initWaiters.values()) {
      waiter.reject(new BackendError('screen stopped'))
    }
    this.initWaiters.clear()
    this.rfb?.close()
    for (const pending of this.pendingAsks.values()) {
      clearTimeout(pending.timer)
      pending.settle(false)
    }
    this.pendingAsks.clear()
    this.networkAnswers.clear()
    for (const viewer of this.viewers.values()) viewer.destroy()
    this.events.emit('event', { type: 'stopped', id: this.id })
    this.onGone(this)
  }
}
