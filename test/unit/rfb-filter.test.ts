import { expect, test } from 'vitest'
import { ClientMessageFilter } from '../../src/rfb-filter.js'

const handshake = Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([1]), Buffer.from([1])])
const pointer = Buffer.from([5, 1, 0, 10, 0, 20])
const key = Buffer.from([4, 1, 0, 0, 0, 0, 0xff, 0x0d])
const request = Buffer.from([3, 0, 0, 0, 0, 0, 0, 16, 0, 16])
const cutText = Buffer.concat([Buffer.from([6, 0, 0, 0, 0, 0, 0, 2]), Buffer.from('hi')])
const desktopSize = Buffer.concat([Buffer.from([251, 0, 0, 64, 0, 64, 1, 0]), Buffer.alloc(16)])

function filtered(owner: boolean, ...chunks: Buffer[]) {
  const pointers: number[][] = []
  const filter = new ClientMessageFilter(
    () => owner,
    (x, y) => pointers.push([x, y]),
  )
  const forward: Buffer[] = []
  let failure: string | undefined
  for (const chunk of chunks) {
    const result = filter.push(chunk)
    forward.push(...result.forward)
    failure ??= result.failure
  }
  return { bytes: Buffer.concat(forward), pointers, failure }
}

test('the handshake and non-input messages always pass', () => {
  const { bytes } = filtered(false, handshake, request)
  expect(bytes).toEqual(Buffer.concat([handshake, request]))
})

test('input passes only for the viewer that holds the input', () => {
  const dropped = filtered(false, handshake, pointer, key, cutText, request)
  expect(dropped.bytes).toEqual(Buffer.concat([handshake, request]))
  expect(dropped.pointers).toEqual([])
  const kept = filtered(true, handshake, pointer, key, cutText)
  expect(kept.bytes).toEqual(Buffer.concat([handshake, pointer, key, cutText]))
  expect(kept.pointers).toEqual([[10, 20]])
})

test('messages split across chunks are reassembled and resizes are always dropped', () => {
  const stream = Buffer.concat([handshake, desktopSize, pointer, request])
  const chunks = [...stream].map((byte) => Buffer.from([byte]))
  const { bytes, failure } = filtered(true, ...chunks)
  expect(failure).toBeUndefined()
  expect(bytes).toEqual(Buffer.concat([handshake, pointer, request]))
})

test('an unknown message type or a non-RFB client fails the viewer', () => {
  expect(filtered(true, handshake, Buffer.from([99, 0])).failure).toMatch(/unsupported/)
  expect(filtered(true, Buffer.from('GET / HTTP/1.1\r\n')).failure).toMatch(/not an RFB client/)
})
