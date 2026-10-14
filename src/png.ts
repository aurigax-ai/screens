import { promisify } from 'node:util'
import { crc32, deflate } from 'node:zlib'

const deflateAsync = promisify(deflate)
const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
  return Buffer.concat([head, body, crc])
}

export async function encodePng(width: number, height: number, rgbx: Buffer): Promise<Buffer> {
  const stride = width * 3 + 1
  const raw = Buffer.alloc(stride * height)
  for (let row = 0; row < height; row++) {
    const line = row * stride
    raw[line] = 0
    for (let column = 0; column < width; column++) {
      const source = (row * width + column) * 4
      const target = line + 1 + column * 3
      raw[target] = rgbx[source] ?? 0
      raw[target + 1] = rgbx[source + 1] ?? 0
      raw[target + 2] = rgbx[source + 2] ?? 0
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([
    signature,
    chunk('IHDR', header),
    chunk('IDAT', await deflateAsync(raw, { level: 3 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
