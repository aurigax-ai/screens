import type { Socket } from 'node:net'
import { PassThrough } from 'node:stream'
import { afterEach, expect, test, vi } from 'vitest'
import { BackendError } from '../../src/backend.js'
import { PhoneScreen } from '../../src/phone-screen.js'

afterEach(() => {
  vi.useRealTimers()
})

function leaseWithPhone() {
  const toPhone = new PassThrough()
  const lease = new PassThrough() as unknown as Socket
  const written: Record<string, unknown>[] = []
  ;(lease as unknown as PassThrough).write = ((chunk: string) => {
    for (const line of String(chunk).split('\n').filter(Boolean)) written.push(JSON.parse(line))
    return true
  }) as PassThrough['write']
  const reply = (message: Record<string, unknown>) =>
    (lease as unknown as PassThrough).emit('data', `${JSON.stringify(message)}\n`)
  return { lease, toPhone, written, reply }
}

test('PHD-C26 a call the phone leaves unanswered for 80 s fails clearly and a late answer is dropped', async () => {
  vi.useFakeTimers()
  const { lease, written, reply } = leaseWithPhone()
  const screen = new PhoneScreen(
    { id: 'p1', width: 1080, height: 2400, label: '' },
    lease,
    () => {},
  )
  screen.start()
  const tap = screen.call('phone.tap', { x: 1, y: 2 })
  const failed = tap.catch((error: unknown) => error)
  expect(written).toEqual([{ type: 'call', call: 1, method: 'phone.tap', params: { x: 1, y: 2 } }])

  await vi.advanceTimersByTimeAsync(79_999)
  let settled = false
  void failed.then(() => {
    settled = true
  })
  await Promise.resolve()
  expect(settled).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  const error = await failed
  expect(error).toBeInstanceOf(BackendError)
  expect((error as Error).message).toBe('phone.tap timed out')

  reply({ type: 'reply', call: 1, result: { late: true } })
  const next = screen.call('phone.apps', {})
  reply({ type: 'reply', call: 2, result: { apps: [] } })
  expect(await next).toEqual({ apps: [] })
  const stopping = screen.stop()
  reply({ type: 'reply', call: 3, result: {} })
  await stopping
  expect(written.map((message) => message.method)).toEqual([
    'phone.tap',
    'phone.apps',
    'phone.stop',
  ])
})
