export type FilterResult = { forward: Buffer[]; failure?: string }

const maximumMessageBytes = 1024 * 1024

const setPixelFormat = 0
const setEncodings = 2
const framebufferUpdateRequest = 3
const keyEvent = 4
const pointerEvent = 5
const clientCutText = 6
const enableContinuousUpdates = 150
const clientFence = 248
const xvp = 250
const setDesktopSize = 251
const qemu = 255
const qemuExtendedKeyEvent = 0

type Kind = 'pass' | 'input' | 'drop'

function messageShape(buffer: Buffer): { length: number; kind: Kind } | undefined | 'unknown' {
  const type = buffer[0]
  const need = (length: number, kind: Kind) =>
    buffer.length >= length ? { length, kind } : undefined
  switch (type) {
    case setPixelFormat:
      return need(20, 'pass')
    case setEncodings:
      return buffer.length < 4 ? undefined : need(4 + 4 * buffer.readUInt16BE(2), 'pass')
    case framebufferUpdateRequest:
      return need(10, 'pass')
    case keyEvent:
      return need(8, 'input')
    case pointerEvent:
      return need(6, 'input')
    case clientCutText:
      return buffer.length < 8 ? undefined : need(8 + buffer.readUInt32BE(4), 'input')
    case enableContinuousUpdates:
      return need(10, 'pass')
    case clientFence:
      return buffer.length < 9 ? undefined : need(9 + (buffer[8] ?? 0), 'pass')
    case xvp:
      return need(4, 'drop')
    case setDesktopSize:
      return buffer.length < 8 ? undefined : need(8 + 16 * (buffer[6] ?? 0), 'drop')
    case qemu:
      if (buffer.length < 2) return undefined
      return buffer[1] === qemuExtendedKeyEvent ? need(12, 'input') : 'unknown'
    default:
      return 'unknown'
  }
}

export class ClientMessageFilter {
  private buffer = Buffer.alloc(0)
  private handshakeBytes: number | undefined

  constructor(
    private readonly mayInput: () => boolean,
    private readonly onPointer: (x: number, y: number) => void,
  ) {}

  push(chunk: Buffer): FilterResult {
    this.buffer = Buffer.concat([this.buffer, chunk])
    const forward: Buffer[] = []
    if (this.handshakeBytes === undefined) {
      if (this.buffer.length < 12) return { forward }
      const version = this.buffer.subarray(0, 12).toString('latin1')
      if (!version.startsWith('RFB 003.')) return { forward, failure: 'not an RFB client' }
      this.handshakeBytes = version.startsWith('RFB 003.003') ? 13 : 14
    }
    if (this.handshakeBytes > 0) {
      const take = Math.min(this.handshakeBytes, this.buffer.length)
      forward.push(this.buffer.subarray(0, take))
      this.buffer = this.buffer.subarray(take)
      this.handshakeBytes -= take
      if (this.handshakeBytes > 0) return { forward }
    }
    while (this.buffer.length > 0) {
      const shape = messageShape(this.buffer)
      if (shape === 'unknown') {
        return { forward, failure: `unsupported RFB client message ${this.buffer[0]}` }
      }
      if (shape === undefined) {
        if (this.buffer.length > maximumMessageBytes) {
          return { forward, failure: 'RFB client message too large' }
        }
        return { forward }
      }
      const message = this.buffer.subarray(0, shape.length)
      this.buffer = this.buffer.subarray(shape.length)
      if (shape.kind === 'pass') forward.push(message)
      if (shape.kind === 'input' && this.mayInput()) {
        if (message[0] === pointerEvent)
          this.onPointer(message.readUInt16BE(2), message.readUInt16BE(4))
        forward.push(message)
      }
    }
    return { forward }
  }
}
