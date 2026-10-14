import { describe, expect, test } from 'vitest'
import { runCli } from '../../src/run-cli.js'

function capture() {
  let text = ''
  return {
    write(chunk: string) {
      text += chunk
    },
    get text() {
      return text
    },
  }
}

describe('runCli', () => {
  test('prints the package version', () => {
    const stdout = capture()
    const stderr = capture()
    expect(runCli(['--version'], stdout, stderr)).toBe(0)
    expect(stdout.text).toBe('0.0.0\n')
  })

  test('prints usage and exits 2 without a verb', () => {
    const stdout = capture()
    const stderr = capture()
    expect(runCli([], stdout, stderr)).toBe(2)
    expect(stderr.text).toMatch(/^usage: screens/)
  })
})
