import { once } from 'node:events'
import { connect, type Socket } from 'node:net'
import { join } from 'node:path'
import jpeg from 'jpeg-js'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { isRecord, onJsonLines, writeJsonLine } from '../../src/json-lines.js'
import { createSandbox, decodePng, type Sandbox, waitFor } from './harness.js'

type Created = { ok: boolean; id: string; agentToken: string; viewerToken: string }
type Call = { method: string; params: Record<string, unknown> }
type Answer = { result?: Record<string, unknown>; error?: { code: string; reason?: string } }

type FakePhone = {
  created: Created
  socket: Socket
  calls: Call[]
  answer: (call: Call) => Answer | undefined
  state(state: string, size?: { width: number; height: number }): void
  closed: Promise<void>
}

let sandbox: Sandbox

beforeEach(async () => {
  sandbox = await createSandbox()
  await sandbox.screens(['list'])
})

afterEach(async () => {
  await sandbox.cleanup()
})

function screenJpeg(width: number, height: number): string {
  const data = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4
      data[at] = y < height / 2 ? 250 : 10
      data[at + 1] = 10
      data[at + 2] = y < height / 2 ? 10 : 250
      data[at + 3] = 255
    }
  }
  return Buffer.from(jpeg.encode({ width, height, data }, 90).data).toString('base64')
}

async function openPhone(request: Record<string, unknown> = {}): Promise<FakePhone> {
  const socket = connect(join(sandbox.socketDir, 'daemon.sock'))
  await once(socket, 'connect')
  const closed = once(socket, 'close').then(() => {})
  let resolveCreated: (created: Created) => void = () => {}
  const created = new Promise<Created>((resolve) => {
    resolveCreated = resolve
  })
  const phone = {
    socket,
    calls: [] as Call[],
    answer: (_call: Call): Answer | undefined => ({ result: {} }),
    state(state: string, size = { width: 1080, height: 2400 }) {
      writeJsonLine(socket, { type: 'state', state, ...size })
    },
    closed,
  }
  let first = true
  onJsonLines(socket, (message) => {
    if (!isRecord(message)) return
    if (first) {
      first = false
      resolveCreated(message as Created)
      return
    }
    if (message.type !== 'call') return
    const call = { method: String(message.method), params: message.params as Call['params'] }
    phone.calls.push(call)
    const answer = phone.answer(call)
    if (answer) writeJsonLine(socket, { type: 'reply', call: message.call, ...answer })
  })
  writeJsonLine(socket, {
    verb: 'create',
    backend: 'phone',
    lease: true,
    width: 1080,
    height: 2400,
    label: 'Pixel',
    ...request,
  })
  return Object.assign(phone, { created: await created })
}

function verb(phone: FakePhone, args: string[], json = false) {
  const [name, ...rest] = args
  const flags = ['--token', phone.created.agentToken, ...(json ? ['--json'] : [])]
  return sandbox.screens([name ?? '', phone.created.id, ...flags, ...rest])
}

async function verbJson<T>(phone: FakePhone, args: string[]): Promise<T> {
  const result = await verb(phone, args, true)
  if (result.code !== 0)
    throw new Error(`${args.join(' ')} exited ${result.code}: ${result.stderr}`)
  return JSON.parse(result.stdout.toString()) as T
}

test('PHD-C13 a phone screen answers screenshot and zoom as PNG from the phone capture', async () => {
  const phone = await openPhone()
  expect(phone.created).toMatchObject({ ok: true, id: expect.any(String) })
  phone.answer = (call) =>
    call.method === 'phone.capture'
      ? {
          result: {
            width: 720,
            height: 1600,
            screenWidth: 1080,
            screenHeight: 2400,
            mime: 'image/jpeg',
            data: screenJpeg(720, 1600),
            blocked: false,
          },
        }
      : { result: {} }

  const shot = await verbJson<{ width: number; height: number; png: string }>(phone, [
    'screenshot',
    '--max-side',
    '1200',
  ])
  expect([shot.width, shot.height]).toEqual([540, 1200])
  expect(phone.calls[0]).toEqual({ method: 'phone.capture', params: { maxSide: 1200 } })
  const image = decodePng(Buffer.from(shot.png, 'base64'))
  expect(image.pixel(270, 100)[0]).toBeGreaterThan(200)
  expect(image.pixel(270, 1100)[2]).toBeGreaterThan(200)

  const zoomed = await verbJson<{ png: string }>(phone, ['zoom', '0', '1300', '1080', '2400'])
  const bottom = decodePng(Buffer.from(zoomed.png, 'base64'))
  expect(bottom.pixel(10, 10)[2]).toBeGreaterThan(200)
  expect(phone.calls[1]).toEqual({ method: 'phone.capture', params: { maxSide: 1600 } })

  phone.answer = () => ({
    result: { width: 600, height: 1600, data: screenJpeg(600, 1600), blocked: false },
  })
  const squeezed = await verbJson<{ png: string }>(phone, ['zoom', '0', '1300', '1080', '2400'])
  const lower = decodePng(Buffer.from(squeezed.png, 'base64'))
  expect(lower.pixel(10, 10)[2]).toBeGreaterThan(200)
  expect(lower.pixel(10, 10)[0]).toBeLessThan(60)

  phone.answer = () => ({ result: { width: 10, height: 10, data: 'bm90IGEganBlZw==' } })
  const broken = await verb(phone, ['screenshot'], true)
  expect(broken.code).toBe(5)
})

test('PHD-C14 input verbs become phone requests and the log never holds typed text', async () => {
  const phone = await openPhone()
  await verbJson(phone, ['click', '100', '200'])
  await verbJson(phone, ['click', '100', '200', '--count', '2'])
  await verbJson(phone, ['click', '300', '400', '--down'])
  await new Promise((resolve) => setTimeout(resolve, 600))
  await verbJson(phone, ['click', '--up'])
  await verbJson(phone, ['drag', '10', '20', '30', '40'])
  await verbJson(phone, ['scroll', 'down', '2', '540', '1200'])
  await verbJson(phone, ['type', 'hunter2 secret'])
  await verbJson(phone, ['key', 'Escape Return', '--repeat', '2'])
  await verbJson(phone, ['launch', '--', 'com.android.settings'])

  const longPress = phone.calls[2]
  expect(longPress?.method).toBe('phone.tap')
  expect(longPress?.params).toMatchObject({ x: 300, y: 400 })
  expect(Number(longPress?.params.holdMs)).toBeGreaterThanOrEqual(500)
  expect(phone.calls.filter((call) => call !== longPress)).toEqual([
    { method: 'phone.tap', params: { x: 100, y: 200 } },
    { method: 'phone.tap', params: { x: 100, y: 200, count: 2 } },
    { method: 'phone.swipe', params: { from: [10, 20], to: [30, 40] } },
    { method: 'phone.swipe', params: { from: [540, 1200], to: [540, 720] } },
    { method: 'phone.type', params: { text: 'hunter2 secret' } },
    { method: 'phone.key', params: { key: 'back' } },
    { method: 'phone.key', params: { key: 'enter' } },
    { method: 'phone.key', params: { key: 'back' } },
    { method: 'phone.key', params: { key: 'enter' } },
    { method: 'phone.launch', params: { package: 'com.android.settings' } },
  ])
  const log = await verb(phone, ['log'], true)
  expect(log.stdout.toString()).not.toContain('hunter2')
  expect(log.stdout.toString()).toContain('"length":14')
})

test('PHD-C15 apps and tree read the phone, and other screens answer unsupported', async () => {
  const phone = await openPhone()
  const nodes = [{ id: 'n1', cls: 'Button', text: 'OK', bounds: [0, 0, 10, 10], click: true }]
  phone.answer = (call) => {
    if (call.method === 'phone.apps') {
      return { result: { apps: [{ package: 'com.android.settings', label: 'Settings' }] } }
    }
    return { result: { package: 'com.android.settings', nodes } }
  }
  expect(await verbJson(phone, ['apps'])).toEqual({
    apps: [{ package: 'com.android.settings', label: 'Settings' }],
  })
  expect(await verbJson(phone, ['tree'])).toEqual({ package: 'com.android.settings', nodes })
  const text = await verb(phone, ['apps'])
  expect(text.stdout.toString()).toBe('com.android.settings\tSettings\n')

  const deep = (depth: number): Record<string, unknown> => ({
    id: `n${depth}`,
    cls: 'View',
    bounds: [0, 0, 1, 1],
    ...(depth < 100 ? { kids: [deep(depth + 1)] } : {}),
  })
  phone.answer = (call) =>
    call.method === 'phone.apps'
      ? {
          result: {
            apps: [
              { package: 'com.evil\napp', label: 'x' },
              { package: 'com.chat.app', label: 'Chat\u001b[2J\u202eevil\tname' },
              'not an app',
            ],
          },
        }
      : {
          result: {
            package: '../../etc',
            nodes: [
              { id: 'a', cls: 'Text', text: 'Hi\u0007\u202e', bounds: [0, 0, 2, 2], click: 'yes' },
              { id: 'b', cls: 'Text', bounds: 'nowhere' },
              deep(1),
            ],
          },
        }
  expect(await verbJson(phone, ['apps'])).toEqual({
    apps: [{ package: 'com.chat.app', label: 'Chat [2J evil name' }],
  })
  const tree = await verbJson<{ package: string; nodes: Record<string, unknown>[] }>(phone, [
    'tree',
  ])
  expect(tree.package).toBe('')
  expect(tree.nodes[0]).toEqual({ id: 'a', cls: 'Text', text: 'Hi  ', bounds: [0, 0, 2, 2] })
  expect(tree.nodes).toHaveLength(2)
  let depth = 0
  for (let node = tree.nodes[1]; node; node = (node.kids as Record<string, unknown>[])?.[0]) {
    depth += 1
  }
  expect(depth).toBe(64)
})

test('PHD-C16 while the phone is paused the human owns the input and screenshots still work', async () => {
  const phone = await openPhone()
  phone.state('paused')
  await waitFor(async () => {
    const list = await sandbox.screensJson<{ screens: { owner: string }[] }>(['list'])
    return list.screens[0]?.owner === 'human'
  }, 5_000)
  const refused = await verb(phone, ['click', '1', '1'], true)
  expect(refused.code).toBe(4)
  expect(refused.stdout.toString()).toContain('human-owns-input')
  expect(phone.calls).toEqual([])

  phone.state('running', { width: 2400, height: 1080 })
  await waitFor(async () => {
    const list = await sandbox.screensJson<{ screens: { owner: string; width: number }[] }>([
      'list',
    ])
    return list.screens[0]?.owner === 'agent' && list.screens[0]?.width === 2400
  }, 5_000)
  await verbJson(phone, ['click', '2000', '1000'])
  expect(phone.calls).toEqual([{ method: 'phone.tap', params: { x: 2000, y: 1000 } }])
})

test('PHD-C17 verbs a phone has no counterpart for answer unsupported and viewer verbs are refused', async () => {
  const phone = await openPhone()
  for (const args of [
    ['move', '1', '1'],
    ['cursor'],
    ['windows'],
    ['hold-key', 'Return', '1'],
    ['click', '1', '1', '--button', 'right'],
    ['click', '1', '1', '--count', '3'],
  ]) {
    const result = await verb(phone, args, true)
    expect(result.code, args.join(' ')).toBe(6)
  }
  const viewerToken = ['--token', phone.created.viewerToken, '--json']
  for (const args of [
    ['takeover', phone.created.id, 'v1'],
    ['allow', phone.created.id, 'a.com'],
  ]) {
    const result = await sandbox.screens([...args, ...viewerToken])
    expect(result.code, args[0]).toBe(4)
  }
  expect(phone.calls).toEqual([])
})

test('PHD-C18 the screen ends with its lease, and stop asks the phone to stop first', async () => {
  const phone = await openPhone()
  phone.socket.destroy()
  await waitFor(async () => {
    const list = await sandbox.screensJson<{ screens: unknown[] }>(['list'])
    return list.screens.length === 0
  }, 5_000)

  const second = await openPhone()
  const stopped = await verb(second, ['stop'], true)
  expect(stopped.code).toBe(0)
  expect(second.calls).toEqual([{ method: 'phone.stop', params: {} }])
  await second.closed

  const third = await openPhone()
  third.answer = (call) => (call.method === 'phone.stop' ? undefined : { result: {} })
  const stopping = verb(third, ['stop'], true)
  await waitFor(async () => third.calls.some((call) => call.method === 'phone.stop'), 5_000)
  const list = await sandbox.screensJson<{ screens: { state: string }[] }>(['list'])
  expect(list.screens).toEqual([expect.objectContaining({ state: 'stopping' })])
  const late = await verb(third, ['click', '1', '1'], true)
  expect(late.code).toBe(5)
  expect((await stopping).code).toBe(0)
  expect(third.calls.map((call) => call.method)).toEqual(['phone.stop'])
  await third.closed
})

test('PHD-C19 a phone screen needs a lease and takes no network or runtime', async () => {
  for (const request of [{ lease: false }, { allow: ['example.com'] }, { runtime: 'podman' }]) {
    const phone = await openPhone(request)
    expect(phone.created).toMatchObject({ ok: false, code: 'usage' })
    await phone.closed
  }
})

test('PHD-C20 phone refusals reach the caller with their code', async () => {
  const phone = await openPhone()
  phone.answer = (call) =>
    call.method === 'phone.tap'
      ? { error: { code: 'blocked-app' } }
      : { error: { code: 'not-found' } }
  const blocked = await verb(phone, ['click', '5', '5'], true)
  expect(blocked.code).toBe(4)
  expect(blocked.stdout.toString()).toContain('blocked-app')
  const missing = await verb(phone, ['launch', '--', 'com.example.gone'], true)
  expect(missing.code).toBe(3)

  phone.answer = () => ({ error: { code: 'evil\u001b[2J', reason: 'x\ny' } })
  const odd = await verb(phone, ['click', '5', '5'], true)
  expect(odd.code).toBe(5)
  expect(odd.stdout.toString()).not.toContain('\\u001b')
  expect(odd.stdout.toString()).toContain('failed')
})
