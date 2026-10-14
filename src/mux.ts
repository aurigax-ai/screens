import { EventEmitter } from 'node:events'
import { Duplex, type Readable, type Writable } from 'node:stream'

export enum FrameType {
  Open = 1,
  Data = 2,
  Close = 3,
}

const headerBytes = 9
const maximumPayloadBytes = 1024 * 1024
const controlChannel = 0

export function encodeFrame(channel: number, type: FrameType, payload: Buffer): Buffer {
  const header = Buffer.alloc(headerBytes)
  header.writeUInt32BE(channel, 0)
  header[4] = type
  header.writeUInt32BE(payload.length, 5)
  return Buffer.concat([header, payload])
}

class MuxChannel extends Duplex {
  private closeSent = false
  private remoteEnded = false

  constructor(
    readonly id: number,
    private readonly send: (type: FrameType, payload: Buffer) => void,
    private readonly forget: () => void,
  ) {
    super()
  }

  override _read(): void {}

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    for (let offset = 0; offset < chunk.length; offset += maximumPayloadBytes) {
      this.send(FrameType.Data, chunk.subarray(offset, offset + maximumPayloadBytes))
    }
    callback()
  }

  override _final(callback: () => void): void {
    this.sendClose()
    callback()
  }

  override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    this.sendClose()
    this.forget()
    callback(error)
  }

  private sendClose(): void {
    if (this.closeSent) return
    this.closeSent = true
    this.send(FrameType.Close, Buffer.alloc(0))
  }

  receive(payload: Buffer): void {
    if (!this.remoteEnded) this.push(payload)
  }

  remoteClosed(): void {
    if (this.remoteEnded) return
    this.remoteEnded = true
    this.push(null)
    if (!this.writableEnded) this.end()
  }
}

export type MuxOptions = { side: 'daemon' | 'screen'; acceptKinds: string[] }

type MuxEvents = { channel: [channel: Duplex, kind: string]; failure: [reason: string] }

export class Mux extends EventEmitter<MuxEvents> {
  readonly control: Duplex
  private readonly channels = new Map<number, MuxChannel>()
  private nextChannel: number
  private pending: Buffer = Buffer.alloc(0)
  private failed = false

  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly options: MuxOptions,
  ) {
    super()
    this.nextChannel = options.side === 'daemon' ? 2 : 1
    this.control = this.channel(controlChannel)
    input.on('data', (chunk: Buffer) => this.receive(chunk))
    input.on('end', () => this.closeAll())
    input.on('close', () => this.closeAll())
  }

  open(kind: string): Duplex {
    const id = this.nextChannel
    this.nextChannel += 2
    const channel = this.channel(id)
    this.write(id, FrameType.Open, Buffer.from(kind, 'utf8'))
    return channel
  }

  private channel(id: number): MuxChannel {
    const channel = new MuxChannel(
      id,
      (type, payload) => this.write(id, type, payload),
      () => this.channels.delete(id),
    )
    this.channels.set(id, channel)
    return channel
  }

  private write(channel: number, type: FrameType, payload: Buffer): void {
    if (!this.failed && this.output.writable) this.output.write(encodeFrame(channel, type, payload))
  }

  private isRemoteId(id: number): boolean {
    return id !== controlChannel && id % 2 === (this.options.side === 'daemon' ? 1 : 0)
  }

  private fail(reason: string): void {
    if (this.failed) return
    this.failed = true
    this.closeAll()
    this.emit('failure', reason)
  }

  private closeAll(): void {
    for (const channel of [...this.channels.values()]) channel.destroy()
    this.channels.clear()
  }

  private receive(chunk: Buffer): void {
    if (this.failed) return
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk])
    while (this.pending.length >= headerBytes) {
      const id = this.pending.readUInt32BE(0)
      const type = this.pending[4]
      const length = this.pending.readUInt32BE(5)
      if (length > maximumPayloadBytes) {
        this.fail('frame too large')
        return
      }
      if (type !== FrameType.Open && type !== FrameType.Data && type !== FrameType.Close) {
        this.fail(`unknown frame type ${type}`)
        return
      }
      if (this.pending.length < headerBytes + length) return
      const payload = this.pending.subarray(headerBytes, headerBytes + length)
      this.pending = this.pending.subarray(headerBytes + length)
      if (type === FrameType.Open) {
        if (!this.isRemoteId(id) || this.channels.has(id)) {
          this.fail(`channel ${id} cannot be opened from the other side`)
          return
        }
        const kind = payload.toString('utf8')
        if (!this.options.acceptKinds.includes(kind)) {
          this.fail(`a ${kind} channel is not allowed from the other side`)
          return
        }
        this.emit('channel', this.channel(id), kind)
      } else if (type === FrameType.Data) {
        this.channels.get(id)?.receive(Buffer.from(payload))
      } else {
        this.channels.get(id)?.remoteClosed()
      }
    }
  }
}
