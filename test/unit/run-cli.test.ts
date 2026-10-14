import { describe, expect, test } from 'vitest'
import { runCli } from '../../src/run-cli.js'

function capture() {
  let text = ''
  return {
    write(chunk: string | Uint8Array) {
      text += chunk.toString()
    },
    get text() {
      return text
    },
  }
}

function io() {
  return { stdout: capture(), stderr: capture(), env: { XDG_RUNTIME_DIR: '/nonexistent' } }
}

describe('runCli', () => {
  test('prints the package version', async () => {
    const streams = io()
    expect(await runCli(['--version'], streams)).toBe(0)
    expect(streams.stdout.text).toBe('0.0.0\n')
  })

  test('prints usage on stdout and exits 0 with --help', async () => {
    const streams = io()
    expect(await runCli(['--help'], streams)).toBe(0)
    expect(streams.stdout.text).toMatch(/^usage: screens/)
    expect(streams.stderr.text).toBe('')
  })

  test('prints usage and exits 2 without a verb', async () => {
    const streams = io()
    expect(await runCli([], streams)).toBe(2)
    expect(streams.stderr.text).toMatch(/usage: screens/)
  })
})
