import { expect, test } from 'vitest'
import { packageRoot, runNode } from './harness.js'
import { ociTestNamePattern } from './oci-scope.js'

test('CON-C1 the SCR integration suite passes with --backend oci on Linux with Podman', async () => {
  const result = await runNode(
    [
      `${packageRoot}/node_modules/vitest/vitest.mjs`,
      'run',
      '--project',
      'integration-oci',
      '--testNamePattern',
      ociTestNamePattern,
    ],
    { ...process.env, SCREENS_TEST_BACKEND: 'oci', FORCE_COLOR: '0', NO_COLOR: '1' },
  )
  const report = result.stdout.toString()
  expect(report, report.slice(-4000)).toMatch(/Tests\s+\d+ passed/)
  expect(result.code, report.slice(-4000)).toBe(0)
}, 1_800_000)
