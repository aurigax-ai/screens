import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { expect, test } from 'vitest'

test('CON-C21 on the Mac test host with Docker Desktop create, screenshot, click, type, take over and stop pass', async () => {
  const script = join(import.meta.dirname, '../../scripts/test-mac.sh')
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolveRun) => {
      const child = spawn(script, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.on('close', (code) => resolveRun({ code, stdout, stderr }))
    },
  )
  expect(result.code, result.stderr).toBe(0)
  const outcome = JSON.parse(result.stdout.trim().split('\n').pop() ?? '{}')
  expect(outcome).toMatchObject({
    create: 0,
    screenshot: 0,
    click: 0,
    type: 0,
    takeover: 0,
    refusedWhileHuman: 4,
    giveback: 0,
    stop: 0,
  })
  expect(outcome.error).toBeUndefined()
}, 900_000)
