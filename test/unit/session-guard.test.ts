import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { SessionEnvError, startInSession } from '../../src/session-guard.js'

let folder: string

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'screens-guard-'))
  await mkdir(join(folder, 'run'))
})

afterEach(async () => {
  await rm(folder, { recursive: true, force: true })
})

function screenEnvironment(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, DISPLAY: ':1', XDG_RUNTIME_DIR: join(folder, 'run') }
}

const userRuntime = `/run/user/${process.getuid?.() ?? 0}`

test.each([
  ['DISPLAY', { DISPLAY: ':0' }],
  ['WAYLAND_DISPLAY', { WAYLAND_DISPLAY: 'wayland-0' }],
  ['DBUS_SESSION_BUS_ADDRESS', { DBUS_SESSION_BUS_ADDRESS: `unix:path=${userRuntime}/bus` }],
  ['XDG_RUNTIME_DIR', { XDG_RUNTIME_DIR: userRuntime }],
])(
  'SCR-C37 the launch helper refuses %s pointing at the user session and starts nothing',
  async (variable, override) => {
    const marker = join(folder, 'started')
    const start = () =>
      startInSession('touch', [marker], {
        env: { ...screenEnvironment(), ...override },
        session: { folder, display: ':1' },
        stdio: 'ignore',
      })
    expect(start).toThrow(SessionEnvError)
    try {
      start()
    } catch (error) {
      expect((error as SessionEnvError).code).toBe('session-env')
      expect((error as SessionEnvError).variable).toBe(variable)
      expect((error as Error).message).toContain(variable)
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300))
    expect(existsSync(marker)).toBe(false)
  },
)

test('the launch helper starts a program whose environment stays inside the screen', async () => {
  const marker = join(folder, 'started')
  const child = startInSession('touch', [marker], {
    env: {
      ...screenEnvironment(),
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(folder, 'run', 'bus')},guid=0`,
    },
    session: { folder, display: ':1' },
    stdio: 'ignore',
  })
  await new Promise((resolveExit) => child.on('exit', resolveExit))
  expect(existsSync(marker)).toBe(true)
})

test('the launch helper refuses a runtime dir that only shares a prefix with the screen folder', () => {
  expect(() =>
    startInSession('true', [], {
      env: { ...screenEnvironment(), XDG_RUNTIME_DIR: `${folder}-elsewhere/run` },
      session: { folder, display: ':1' },
    }),
  ).toThrow(SessionEnvError)
})
