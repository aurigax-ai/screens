import { duplexPair, PassThrough } from 'node:stream'
import { expect, test } from 'vitest'
import { encodeFrame, FrameType, Mux } from '../../src/mux.js'

function connectedPair() {
  const [left, right] = duplexPair()
  const daemon = new Mux(left, left, { side: 'daemon', acceptKinds: ['proxy'] })
  const screen = new Mux(right, right, { side: 'screen', acceptKinds: ['rfb'] })
  return { daemon, screen }
}

function read(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => {
    let text = ''
    stream.on('data', (chunk: Buffer) => {
      text += chunk.toString()
    })
    stream.on('end', () => resolve(text))
  })
}

test('the control channel carries data both ways', async () => {
  const { daemon, screen } = connectedPair()
  const received = new Promise<string>((resolve) =>
    screen.control.once('data', (chunk: Buffer) => resolve(chunk.toString())),
  )
  daemon.control.write('hello\n')
  expect(await received).toBe('hello\n')
})

test('a channel opened by one side arrives on the other with its kind and ends on close', async () => {
  const { daemon, screen } = connectedPair()
  const opened = new Promise<{ kind: string; text: Promise<string> }>((resolve) =>
    screen.on('channel', (channel, kind) => resolve({ kind, text: read(channel) })),
  )
  const channel = daemon.open('rfb')
  channel.end(Buffer.alloc(3 * 1024 * 1024, 'a'))
  const { kind, text } = await opened
  expect(kind).toBe('rfb')
  expect((await text).length).toBe(3 * 1024 * 1024)
})

test('a channel kind the receiving side does not accept fails the stream', async () => {
  const { daemon, screen } = connectedPair()
  const failure = new Promise<string>((resolve) => daemon.on('failure', resolve))
  screen.open('rfb')
  expect(await failure).toMatch(/not allowed/)
})

test('a malformed frame fails the stream', async () => {
  const input = new PassThrough()
  const mux = new Mux(input, new PassThrough(), { side: 'daemon', acceptKinds: ['proxy'] })
  const failure = new Promise<string>((resolve) => mux.on('failure', resolve))
  input.write(encodeFrame(0, 9 as FrameType, Buffer.alloc(0)))
  expect(await failure).toMatch(/frame type/)
})

test('an oversized frame and a channel id of the wrong side fail the stream', async () => {
  const oversized = new PassThrough()
  const first = new Mux(oversized, new PassThrough(), { side: 'daemon', acceptKinds: ['proxy'] })
  const tooBig = new Promise<string>((resolve) => first.on('failure', resolve))
  const header = Buffer.alloc(9)
  header.writeUInt32BE(0, 0)
  header[4] = FrameType.Data
  header.writeUInt32BE(64 * 1024 * 1024, 5)
  oversized.write(header)
  expect(await tooBig).toMatch(/too large/)

  const wrongSide = new PassThrough()
  const second = new Mux(wrongSide, new PassThrough(), { side: 'daemon', acceptKinds: ['proxy'] })
  const wrong = new Promise<string>((resolve) => second.on('failure', resolve))
  wrongSide.write(encodeFrame(2, FrameType.Open, Buffer.from('proxy')))
  expect(await wrong).toMatch(/channel/)
})
