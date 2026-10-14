import { duplexPair } from 'node:stream'
import { expect, test } from 'vitest'
import { ByteReader } from '../../src/byte-reader.js'
import { encodePng } from '../../src/png.js'
import { RfbClient } from '../../src/rfb-client.js'
import { decodePng } from '../integration/harness.js'

function serverInit(width: number, height: number, name: string): Buffer {
  const init = Buffer.alloc(24)
  init.writeUInt16BE(width, 0)
  init.writeUInt16BE(height, 2)
  init[4] = 32
  init[5] = 24
  init[7] = 1
  init.writeUInt16BE(255, 8)
  init.writeUInt16BE(255, 10)
  init.writeUInt16BE(255, 12)
  init[14] = 16
  init[15] = 8
  init[16] = 0
  init.writeUInt32BE(name.length, 20)
  return Buffer.concat([init, Buffer.from(name)])
}

function rawUpdate(x: number, y: number, width: number, height: number, rgbx: number[]): Buffer {
  const header = Buffer.alloc(16)
  header[0] = 0
  header.writeUInt16BE(1, 2)
  header.writeUInt16BE(x, 4)
  header.writeUInt16BE(y, 6)
  header.writeUInt16BE(width, 8)
  header.writeUInt16BE(height, 10)
  header.writeInt32BE(0, 12)
  return Buffer.concat([header, Buffer.from(rgbx)])
}

async function handshake() {
  const [clientSide, serverSide] = duplexPair()
  const fromClient = new ByteReader(serverSide)
  serverSide.write('RFB 003.008\n')
  const connecting = RfbClient.connect(clientSide)
  expect((await fromClient.read(12)).toString()).toBe('RFB 003.008\n')
  serverSide.write(Buffer.from([2, 2, 1]))
  expect(await fromClient.readUInt8()).toBe(1)
  serverSide.write(Buffer.from([0, 0, 0, 0]))
  expect(await fromClient.readUInt8()).toBe(1)
  serverSide.write(serverInit(2, 2, 'screen'))
  const client = await connecting
  const pixelFormat = await fromClient.read(20)
  expect(pixelFormat[0]).toBe(0)
  expect([pixelFormat[4], pixelFormat[14], pixelFormat[15], pixelFormat[16]]).toEqual([
    32, 0, 8, 16,
  ])
  const encodings = await fromClient.read(8)
  expect(encodings[0]).toBe(2)
  expect(encodings.readInt32BE(4)).toBe(0)
  return { client, serverSide, fromClient }
}

test('the RFB client negotiates security None and a 32-bit RGBX pixel format', async () => {
  const { client } = await handshake()
  expect([client.width, client.height, client.name]).toEqual([2, 2, 'screen'])
  client.close()
})

test('capture asks for a full update and assembles raw rectangles', async () => {
  const { client, serverSide, fromClient } = await handshake()
  const frame = client.capture()
  const request = await fromClient.read(10)
  expect([request[0], request[1], request.readUInt16BE(6), request.readUInt16BE(8)]).toEqual([
    3, 0, 2, 2,
  ])
  serverSide.write(Buffer.from([2]))
  serverSide.write(rawUpdate(1, 1, 1, 1, [10, 20, 30, 0]))
  const { rgbx } = await frame
  expect([...rgbx.subarray(12, 15)]).toEqual([10, 20, 30])
  expect([...rgbx.subarray(0, 3)]).toEqual([0, 0, 0])
  client.close()
})

test('pointer and key events are encoded as RFB client messages', async () => {
  const { client, fromClient } = await handshake()
  client.pointer(1, 5, 1)
  expect([...(await fromClient.read(6))]).toEqual([5, 1, 0, 1, 0, 1])
  client.key(0xff0d, true)
  expect([...(await fromClient.read(8))]).toEqual([4, 1, 0, 0, 0, 0, 0xff, 0x0d])
  client.close()
})

test('a refused connection reports the server reason', async () => {
  const [clientSide, serverSide] = duplexPair()
  serverSide.write('RFB 003.008\n')
  const reason = Buffer.from('too many')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(reason.length)
  serverSide.write(Buffer.concat([Buffer.from([0]), length, reason]))
  await expect(RfbClient.connect(clientSide)).rejects.toThrow('too many')
})

test('encodePng writes an RGB PNG of the frame', async () => {
  const rgbx = Buffer.from([255, 0, 0, 0, 0, 255, 0, 0, 0, 0, 255, 0, 9, 9, 9, 0])
  const image = decodePng(await encodePng(2, 2, rgbx))
  expect([image.width, image.height]).toEqual([2, 2])
  expect(image.pixel(0, 0)).toEqual([255, 0, 0])
  expect(image.pixel(1, 1)).toEqual([9, 9, 9])
})
