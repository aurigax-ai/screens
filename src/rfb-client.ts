import type { Duplex } from 'node:stream'
import { ByteReader } from './byte-reader.js'

export type Frame = { width: number; height: number; rgbx: Buffer }

const securityNone = 1
const encodingRaw = 0
const bytesPerPixel = 4

export class RfbClient {
  readonly width: number
  readonly height: number
  readonly name: string
  private readonly framebuffer: Buffer
  private frameWaiters: { resolve: (frame: Frame) => void; reject: (error: Error) => void }[] = []
  private failure: Error | undefined

  private constructor(
    private readonly stream: Duplex,
    private readonly reader: ByteReader,
    width: number,
    height: number,
    name: string,
  ) {
    this.width = width
    this.height = height
    this.name = name
    this.framebuffer = Buffer.alloc(width * height * bytesPerPixel)
  }

  static async connect(stream: Duplex): Promise<RfbClient> {
    const reader = new ByteReader(stream)
    const version = (await reader.read(12)).toString('latin1')
    if (!version.startsWith('RFB 003.')) throw new Error(`not an RFB server: ${version.trim()}`)
    stream.write('RFB 003.008\n')
    const typeCount = await reader.readUInt8()
    if (typeCount === 0) {
      const reason = await reader.read(await reader.readUInt32())
      throw new Error(`RFB server refused: ${reason.toString()}`)
    }
    const types = [...(await reader.read(typeCount))]
    if (!types.includes(securityNone)) throw new Error(`no supported RFB security type: ${types}`)
    stream.write(Buffer.from([securityNone]))
    if ((await reader.readUInt32()) !== 0) {
      const reason = await reader.read(await reader.readUInt32())
      throw new Error(`RFB security failed: ${reason.toString()}`)
    }
    stream.write(Buffer.from([1]))
    const init = await reader.read(24)
    const width = init.readUInt16BE(0)
    const height = init.readUInt16BE(2)
    const name = (await reader.read(init.readUInt32BE(20))).toString('utf8')
    stream.write(setPixelFormatMessage())
    stream.write(setEncodingsMessage([encodingRaw]))
    const client = new RfbClient(stream, reader, width, height, name)
    client.receive().catch((error: Error) => client.fail(error))
    return client
  }

  capture(): Promise<Frame> {
    if (this.failure) return Promise.reject(this.failure)
    const frame = new Promise<Frame>((resolve, reject) => {
      this.frameWaiters.push({ resolve, reject })
    })
    this.requestUpdate(false)
    return frame
  }

  pointer(x: number, y: number, buttonMask: number): void {
    const message = Buffer.alloc(6)
    message[0] = 5
    message[1] = buttonMask
    message.writeUInt16BE(clamp(x, this.width), 2)
    message.writeUInt16BE(clamp(y, this.height), 4)
    this.stream.write(message)
  }

  key(keysym: number, down: boolean): void {
    const message = Buffer.alloc(8)
    message[0] = 4
    message[1] = down ? 1 : 0
    message.writeUInt32BE(keysym, 4)
    this.stream.write(message)
  }

  close(): void {
    this.stream.destroy()
  }

  get closed(): Promise<void> {
    return new Promise((resolve) => {
      if (this.stream.destroyed) resolve()
      else this.stream.once('close', () => resolve())
    })
  }

  private requestUpdate(incremental: boolean): void {
    const message = Buffer.alloc(10)
    message[0] = 3
    message[1] = incremental ? 1 : 0
    message.writeUInt16BE(this.width, 6)
    message.writeUInt16BE(this.height, 8)
    this.stream.write(message)
  }

  private async receive(): Promise<void> {
    for (;;) {
      const type = await this.reader.readUInt8()
      if (type === 0) await this.receiveFramebufferUpdate()
      else if (type === 1) {
        await this.reader.read(3)
        await this.reader.read((await this.reader.readUInt16()) * 6)
      } else if (type === 2) continue
      else if (type === 3) {
        await this.reader.read(3)
        await this.reader.read(await this.reader.readUInt32())
      } else throw new Error(`unknown RFB server message ${type}`)
    }
  }

  private async receiveFramebufferUpdate(): Promise<void> {
    await this.reader.read(1)
    const rectangles = await this.reader.readUInt16()
    for (let index = 0; index < rectangles; index++) {
      const header = await this.reader.read(12)
      const x = header.readUInt16BE(0)
      const y = header.readUInt16BE(2)
      const width = header.readUInt16BE(4)
      const height = header.readUInt16BE(6)
      const encoding = header.readInt32BE(8)
      if (encoding !== encodingRaw) throw new Error(`unexpected RFB encoding ${encoding}`)
      const pixels = await this.reader.read(width * height * bytesPerPixel)
      for (let row = 0; row < height; row++) {
        if (y + row >= this.height) break
        const visible = Math.min(width, this.width - x) * bytesPerPixel
        pixels.copy(
          this.framebuffer,
          ((y + row) * this.width + x) * bytesPerPixel,
          row * width * bytesPerPixel,
          row * width * bytesPerPixel + visible,
        )
      }
    }
    const frame = { width: this.width, height: this.height, rgbx: Buffer.from(this.framebuffer) }
    for (const waiter of this.frameWaiters.splice(0)) waiter.resolve(frame)
  }

  private fail(error: Error): void {
    this.failure = error
    for (const waiter of this.frameWaiters.splice(0)) waiter.reject(error)
    this.stream.destroy()
  }
}

function clamp(value: number, limit: number): number {
  return Math.max(0, Math.min(limit - 1, Math.round(value)))
}

function setPixelFormatMessage(): Buffer {
  const message = Buffer.alloc(20)
  message[0] = 0
  message[4] = 32
  message[5] = 24
  message[6] = 0
  message[7] = 1
  message.writeUInt16BE(255, 8)
  message.writeUInt16BE(255, 10)
  message.writeUInt16BE(255, 12)
  message[14] = 0
  message[15] = 8
  message[16] = 16
  return message
}

function setEncodingsMessage(encodings: number[]): Buffer {
  const message = Buffer.alloc(4 + encodings.length * 4)
  message[0] = 2
  message.writeUInt16BE(encodings.length, 2)
  encodings.forEach((encoding, index) => {
    message.writeInt32BE(encoding, 4 + index * 4)
  })
  return message
}
