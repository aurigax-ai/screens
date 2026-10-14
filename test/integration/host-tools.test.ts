import { execFile } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'

const run = promisify(execFile)

test('bubblewrap can create an unprivileged user and network namespace', async () => {
  const { stdout } = await run('bwrap', [
    '--unshare-user',
    '--unshare-net',
    '--ro-bind',
    '/',
    '/',
    '--',
    'echo',
    'inside',
  ])
  expect(stdout.trim()).toBe('inside')
})

async function isExecutableOnPath(program: string): Promise<boolean> {
  for (const folder of (process.env.PATH ?? '').split(delimiter)) {
    try {
      await access(join(folder, program), constants.X_OK)
      return true
    } catch {}
  }
  return false
}

test.each([
  'Xvnc',
  'xdotool',
  'socat',
  'dbus-run-session',
  'google-chrome-stable',
])('%s is installed', async (program) => {
  expect(await isExecutableOnPath(program)).toBe(true)
})

test('the built cli prints its version', async () => {
  const { stdout } = await run(process.execPath, ['dist/cli.js', '--version'])
  expect(stdout.trim()).toBe('0.0.0')
})
