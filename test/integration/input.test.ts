import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  type Created,
  createSandbox,
  createScreen,
  type EchoServer,
  openEchoPage,
  type Sandbox,
  startEchoServer,
} from './harness.js'

let sandbox: Sandbox
let echo: EchoServer

beforeEach(async () => {
  sandbox = await createSandbox()
  echo = await startEchoServer()
})

afterEach(async () => {
  echo.close()
  await sandbox.cleanup()
})

async function agent(screen: Created, verb: string, ...args: string[]) {
  const result = await sandbox.screens([verb, screen.id, ...args, '--token', screen.agentToken])
  expect(result.code, `${verb} ${args.join(' ')}: ${result.stderr}`).toBe(0)
}

test('SCR-C12 clicks, typing and keys land on a test page at the right coordinates', async () => {
  const screen = await createScreen(sandbox, ['--allow', 'localhost'])
  await openEchoPage(sandbox, screen, echo, 1280, 800)

  await agent(screen, 'click', '300', '200')
  await echo.waitForEvent((event) => event.type === 'click' && event.x === 300 && event.y === 200)

  await agent(screen, 'click', '640', '500', '--button', 'right')
  await echo.waitForEvent(
    (event) => event.type === 'contextmenu' && event.x === 640 && event.y === 500,
  )

  await agent(screen, 'click', '700', '520', '--count', '2')
  await echo.waitForEvent(
    (event) => event.type === 'click' && event.x === 700 && event.detail === 2,
  )

  await agent(screen, 'click', '710', '530', '--modifiers', 'shift')
  await echo.waitForEvent(
    (event) => event.type === 'click' && event.x === 710 && event.shift === true,
  )

  await agent(screen, 'move', '900', '600')
  await echo.waitForEvent(
    (event) => event.type === 'mousemove' && event.x === 900 && event.y === 600,
  )

  await agent(screen, 'drag', '820', '300', '880', '360')
  await echo.waitForEvent(
    (event) => event.type === 'mousedown' && event.x === 820 && event.y === 300,
  )
  await echo.waitForEvent((event) => event.type === 'mouseup' && event.x === 880 && event.y === 360)

  await agent(screen, 'scroll', 'down', '3', '600', '400')
  await echo.waitForEvent(
    (event) => event.type === 'wheel' && event.x === 600 && Number(event.dy) > 0,
  )

  await agent(screen, 'click', '250', '120')
  await agent(screen, 'type', 'Hello, World! 123')
  await echo.waitForEvent((event) => event.type === 'input' && event.value === 'Hello, World! 123')

  await agent(screen, 'key', 'ctrl+a')
  await echo.waitForEvent(
    (event) => event.type === 'keydown' && event.key === 'a' && event.ctrl === true,
  )
  await agent(screen, 'key', 'BackSpace')
  await echo.waitForEvent((event) => event.type === 'input' && event.value === '')

  await agent(screen, 'key', 'Return', '--repeat', '2')
  await echo.waitForEvent(
    () =>
      echo.events.filter((event) => event.type === 'keydown' && event.key === 'Enter').length === 2,
  )

  const cursor = await sandbox.screensJson<{ x: number; y: number }>([
    'cursor',
    screen.id,
    '--token',
    screen.agentToken,
  ])
  expect(cursor).toEqual({ x: 250, y: 120 })
})
