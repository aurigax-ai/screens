import { readFileSync } from 'node:fs'

type Output = { write(text: string): unknown }

const usage = 'usage: screens <verb> [options]\n'

function packageVersion(): string {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  return packageJson.version
}

export function runCli(args: string[], stdout: Output, stderr: Output): number {
  if (args[0] === '--version') {
    stdout.write(`${packageVersion()}\n`)
    return 0
  }
  stderr.write(usage)
  return 2
}
