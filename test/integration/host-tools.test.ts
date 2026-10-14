import { execFile } from 'node:child_process'
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

test.each([
  ['Xvnc', ['-version']],
  ['xdotool', ['version']],
  ['socat', ['-V']],
  ['google-chrome-stable', ['--version']],
])('%s is installed', async (program, args) => {
  await expect(run(program, args)).resolves.toBeDefined()
})

test('the built cli prints its version', async () => {
  const { stdout } = await run(process.execPath, ['dist/cli.js', '--version'])
  expect(stdout.trim()).toBe('0.0.0')
})
