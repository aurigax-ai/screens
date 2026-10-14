import { randomBytes } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createSandbox, createScreen, daemonRequest, type Sandbox } from './harness.js'

let sandbox: Sandbox

beforeEach(async () => {
  sandbox = await createSandbox()
})

afterEach(async () => {
  await sandbox.cleanup()
})

async function filesUnder(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

test('SCR-C29 the log lists a click with coordinates and a type of the canary length and the canary nowhere', async () => {
  const canary = Array.from(randomBytes(16), (byte) => String.fromCharCode(97 + (byte % 26))).join(
    '',
  )
  const screen = await createScreen(sandbox)
  const token = ['--token', screen.agentToken]
  expect((await sandbox.screens(['type', screen.id, canary, ...token])).code).toBe(0)
  expect((await sandbox.screens(['click', screen.id, '120', '80', ...token])).code).toBe(0)
  const json = await sandbox.screensJson<{ entries: Record<string, unknown>[] }>([
    'log',
    screen.id,
    ...token,
  ])
  expect(json.entries.map(({ time: _time, ...entry }) => entry)).toEqual([
    { verb: 'type', length: 16 },
    { verb: 'click', x: 120, y: 80, button: 'left', count: 1 },
  ])
  const text = await sandbox.screens(['log', screen.id, ...token])
  expect(text.stdout.toString()).toContain('click')
  for (const output of [JSON.stringify(json), text.stdout.toString(), text.stderr]) {
    expect(output).not.toContain(canary)
  }
  for (const file of await filesUnder(sandbox.root)) {
    const content = await readFile(file).catch(() => Buffer.alloc(0))
    expect(content.includes(canary), file).toBe(false)
  }
})

test('SCR-C30 after 600 actions the log holds the newest 500', async () => {
  const screen = await createScreen(sandbox)
  for (let index = 0; index < 600; index++) {
    const reply = await daemonRequest(sandbox, {
      verb: 'move',
      id: screen.id,
      token: screen.agentToken,
      to: [index, 10],
    })
    expect(reply.ok).toBe(true)
  }
  const log = await sandbox.screensJson<{ entries: { verb: string; x: number }[] }>([
    'log',
    screen.id,
    '--token',
    screen.agentToken,
  ])
  expect(log.entries).toHaveLength(500)
  expect(log.entries[0]?.x).toBe(100)
  expect(log.entries[499]?.x).toBe(599)
})
