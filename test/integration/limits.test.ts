import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  cliPath,
  closeTo,
  createSandbox,
  createScreen,
  launch,
  processesMentioning,
  type Sandbox,
  screenDir,
  screenshot,
  waitFor,
} from './harness.js'

let sandbox: Sandbox

beforeEach(async () => {
  sandbox = await createSandbox()
})

afterEach(async () => {
  await sandbox.cleanup()
})

async function writeConfig(content: string): Promise<void> {
  await mkdir(join(sandbox.configHome, 'screens'), { recursive: true })
  await writeFile(join(sandbox.configHome, 'screens', 'config.json'), content)
}

test('SCR-C25 one screen over maxScreens exits 4 limit and nothing starts', async () => {
  await writeConfig(JSON.stringify({ maxScreens: 2 }))
  await createScreen(sandbox)
  await createScreen(sandbox)
  const before = await readdir(sandbox.stateDir)
  const third = await sandbox.screens(['create'])
  expect(third.code).toBe(4)
  expect(third.stderr).toContain('limit')
  expect(await readdir(sandbox.stateDir)).toEqual(before)
  const list = await sandbox.screensJson<{ screens: unknown[] }>(['list'])
  expect(list.screens).toHaveLength(2)
})

test('SCR-C26 stop ends every process of a screen with Chrome within 5 s and removes its folder', async () => {
  const screen = await createScreen(sandbox)
  const folder = screenDir(sandbox, screen.id)
  const page = `data:text/html,${encodeURIComponent(
    '<body style="margin:0;background:#ff00ff;height:100vh">',
  )}`
  expect((await launch(sandbox, screen, ['google-chrome-stable', page])).code).toBe(0)
  await waitFor(
    async () => {
      const image = await screenshot(sandbox, screen)
      return closeTo(image.pixel(320, 600), [255, 0, 255])
    },
    20_000,
    250,
  )
  expect((await processesMentioning(folder)).length).toBeGreaterThan(3)
  const started = Date.now()
  const stopped = await sandbox.screens(['stop', screen.id, '--token', screen.agentToken])
  expect(stopped.code).toBe(0)
  expect(await processesMentioning(folder)).toEqual([])
  expect(existsSync(folder)).toBe(false)
  expect(Date.now() - started).toBeLessThan(5_000)
})

test('SCR-C27 a process that ignores SIGTERM is killed when stop runs', async () => {
  const screen = await createScreen(sandbox)
  const folder = screenDir(sandbox, screen.id)
  expect(
    (
      await launch(sandbox, screen, [
        'bash',
        '-c',
        'trap "" TERM; touch "$HOME/stubborn"; sleep 1000',
      ])
    ).code,
  ).toBe(0)
  await waitFor(async () => existsSync(join(folder, 'screen', 'home', 'stubborn')), 10_000)
  const started = Date.now()
  const stopped = await sandbox.screens(['stop', screen.id, '--token', screen.agentToken])
  const elapsed = Date.now() - started
  expect(stopped.code).toBe(0)
  expect(await processesMentioning(folder)).toEqual([])
  expect(existsSync(folder)).toBe(false)
  expect(elapsed).toBeGreaterThanOrEqual(3_500)
  expect(elapsed).toBeLessThan(6_000)
})

test.each([['0'], ['99'], ['"many"']])(
  'SCR-C28 a maxScreens of %s falls back to the default and says so on stderr',
  async (value) => {
    await writeConfig(`{ "maxScreens": ${value} }`)
    const daemon = spawn(process.execPath, [cliPath, 'daemon', 'run'], {
      env: sandbox.env,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    daemon.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    await waitFor(async () => existsSync(join(sandbox.socketDir, 'daemon.sock')), 5_000)
    const status = await sandbox.screensJson<{ maxScreens: number }>(['daemon', 'status'])
    expect(status.maxScreens).toBe(4)
    expect(stderr).toContain('maxScreens')
    expect(stderr).toContain('4')
    expect((await sandbox.screens(['daemon', 'stop'])).code).toBe(0)
  },
)
