import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { ActionLog } from './action-log.js'
import { BackendError } from './backend.js'
import { isRecord, onJsonLines, writeJsonLine } from './json-lines.js'
import { RequestError } from './protocol.js'
import { newToken, type ScreenOptions, type ScreenSummary } from './screen.js'

const callTimeoutMs = 80_000
const stopTimeoutMs = 4_000
const maximumSide = 8192

type Call = {
  resolve: (result: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

function phoneFailure(code: string, reason: unknown): Error {
  if (code === 'paused') return new RequestError('refused', 'human-owns-input')
  if (code === 'not-found') return new RequestError('not-found', 'no such app on the phone')
  if (code === 'bad-params') return new RequestError('usage', 'the phone refused the arguments')
  if (['timeout', 'link-ended', 'failed', 'unknown-link'].includes(code)) {
    return new BackendError(`the phone did not answer: ${code}`)
  }
  return new RequestError('refused', typeof reason === 'string' ? `${code}: ${reason}` : code)
}

function side(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= maximumSide
}

export class PhoneScreen {
  readonly id: string
  readonly agentToken = newToken()
  readonly viewerToken = newToken()
  owner: 'agent' | 'human' = 'agent'
  state: ScreenSummary['state'] = 'running'
  readonly log = new ActionLog()
  readonly events = new EventEmitter()
  cursor: { x: number; y: number }
  held: { x: number; y: number; since: number } | undefined
  private size: { width: number; height: number }
  private nextCall = 1
  private calls = new Map<number, Call>()
  private stopped: Promise<void> | undefined

  constructor(
    private readonly options: ScreenOptions,
    private readonly lease: Socket,
    private readonly onGone: (screen: PhoneScreen) => void,
  ) {
    this.id = options.id
    this.size = { width: options.width, height: options.height }
    this.cursor = { x: Math.floor(options.width / 2), y: Math.floor(options.height / 2) }
  }

  get width(): number {
    return this.size.width
  }

  get height(): number {
    return this.size.height
  }

  start(): void {
    onJsonLines(this.lease, (message) => this.receive(message))
    this.lease.once('close', () => void this.stop())
    this.lease.resume()
  }

  summary(): ScreenSummary {
    return {
      id: this.id,
      width: this.size.width,
      height: this.size.height,
      label: this.options.label,
      owner: this.owner,
      state: this.state,
      backend: 'phone',
    }
  }

  call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.state !== 'running') return Promise.reject(new BackendError('screen is not running'))
    const call = this.nextCall++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(call)
        reject(new BackendError(`${method} timed out`))
      }, callTimeoutMs)
      this.calls.set(call, { resolve, reject, timer })
      writeJsonLine(this.lease, { type: 'call', call, method, params })
    })
  }

  private receive(message: unknown): void {
    if (!isRecord(message)) return
    if (message.type === 'reply') this.settle(message)
    else if (message.type === 'state') this.changeState(message)
  }

  private settle(message: Record<string, unknown>): void {
    const id = typeof message.call === 'number' ? message.call : -1
    const pending = this.calls.get(id)
    if (!pending) return
    this.calls.delete(id)
    clearTimeout(pending.timer)
    if (isRecord(message.error)) {
      const code = typeof message.error.code === 'string' ? message.error.code : 'failed'
      pending.reject(phoneFailure(code, message.error.reason))
      return
    }
    pending.resolve(isRecord(message.result) ? message.result : {})
  }

  private changeState(message: Record<string, unknown>): void {
    if (side(message.width) && side(message.height)) {
      this.size = { width: message.width, height: message.height }
    }
    if (message.state === 'stopped') {
      void this.stop()
      return
    }
    const owner = message.state === 'paused' ? 'human' : 'agent'
    if (owner === this.owner) return
    this.owner = owner
    this.log.add(owner === 'human' ? 'paused' : 'resumed', {})
    this.events.emit('event', { type: 'owner', id: this.id, owner })
  }

  stop(): Promise<void> {
    this.stopped ??= this.teardown()
    return this.stopped
  }

  private async teardown(): Promise<void> {
    if (this.lease.writable) {
      const asked = this.call('phone.stop', {}).catch(() => ({}))
      await Promise.race([asked, new Promise((resolve) => setTimeout(resolve, stopTimeoutMs))])
    }
    this.state = 'stopping'
    for (const pending of this.calls.values()) {
      clearTimeout(pending.timer)
      pending.reject(new BackendError('screen stopped'))
    }
    this.calls.clear()
    this.lease.end()
    this.events.emit('event', { type: 'stopped', id: this.id })
    this.onGone(this)
  }
}
