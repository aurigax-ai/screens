import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  type Created,
  closeTo,
  createSandbox,
  createScreen,
  type EventStream,
  launch,
  type Sandbox,
  screenshot,
  startInScreen,
  subscribeEvents,
  waitFor,
} from './harness.js'

let sandbox: Sandbox
let server: Server
let port: number
const paths: string[] = []
const streams: EventStream[] = []

beforeEach(async () => {
  sandbox = await createSandbox()
  paths.length = 0
  server = createServer((request, response) => {
    paths.push(request.url ?? '')
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><body style="margin:0;background:#ff00ff;height:100vh"></body>')
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  port = (server.address() as AddressInfo).port
})

afterEach(async () => {
  for (const stream of streams.splice(0)) stream.close()
  server.close()
  await sandbox.cleanup()
})

function events(screen: Created): EventStream {
  const stream = subscribeEvents(sandbox, screen)
  streams.push(stream)
  return stream
}

function fetchInScreen(screen: Created, url: string) {
  return startInScreen(
    sandbox,
    screen,
    'curl -s --noproxy "" -x "$HTTP_PROXY" -m 85 -o /dev/null -w "status=%{http_code}" "$1"',
    [url],
  )
}

function answer(screen: Created, verb: 'allow' | 'deny', host: string) {
  return sandbox.screens([verb, screen.id, host, '--token', screen.viewerToken])
}

const unlisted = '127.0.0.1'

test('SCR-C22 a listed host loads and an unlisted host waits for an answer and loads after an allow', async () => {
  const screen = await createScreen(sandbox, ['--allow', 'localhost'])
  const stream = events(screen)
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 300))
  expect(
    (await launch(sandbox, screen, ['google-chrome-stable', `http://localhost:${port}/listed`]))
      .code,
  ).toBe(0)
  await waitFor(
    async () => {
      const image = await screenshot(sandbox, screen)
      return closeTo(image.pixel(320, 600), [255, 0, 255])
    },
    20_000,
    250,
  )
  expect(paths).toContain('/listed')

  expect(
    (await launch(sandbox, screen, ['google-chrome-stable', `http://${unlisted}:${port}/unlisted`]))
      .code,
  ).toBe(0)
  await stream.waitFor((event) => event.type === 'domain-request' && event.host === unlisted)
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000))
  expect(paths).not.toContain('/unlisted')
  expect((await answer(screen, 'allow', unlisted)).code).toBe(0)
  await waitFor(async () => paths.includes('/unlisted'), 15_000)
})

test('SCR-C23 an unanswered host is refused after 60 s and refused at once the next time', async () => {
  const screen = await createScreen(sandbox)
  const stream = events(screen)
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 300))
  const started = Date.now()
  const first = await fetchInScreen(screen, `http://${unlisted}:${port}/first`).finished()
  const waited = Date.now() - started
  expect(waited).toBeGreaterThanOrEqual(59_000)
  expect(first).not.toContain('status=200')
  expect(paths).toEqual([])
  expect(stream.events.filter((event) => event.type === 'domain-request')).toHaveLength(1)

  const again = Date.now()
  const second = await fetchInScreen(screen, `http://${unlisted}:${port}/second`).finished()
  expect(Date.now() - again).toBeLessThan(5_000)
  expect(second).not.toContain('status=200')
  expect(paths).toEqual([])
  expect(stream.events.filter((event) => event.type === 'domain-request')).toHaveLength(1)
}, 120_000)

test('SCR-C24 an allow holds for its screen only and is gone after stop', async () => {
  const first = await createScreen(sandbox)
  const second = await createScreen(sandbox)
  const firstEvents = events(first)
  const secondEvents = events(second)
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 300))

  const firstFetch = fetchInScreen(first, `http://${unlisted}:${port}/a`)
  await firstEvents.waitFor((event) => event.type === 'domain-request' && event.host === unlisted)
  expect((await answer(first, 'allow', unlisted)).code).toBe(0)
  expect(await firstFetch.finished()).toContain('status=200')

  const secondFetch = fetchInScreen(second, `http://${unlisted}:${port}/b`)
  await secondEvents.waitFor((event) => event.type === 'domain-request' && event.host === unlisted)
  expect((await answer(second, 'deny', unlisted)).code).toBe(0)
  expect(await secondFetch.finished()).not.toContain('status=200')
  expect(paths).toEqual(['/a'])

  expect((await sandbox.screens(['stop', first.id, '--token', first.agentToken])).code).toBe(0)
  const renewed = await createScreen(sandbox)
  const renewedEvents = events(renewed)
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 300))
  const renewedFetch = fetchInScreen(renewed, `http://${unlisted}:${port}/c`)
  await renewedEvents.waitFor((event) => event.type === 'domain-request' && event.host === unlisted)
  expect((await answer(renewed, 'deny', unlisted)).code).toBe(0)
  expect(await renewedFetch.finished()).not.toContain('status=200')
  expect(paths).toEqual(['/a'])
})

test('answers need the viewer token', async () => {
  const screen = await createScreen(sandbox)
  const result = await sandbox.screens(['allow', screen.id, unlisted, '--token', screen.agentToken])
  expect(result.code).toBe(4)
})
