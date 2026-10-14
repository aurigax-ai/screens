import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { type Created, createSandbox, createScreen, type Sandbox, screenDir } from './harness.js'

let sandbox: Sandbox

beforeEach(async () => {
  sandbox = await createSandbox()
})

afterEach(async () => {
  await sandbox.cleanup()
})

type Listed = { screens: { id: string; state: string }[] }
type Log = { entries: unknown[] }

function screenVerbs(home: string): string[][] {
  return [
    ['screenshot'],
    ['zoom', '0', '0', '10', '10'],
    ['click', '10', '10'],
    ['move', '10', '10'],
    ['drag', '1', '1', '20', '20'],
    ['scroll', 'down', '1'],
    ['type', 'x'],
    ['key', 'Return'],
    ['hold-key', 'shift', '0'],
    ['cursor'],
    ['launch', '--', 'touch', join(home, 'should-not-exist')],
    ['windows'],
    ['focus', '1'],
    ['log'],
    ['stop'],
  ]
}

function withId(verb: string[], id: string): string[] {
  const [name, ...rest] = verb
  return [name ?? '', id, ...rest]
}

test('SCR-C13 list without a token shows id, size, label and state and no token', async () => {
  const screen = await createScreen(sandbox, ['--label', 'review bot', '--width', '1024'])
  const text = await sandbox.screens(['list'])
  expect(text.code).toBe(0)
  const json = await sandbox.screensJson<{ screens: Record<string, unknown>[] }>(['list'])
  expect(json.screens).toHaveLength(1)
  expect(json.screens[0]).toMatchObject({
    id: screen.id,
    width: 1024,
    height: 800,
    label: 'review bot',
    owner: 'agent',
    state: 'running',
  })
  for (const entry of json.screens) {
    for (const [key, value] of Object.entries(entry)) {
      expect(key.toLowerCase()).not.toContain('token')
      expect(value).not.toBe(screen.agentToken)
      expect(value).not.toBe(screen.viewerToken)
    }
  }
  expect(text.stdout.toString().toLowerCase()).not.toContain('token')
  for (const output of [text.stdout.toString(), JSON.stringify(json)]) {
    expect(output).toContain(screen.id)
    expect(output).not.toContain(screen.agentToken)
    expect(output).not.toContain(screen.viewerToken)
  }
  expect(text.stdout.toString()).toContain('1024x800')
  expect(text.stdout.toString()).toContain('review bot')
})

test("SCR-C14 screen A's token does nothing to screen B", async () => {
  const first = await createScreen(sandbox)
  const second = await createScreen(sandbox)
  const home = join(screenDir(sandbox, second.id), 'screen', 'home')
  for (const verb of screenVerbs(home)) {
    for (const token of [first.agentToken, first.viewerToken]) {
      const result = await sandbox.screens([...withId(verb, second.id), '--token', token])
      expect(result.code, `${verb[0]}: ${result.stderr}`).toBe(4)
    }
  }
  expect(existsSync(join(home, 'should-not-exist'))).toBe(false)
  const log = await sandbox.screensJson<Log>(['log', second.id, '--token', second.agentToken])
  expect(log.entries).toEqual([])
  const list = await sandbox.screensJson<Listed>(['list'])
  expect(list.screens.find((entry) => entry.id === second.id)?.state).toBe('running')
})

test('SCR-C15 a verb with no token or a wrong one exits 4 and does nothing', async () => {
  const screen = await createScreen(sandbox)
  const home = join(screenDir(sandbox, screen.id), 'screen', 'home')
  const wrong = `${screen.agentToken.slice(0, -1)}${screen.agentToken.endsWith('0') ? '1' : '0'}`
  for (const verb of screenVerbs(home)) {
    const missing = await sandbox.screens(withId(verb, screen.id))
    expect(missing.code, `${verb[0]} without token: ${missing.stderr}`).toBe(4)
    const bad = await sandbox.screens([...withId(verb, screen.id), '--token', wrong])
    expect(bad.code, `${verb[0]} with a wrong token: ${bad.stderr}`).toBe(4)
    const fromEnvironment = await sandbox.screens(withId(verb, screen.id), {
      env: { SCREENS_TOKEN: wrong },
    })
    expect(fromEnvironment.code, `${verb[0]} with a wrong SCREENS_TOKEN`).toBe(4)
  }
  const events = await sandbox.screens(['events', screen.id, '--token', wrong])
  expect(events.code).toBe(4)
  expect(existsSync(join(home, 'should-not-exist'))).toBe(false)
  const log = await sandbox.screensJson<Log>(['log', screen.id], {
    env: { SCREENS_TOKEN: screen.agentToken },
  })
  expect(log.entries).toEqual([])
  const list = await sandbox.screensJson<Listed>(['list'])
  expect(list.screens.map((entry) => entry.id)).toEqual([screen.id])
})

test('SCR-C31 an unknown verb or a missing argument exits 2 with usage and never reaches the daemon', async () => {
  const calls = [
    ['frobnicate'],
    ['click'],
    ['click', 'abcd1234', '10'],
    ['zoom', 'abcd1234', '1', '2', '3'],
    ['move', 'abcd1234', 'x', '1'],
    ['drag', 'abcd1234', '1', '2', '3'],
    ['scroll', 'abcd1234', 'sideways', '3'],
    ['scroll', 'abcd1234', 'down'],
    ['type', 'abcd1234'],
    ['key', 'abcd1234'],
    ['key', 'abcd1234', 'NoSuchKeyName'],
    ['hold-key', 'abcd1234', 'shift'],
    ['hold-key', 'abcd1234', 'shift', '301'],
    ['launch', 'abcd1234'],
    ['focus', 'abcd1234'],
    ['create', '--width', 'wide'],
    ['click', 'abcd1234', '1', '1', '--button', 'fourth'],
    ['list', '--no-such-flag'],
    ['mcp'],
    ['daemon', 'restart'],
  ]
  for (const call of calls) {
    const result = await sandbox.screens(call, { env: { SCREENS_TOKEN: 'a'.repeat(64) } })
    expect(result.code, call.join(' ')).toBe(2)
    expect(result.stderr, call.join(' ')).toMatch(/usage: screens/)
  }
  expect(existsSync(sandbox.socketDir)).toBe(false)
  expect(await readdir(sandbox.runtimeDir)).toEqual([])
})

test('SCR-C32 a screen id that does not exist exits 3 for every screen verb', async () => {
  const screen: Created = await createScreen(sandbox)
  const home = join(screenDir(sandbox, screen.id), 'screen', 'home')
  const missing = screen.id === '00000000' ? '00000001' : '00000000'
  for (const verb of screenVerbs(home)) {
    const result = await sandbox.screens([...withId(verb, missing), '--token', screen.agentToken])
    expect(result.code, `${verb[0]}: ${result.stderr}`).toBe(3)
  }
  const events = await sandbox.screens(['events', missing, '--token', screen.agentToken])
  expect(events.code).toBe(3)
})
