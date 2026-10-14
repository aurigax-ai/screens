import type { Duplex } from 'node:stream'

type Waiter = { size: number; resolve: (bytes: Buffer) => void; reject: (error: Error) => void }

export class ByteReader {
  private buffered: Buffer[] = []
  private bufferedLength = 0
  private waiters: Waiter[] = []
  private failure: Error | undefined

  constructor(stream: Duplex) {
    stream.on('data', (chunk: Buffer) => {
      this.buffered.push(chunk)
      this.bufferedLength += chunk.length
      this.pump()
    })
    stream.on('close', () => this.fail(new Error('connection closed')))
    stream.on('error', (error) => this.fail(error))
  }

  read(size: number): Promise<Buffer> {
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      this.waiters.push({ size, resolve, reject })
      this.pump()
    })
  }

  async readUInt8(): Promise<number> {
    return (await this.read(1)).readUInt8(0)
  }

  async readUInt16(): Promise<number> {
    return (await this.read(2)).readUInt16BE(0)
  }

  async readUInt32(): Promise<number> {
    return (await this.read(4)).readUInt32BE(0)
  }

  private pump(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters[0]
      if (!waiter || this.bufferedLength < waiter.size) return
      this.waiters.shift()
      const first = this.buffered[0] ?? Buffer.alloc(0)
      const source = first.length >= waiter.size ? first : Buffer.concat(this.buffered)
      waiter.resolve(source.subarray(0, waiter.size))
      const rest = source.subarray(waiter.size)
      if (source === first) {
        this.buffered.shift()
        if (rest.length > 0) this.buffered.unshift(rest)
      } else {
        this.buffered = rest.length > 0 ? [rest] : []
      }
      this.bufferedLength -= waiter.size
    }
  }

  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }
}
