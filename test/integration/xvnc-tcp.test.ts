import { afterEach, beforeEach, expect, test } from 'vitest'
import { createSandbox, createScreen, runInScreen, type Sandbox } from './harness.js'

let sandbox: Sandbox

beforeEach(async () => {
  sandbox = await createSandbox()
})

afterEach(async () => {
  await sandbox.cleanup()
})

test('Xvnc listens on no TCP port inside a screen', async () => {
  const screen = await createScreen(sandbox)
  const output = await runInScreen(
    sandbox,
    screen,
    [
      'for table in /proc/net/tcp /proc/net/tcp6; do',
      '  tail -n +2 "$table" | while read -r _ local _ state _; do',
      '    [ "$state" = "0A" ] && echo $((16#$(echo "$local" | cut -d: -f2)))',
      '  done',
      'done',
    ].join('\n'),
  )
  const ports = output.split('\n').filter(Boolean).map(Number)
  expect(ports.filter((port) => port >= 5900 && port < 6000)).toEqual([])
})
