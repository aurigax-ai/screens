import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  type Created,
  createSandbox,
  createScreen,
  type EchoServer,
  openEchoPage,
  openViewer,
  type Sandbox,
  startEchoServer,
  type Viewer,
} from './harness.js'

let sandbox: Sandbox
let echo: EchoServer
const viewers: Viewer[] = []

beforeEach(async () => {
  sandbox = await createSandbox()
  echo = await startEchoServer()
})

afterEach(async () => {
  for (const viewer of viewers.splice(0)) viewer.close()
  echo.close()
  await sandbox.cleanup()
})

async function screenWithPage(): Promise<Created> {
  const screen = await createScreen(sandbox, ['--allow', 'localhost'])
  await openEchoPage(sandbox, screen, echo, 1280, 800)
  return screen
}

async function viewer(screen: Created): Promise<Viewer> {
  const opened = await openViewer(sandbox, screen, screen.viewerToken)
  viewers.push(opened)
  return opened
}

function agentClick(screen: Created, x: number, y: number) {
  return sandbox.screens(['click', screen.id, String(x), String(y), '--token', screen.agentToken])
}

function owner(screen: Created, verb: 'takeover' | 'giveback', viewerId: string, token: string) {
  return sandbox.screens([verb, screen.id, viewerId, '--token', token])
}

function clicksAt(x: number, y: number): number {
  return echo.events.filter((event) => event.type === 'click' && event.x === x && event.y === y)
    .length
}

async function settle(): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 800))
}

async function ownerOf(screen: Created): Promise<string | undefined> {
  const list = await sandbox.screensJson<{ screens: { id: string; owner: string }[] }>(['list'])
  return list.screens.find((entry) => entry.id === screen.id)?.owner
}

test('SCR-C19 after take-over the agent click answers human-owns-input and after give-back it lands', async () => {
  const screen = await screenWithPage()
  const human = await viewer(screen)
  expect((await owner(screen, 'takeover', human.id, screen.viewerToken)).code).toBe(0)
  expect(await ownerOf(screen)).toBe('human')

  const refused = await agentClick(screen, 300, 200)
  expect(refused.code).toBe(4)
  expect(refused.stderr).toContain('human-owns-input')
  for (const verb of [
    ['type', screen.id, 'x'],
    ['key', screen.id, 'Return'],
    ['move', screen.id, '5', '5'],
    ['scroll', screen.id, 'down', '1'],
  ]) {
    const result = await sandbox.screens([...verb, '--token', screen.agentToken])
    expect(result.code, verb[0]).toBe(4)
  }
  await settle()
  expect(clicksAt(300, 200)).toBe(0)
  expect(echo.events.some((event) => event.type === 'keydown')).toBe(false)
  const screenshot = await sandbox.screens(['screenshot', screen.id, '--token', screen.agentToken])
  expect(screenshot.code).toBe(0)

  expect((await owner(screen, 'giveback', human.id, screen.viewerToken)).code).toBe(0)
  expect(await ownerOf(screen)).toBe('agent')
  expect((await agentClick(screen, 300, 200)).code).toBe(0)
  await echo.waitForEvent((event) => event.type === 'click' && event.x === 300 && event.y === 200)
})

test('SCR-C20 an agent token cannot take over and the owner stays agent', async () => {
  const screen = await createScreen(sandbox)
  const human = await viewer(screen)
  const takeover = await owner(screen, 'takeover', human.id, screen.agentToken)
  expect(takeover.code).toBe(4)
  expect(await ownerOf(screen)).toBe('agent')
  await expect(openViewer(sandbox, screen, screen.agentToken)).rejects.toMatchObject({
    code: 'refused',
  })
  expect(await ownerOf(screen)).toBe('agent')
})

test('SCR-C21 viewer pointer and key events are dropped while the agent owns input', async () => {
  const screen = await screenWithPage()
  const human = await viewer(screen)
  await human.click(420, 240)
  human.rfb.key(0xff0d, true)
  human.rfb.key(0xff0d, false)
  await settle()
  expect(clicksAt(420, 240)).toBe(0)
  expect(echo.events.some((event) => event.type === 'keydown')).toBe(false)
  const frame = await human.rfb.capture()
  expect([frame.width, frame.height]).toEqual([1280, 800])
  expect((await agentClick(screen, 420, 240)).code).toBe(0)
  await echo.waitForEvent((event) => event.type === 'click' && event.x === 420 && event.y === 240)
})

test('SCR-C35 with two viewers and an agent input follows the owner and no viewer connection breaks', async () => {
  const screen = await screenWithPage()
  const first = await viewer(screen)
  const second = await viewer(screen)

  expect((await owner(screen, 'takeover', first.id, screen.viewerToken)).code).toBe(0)
  expect((await agentClick(screen, 500, 300)).code).toBe(4)
  await first.click(510, 310)
  await second.click(520, 320)
  await echo.waitForEvent((event) => event.type === 'click' && event.x === 510 && event.y === 310)
  await settle()
  expect(clicksAt(500, 300)).toBe(0)
  expect(clicksAt(520, 320)).toBe(0)

  expect((await owner(screen, 'giveback', second.id, screen.viewerToken)).code).toBe(4)
  expect(await ownerOf(screen)).toBe('human')
  expect((await owner(screen, 'giveback', first.id, screen.viewerToken)).code).toBe(0)

  expect((await agentClick(screen, 530, 330)).code).toBe(0)
  await first.click(540, 340)
  await echo.waitForEvent((event) => event.type === 'click' && event.x === 530 && event.y === 330)
  await settle()
  expect(clicksAt(540, 340)).toBe(0)

  for (const each of [first, second]) {
    expect(each.socket.destroyed).toBe(false)
    const frame = await each.rfb.capture()
    expect(frame.width).toBe(1280)
  }
})
