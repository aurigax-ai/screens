import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  cliPath,
  createSandbox,
  createScreen,
  processesMentioning,
  type Sandbox,
  screenDir,
  testBackend,
  waitFor,
} from './harness.js'

let sandbox: Sandbox

beforeEach(async () => {
  sandbox = await createSandbox()
})

afterEach(async () => {
  await sandbox.cleanup()
})

test('SCR-C38 a leased screen stops when its creating client is SIGKILLed and an unleased one keeps running', async () => {
  const unleased = await createScreen(sandbox)
  const client = spawn(
    process.execPath,
    [cliPath, 'create', '--lease', '--json', '--backend', testBackend],
    {
      env: sandbox.env,
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  )
  const leased = await new Promise<{ id: string }>((resolveCreated, reject) => {
    let output = ''
    client.stdout.setEncoding('utf8')
    client.stdout.on('data', (chunk: string) => {
      output += chunk
      if (output.includes('\n')) resolveCreated(JSON.parse(output.slice(0, output.indexOf('\n'))))
    })
    client.on('exit', (code) => reject(new Error(`create --lease exited ${code}`)))
  })
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000))
  expect(client.exitCode).toBe(null)
  const folder = screenDir(sandbox, leased.id)
  expect(existsSync(folder)).toBe(true)

  const killed = Date.now()
  client.kill('SIGKILL')
  await waitFor(async () => {
    const list = await sandbox.screensJson<{ screens: { id: string }[] }>(['list'])
    return !list.screens.some((screen) => screen.id === leased.id)
  }, 5_000)
  expect(Date.now() - killed).toBeLessThan(5_000)
  expect(existsSync(folder)).toBe(false)
  expect(await processesMentioning(folder)).toEqual([])

  const list = await sandbox.screensJson<{ screens: { id: string; state: string }[] }>(['list'])
  expect(list.screens).toEqual([expect.objectContaining({ id: unleased.id, state: 'running' })])
})
