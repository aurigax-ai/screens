import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { Daemon } from './daemon.js'
import { openView, request, subscribe } from './daemon-client.js'
import { KeyNameError, parseCombination, parseKeys, parseModifiers } from './keys.js'
import { readPackageVersion } from './paths.js'
import { exitCodes, type Reply } from './protocol.js'

type Output = { write(text: string | Uint8Array): unknown }

export type CliIo = { stdout: Output; stderr: Output; env: NodeJS.ProcessEnv }

const usage = `usage: screens <verb> [options]

  create [--width N] [--height N] [--allow DOMAIN]... [--label TEXT]
  list
  stop <id>
  screenshot <id> [--out FILE] [--max-side N]
  zoom <id> <x0> <y0> <x1> <y1> [--out FILE] [--max-side N]
  click <id> [<x> <y>] [--button left|middle|right] [--count 1-3] [--modifiers KEYS]
        [--down | --up]
  move <id> <x> <y>
  drag <id> <x0> <y0> <x1> <y1> [--modifiers KEYS]
  scroll <id> up|down|left|right <amount> [<x> <y>] [--modifiers KEYS]
  type <id> <text>
  key <id> <keys> [--repeat N]
  hold-key <id> <keys> <seconds>
  cursor <id>
  launch <id> -- <program> [args...]
  windows <id>
  focus <id> <window>
  log <id>
  events <id>
  view <id>                       the RFB stream on stdin/stdout (viewer token)
  takeover <id> <viewer>          (viewer token)
  giveback <id> <viewer>          (viewer token)
  allow <id> <host>               answer a domain request (viewer token)
  deny <id> <host>                answer a domain request (viewer token)
  mcp --screen <id>
  daemon run|stop|status

  --token TOKEN   a token of the screen (or SCREENS_TOKEN)
  --json          print one JSON object
  --help, -h      print this help
  --version       print the version
`

const options = {
  json: { type: 'boolean' },
  token: { type: 'string' },
  width: { type: 'string' },
  height: { type: 'string' },
  allow: { type: 'string', multiple: true },
  label: { type: 'string' },
  out: { type: 'string' },
  'max-side': { type: 'string' },
  button: { type: 'string' },
  count: { type: 'string' },
  modifiers: { type: 'string' },
  down: { type: 'boolean' },
  up: { type: 'boolean' },
  repeat: { type: 'string' },
  screen: { type: 'string' },
  version: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const

type Values = {
  json?: boolean
  token?: string
  width?: string
  height?: string
  allow?: string[]
  label?: string
  out?: string
  'max-side'?: string
  button?: string
  count?: string
  modifiers?: string
  down?: boolean
  up?: boolean
  repeat?: string
  screen?: string
  version?: boolean
  help?: boolean
}

class UsageError extends Error {}

const screenVerbNames = new Set([
  'stop',
  'cursor',
  'windows',
  'log',
  'events',
  'screenshot',
  'zoom',
  'click',
  'move',
  'drag',
  'scroll',
  'type',
  'key',
  'hold-key',
  'launch',
  'focus',
  'view',
  'takeover',
  'giveback',
  'allow',
  'deny',
])

function whole(value: string | undefined, name: string): number {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new UsageError(`${name} must be a whole number`)
  }
  return Number(value)
}

function optionalWhole(value: string | undefined, name: string): number | undefined {
  return value === undefined ? undefined : whole(value, name)
}

function seconds(value: string | undefined): number {
  if (value === undefined || !/^\d+(\.\d+)?$/.test(value)) {
    throw new UsageError('seconds must be a number')
  }
  const duration = Number(value)
  if (duration > 300) throw new UsageError('seconds must be at most 300')
  return duration
}

function point(x: string | undefined, y: string | undefined, name: string): [number, number] {
  return [whole(x, `${name} x`), whole(y, `${name} y`)]
}

function arity(positionals: string[], expected: number[], verb: string): void {
  if (!expected.includes(positionals.length)) {
    throw new UsageError(`${verb} takes ${expected.join(' or ')} argument(s) after the id`)
  }
}

function checkedKeys<T>(parse: (value: string) => T, value: string): T {
  try {
    return parse(value)
  } catch (error) {
    if (error instanceof KeyNameError) throw new UsageError(error.message)
    throw error
  }
}

function oneOf(value: string | undefined, allowed: string[], name: string): string | undefined {
  if (value !== undefined && !allowed.includes(value)) {
    throw new UsageError(`${name} must be one of ${allowed.join(', ')}`)
  }
  return value
}

function screenRequest(verb: string, rest: string[], values: Values): Record<string, unknown> {
  const modifiers = values.modifiers ?? ''
  if (values.modifiers !== undefined) checkedKeys(parseModifiers, modifiers)
  const maxSide = optionalWhole(values['max-side'], '--max-side')
  switch (verb) {
    case 'screenshot':
      arity(rest, [0], verb)
      return { verb, maxSide }
    case 'zoom':
      arity(rest, [4], verb)
      return { verb, region: rest.map((value) => whole(value, 'region')), maxSide }
    case 'click':
      arity(rest, [0, 2], verb)
      if (values.down && values.up) throw new UsageError('--down and --up exclude each other')
      return {
        verb,
        at: rest.length === 2 ? point(rest[0], rest[1], 'click') : undefined,
        button: oneOf(values.button, ['left', 'middle', 'right'], '--button') ?? 'left',
        count: optionalWhole(values.count, '--count') ?? 1,
        modifiers,
        press: values.down ? 'down' : values.up ? 'up' : 'click',
      }
    case 'move':
      arity(rest, [2], verb)
      return { verb, to: point(rest[0], rest[1], 'move') }
    case 'drag':
      arity(rest, [4], verb)
      return {
        verb,
        from: point(rest[0], rest[1], 'drag start'),
        to: point(rest[2], rest[3], 'drag end'),
        modifiers,
      }
    case 'scroll':
      arity(rest, [2, 4], verb)
      return {
        verb,
        direction: oneOf(rest[0], ['up', 'down', 'left', 'right'], 'direction'),
        amount: whole(rest[1], 'amount'),
        at: rest.length === 4 ? point(rest[2], rest[3], 'scroll') : undefined,
        modifiers,
      }
    case 'type':
      arity(rest, [1], verb)
      return { verb, text: rest[0] }
    case 'key':
      arity(rest, [1], verb)
      checkedKeys(parseKeys, rest[0] ?? '')
      return { verb, keys: rest[0], repeat: optionalWhole(values.repeat, '--repeat') ?? 1 }
    case 'hold-key':
      arity(rest, [2], verb)
      checkedKeys(parseCombination, rest[0] ?? '')
      return { verb, keys: rest[0], duration: seconds(rest[1]) }
    case 'launch':
      if (rest.length === 0) throw new UsageError('launch needs <id> -- <program>')
      return { verb, argv: rest }
    case 'focus':
      arity(rest, [1], verb)
      return { verb, window: rest[0] }
    case 'takeover':
    case 'giveback':
      arity(rest, [1], verb)
      return { verb, viewer: rest[0] }
    case 'allow':
    case 'deny':
      arity(rest, [1], verb)
      return { verb, host: rest[0] }
    default:
      arity(rest, [0], verb)
      return { verb }
  }
}

function buildRequest(
  verb: string,
  positionals: string[],
  values: Values,
  env: NodeJS.ProcessEnv,
): Record<string, unknown> {
  switch (verb) {
    case 'list':
      arity(positionals, [0], verb)
      return { verb }
    case 'create':
      arity(positionals, [0], verb)
      return {
        verb,
        width: optionalWhole(values.width, '--width'),
        height: optionalWhole(values.height, '--height'),
        allow: values.allow ?? [],
        label: values.label ?? '',
      }
    case 'daemon': {
      arity(positionals, [1], verb)
      const [action] = positionals
      if (action !== 'run' && action !== 'stop' && action !== 'status') {
        throw new UsageError('daemon takes run, stop or status')
      }
      return { verb: `daemon-${action}` }
    }
    case 'mcp':
      arity(positionals, [0], verb)
      if (!values.screen) throw new UsageError('mcp needs --screen <id>')
      return { verb, id: values.screen }
  }
  if (!screenVerbNames.has(verb)) throw new UsageError(`unknown verb ${verb}`)
  const [id, ...rest] = positionals
  if (id === undefined) throw new UsageError(`${verb} needs a screen id`)
  return {
    ...screenRequest(verb, rest, values),
    id,
    token: values.token ?? env.SCREENS_TOKEN ?? '',
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
  } else if (verb === 'cursor') {
    io.stdout.write(`${reply.x} ${reply.y}\n`)
  } else if (verb === 'windows') {
    for (const window of reply.windows as Record<string, unknown>[]) {
      io.stdout.write(
        `${window.id}\t${window.x},${window.y}\t${window.width}x${window.height}\t${window.name}\n`,
      )
    }
  } else if (verb === 'log') {
    for (const { time, verb: action, ...details } of reply.entries as Record<string, unknown>[]) {
      io.stdout.write(`${time}\t${action}\t${JSON.stringify(details)}\n`)
    }
  } else if (verb === 'allow' || verb === 'deny') {
    io.stdout.write(`${verb === 'allow' ? 'allowed' : 'denied'} ${reply.host}\n`)
  } else if (verb === 'takeover' || verb === 'giveback') {
    io.stdout.write(`owner ${reply.owner}\n`)
  } else if (verb === 'daemon-status') {
    io.stdout.write(`running, pid ${reply.pid}\n`)
  }
}

function fail(
  io: CliIo,
  json: boolean | undefined,
  code: keyof typeof exitCodes,
  message: string,
): number {
  io.stderr.write(`screens: ${message}\n`)
  if (json) io.stdout.write(`${JSON.stringify({ error: { code, message } })}\n`)
  return exitCodes[code]
}

function isParseError(error: unknown): boolean {
  return String((error as NodeJS.ErrnoException).code ?? '').startsWith('ERR_PARSE_ARGS')
}

async function streamView(
  message: Record<string, unknown>,
  values: Values,
  io: CliIo,
): Promise<number> {
  try {
    const opened = await openView(message, io.env)
    if (!opened.ok) return fail(io, values.json, opened.code, opened.message)
    io.stderr.write(`viewer ${opened.viewer}\n`)
    process.stdin.pipe(opened.socket)
    opened.socket.pipe(process.stdout)
    await new Promise((resolve) => opened.socket.on('close', resolve))
    return 0
  } catch (error) {
    return fail(io, values.json, 'backend', `cannot reach the daemon: ${(error as Error).message}`)
  }
}

async function streamEvents(
  message: Record<string, unknown>,
  values: Values,
  io: CliIo,
): Promise<number> {
  try {
    const outcome = await subscribe(message, io.env, (event) => {
      io.stdout.write(`${JSON.stringify(event)}\n`)
    })
    if (!outcome.ok) return fail(io, values.json, outcome.code, outcome.message)
    return 0
  } catch (error) {
    return fail(io, values.json, 'backend', `cannot reach the daemon: ${(error as Error).message}`)
  }
}

export async function runCli(args: string[], io: CliIo): Promise<number> {
  let message: Record<string, unknown>
  let values: Values
  try {
    const parsed = parseArgs({ args, options, allowPositionals: true, strict: true })
    values = parsed.values
    if (values.version) {
      io.stdout.write(`${readPackageVersion()}\n`)
      return 0
    }
    if (values.help) {
      io.stdout.write(usage)
      return 0
    }
    const [verb, ...positionals] = parsed.positionals
    if (verb === undefined) throw new UsageError('missing verb')
    message = buildRequest(verb, positionals, values, io.env)
  } catch (error) {
    if (!(error instanceof UsageError) && !isParseError(error)) throw error
    io.stderr.write(`screens: ${(error as Error).message}\n${usage}`)
    return exitCodes.usage
  }

  if (message.verb === 'daemon-run') return new Daemon(io.env).run()
  if (message.verb === 'mcp') {
    const { runMcpServer } = await import('./mcp.js')
    return runMcpServer(String(message.id), io.env)
  }
  if (message.verb === 'events') return streamEvents(message, values, io)
  if (message.verb === 'view') return streamView(message, values, io)

  const startIfNeeded = message.verb !== 'daemon-stop' && message.verb !== 'daemon-status'
  let reply: Reply | undefined
  try {
    reply = await request(message, io.env, { startIfNeeded })
  } catch (error) {
    return fail(io, values.json, 'backend', `cannot reach the daemon: ${(error as Error).message}`)
  }
  if (reply === undefined) {
    if (message.verb === 'daemon-stop') return 0
    return fail(io, values.json, 'not-found', 'the daemon is not running')
  }
  if (!reply.ok) return fail(io, values.json, reply.code, reply.message)

  const { ok: _ok, ...body } = reply
  if ((message.verb === 'screenshot' || message.verb === 'zoom') && !values.json) {
    const png = Buffer.from(String(body.png), 'base64')
    if (values.out) await writeFile(values.out, png)
    else io.stdout.write(png)
    return 0
  }
  if (values.json) io.stdout.write(`${JSON.stringify(body)}\n`)
  else printText(String(message.verb), body, io)
  return 0
}
