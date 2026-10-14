import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { Daemon } from './daemon.js'
import { request } from './daemon-client.js'
import { exitCodes, type Reply } from './protocol.js'

type Output = { write(text: string | Uint8Array): unknown }

export type CliIo = { stdout: Output; stderr: Output; env: NodeJS.ProcessEnv }

const usage = `usage: screens <verb> [options]

  create [--width N] [--height N] [--allow DOMAIN]... [--label TEXT]
  list
  screenshot <id> [--out FILE]
  launch <id> -- <program> [args...]
  stop <id>
  daemon run|stop|status

  --token TOKEN   a token of the screen (or SCREENS_TOKEN)
  --json          print one JSON object
`

const options = {
  json: { type: 'boolean' },
  token: { type: 'string' },
  width: { type: 'string' },
  height: { type: 'string' },
  allow: { type: 'string', multiple: true },
  label: { type: 'string' },
  out: { type: 'string' },
  version: { type: 'boolean' },
} as const

type Values = {
  json?: boolean
  token?: string
  width?: string
  height?: string
  allow?: string[]
  label?: string
  out?: string
  version?: boolean
}

class UsageError extends Error {}

function packageVersion(): string {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  return packageJson.version
}

function side(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value)) throw new UsageError(`--${name} must be a whole number`)
  return Number(value)
}

function only(positionals: string[], count: number, verb: string): string[] {
  if (positionals.length !== count) throw new UsageError(`${verb} takes ${count} argument(s)`)
  return positionals
}

function buildRequest(
  verb: string,
  positionals: string[],
  values: Values,
  env: NodeJS.ProcessEnv,
): Record<string, unknown> {
  const token = values.token ?? env.SCREENS_TOKEN ?? ''
  switch (verb) {
    case 'list':
      only(positionals, 0, verb)
      return { verb }
    case 'create':
      only(positionals, 0, verb)
      return {
        verb,
        width: side(values.width, 'width'),
        height: side(values.height, 'height'),
        allow: values.allow ?? [],
        label: values.label ?? '',
      }
    case 'screenshot':
    case 'stop': {
      const [id] = only(positionals, 1, verb)
      return { verb, id, token }
    }
    case 'launch': {
      const [id, ...argv] = positionals
      if (id === undefined || argv.length === 0)
        throw new UsageError('launch needs <id> -- <program>')
      return { verb, id, token, argv }
    }
    case 'daemon': {
      const [action] = only(positionals, 1, verb)
      if (action !== 'run' && action !== 'stop' && action !== 'status') {
        throw new UsageError('daemon takes run, stop or status')
      }
      return { verb: `daemon-${action}` }
    }
    default:
      throw new UsageError(`unknown verb ${verb}`)
  }
}

function printText(verb: string, reply: Record<string, unknown>, io: CliIo): void {
  if (verb === 'create') {
    io.stdout.write(
      `id ${reply.id}\nagent-token ${reply.agentToken}\nviewer-token ${reply.viewerToken}\n`,
    )
  } else if (verb === 'list') {
    for (const screen of reply.screens as Record<string, unknown>[]) {
      io.stdout.write(
        `${screen.id}\t${screen.width}x${screen.height}\t${screen.owner}\t${screen.state}\t${screen.label}\n`,
      )
    }
  } else if (verb === 'launch') {
    io.stdout.write(`${reply.pid}\n`)
  } else if (verb === 'daemon-status') {
    io.stdout.write(`running, pid ${reply.pid}\n`)
  }
}

export async function runCli(args: string[], io: CliIo): Promise<number> {
  let verb: string
  let positionals: string[]
  let values: Values
  try {
    const parsed = parseArgs({ args, options, allowPositionals: true, strict: true })
    values = parsed.values
    if (values.version) {
      io.stdout.write(`${packageVersion()}\n`)
      return 0
    }
    const [first, ...rest] = parsed.positionals
    if (first === undefined) throw new UsageError('missing verb')
    verb = first
    positionals = rest
  } catch (error) {
    io.stderr.write(`screens: ${(error as Error).message}\n${usage}`)
    return exitCodes.usage
  }

  let message: Record<string, unknown>
  try {
    message = buildRequest(verb, positionals, values, io.env)
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    io.stderr.write(`screens: ${error.message}\n${usage}`)
    return exitCodes.usage
  }

  if (message.verb === 'daemon-run') return new Daemon(io.env).run()

  const startIfNeeded = message.verb !== 'daemon-stop' && message.verb !== 'daemon-status'
  let reply: Reply | undefined
  try {
    reply = await request(message, io.env, { startIfNeeded })
  } catch (error) {
    io.stderr.write(`screens: cannot reach the daemon: ${(error as Error).message}\n`)
    return exitCodes.backend
  }
  if (reply === undefined) {
    if (message.verb === 'daemon-stop') return 0
    io.stderr.write('screens: the daemon is not running\n')
    return exitCodes['not-found']
  }
  if (!reply.ok) {
    io.stderr.write(`screens: ${reply.message}\n`)
    return exitCodes[reply.code] ?? exitCodes.backend
  }

  const { ok: _ok, ...body } = reply
  if (message.verb === 'screenshot' && !values.json) {
    const png = Buffer.from(String(body.png), 'base64')
    if (values.out) await writeFile(values.out, png)
    else io.stdout.write(png)
    return 0
  }
  if (values.json) io.stdout.write(`${JSON.stringify(body)}\n`)
  else printText(String(message.verb), body, io)
  return 0
}
