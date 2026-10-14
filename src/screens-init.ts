import type { ChildProcess } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, open, stat } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import { basename, delimiter, join } from 'node:path'
import { parseArgs } from 'node:util'
import { isRecord, isStringArray, onJsonLines, writeJsonLine } from './json-lines.js'
import { startProxyForwarder } from './proxy-forwarder.js'
import { startInSession } from './session-guard.js'

const display = ':1'
const xvncSocketFolder = '/tmp/screens'
const xvncSocket = join(xvncSocketFolder, 'rfb.sock')
const terminateGraceMs = 4_000
const browsers = new Set([
  'google-chrome',
  'google-chrome-stable',
  'google-chrome-beta',
  'google-chrome-unstable',
  'chromium',
  'chromium-browser',
  'chrome',
])

const { values } = parseArgs({
  options: {
    link: { type: 'string' },
    screen: { type: 'string' },
    width: { type: 'string' },
    height: { type: 'string' },
  },
  strict: true,
})
const linkFolder = values.link ?? ''
const screenFolder = values.screen ?? ''
const width = Number(values.width)
const height = Number(values.height)

const home = join(screenFolder, 'home')
const appTmp = join(screenFolder, 'tmp')
const appRuntime = join(screenFolder, 'run')
const session = { folder: screenFolder, display }
const appEnv: NodeJS.ProcessEnv = {
  ...process.env,
  DISPLAY: display,
  HOME: home,
  TMPDIR: appTmp,
  XDG_RUNTIME_DIR: appRuntime,
}
for (const name of [
  'DBUS_SESSION_BUS_ADDRESS',
  'WAYLAND_DISPLAY',
  'XDG_CURRENT_DESKTOP',
  'XDG_SESSION_TYPE',
  'XDG_SESSION_ID',
  'XDG_SESSION_DESKTOP',
  'XAUTHORITY',
]) {
  delete appEnv[name]
}

const children = new Set<ChildProcess>()
let proxyPort: number | undefined
let shuttingDown = false

async function waitForPath(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      await stat(path)
      return
    } catch {}
    if (Date.now() > deadline) throw new Error(`${path} did not appear`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function resolveProgram(program: string): Promise<string | undefined> {
  const candidates = program.includes('/')
    ? [program]
    : (appEnv.PATH ?? '').split(delimiter).map((folder) => join(folder, program))
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      if ((await stat(candidate)).isFile()) return candidate
    } catch {}
  }
  return undefined
}

function browserArguments(): string[] {
  const proxy =
    proxyPort === undefined
      ? []
      : [`--proxy-server=http://127.0.0.1:${proxyPort}`, '--proxy-bypass-list=<-loopback>']
  return [
    '--ozone-platform=x11',
    '--no-first-run',
    '--no-default-browser-check',
    '--password-store=basic',
    '--window-position=0,0',
    `--window-size=${width},${height}`,
    ...proxy,
  ]
}

function track(child: ChildProcess): void {
  children.add(child)
  child.on('exit', () => children.delete(child))
}

async function launch(argv: string[], requestId: number, control: Socket): Promise<void> {
  const [requested, ...rest] = argv
  const program = requested === undefined ? undefined : await resolveProgram(requested)
  if (requested === undefined || program === undefined) {
    writeJsonLine(control, {
      type: 'launch-failed',
      requestId,
      message: `program not found: ${requested ?? ''}`,
    })
    return
  }
  const args = browsers.has(basename(requested)) ? [...browserArguments(), ...rest] : rest
  const log = await open(join(appTmp, `launch-${requestId}.log`), 'a')
  try {
    const child = startInSession('dbus-run-session', ['--', program, ...args], {
      env: appEnv,
      session,
      cwd: home,
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
    })
    child.on('error', (error) => {
      writeJsonLine(control, { type: 'launch-failed', requestId, message: error.message })
    })
    child.on('spawn', () => {
      track(child)
      writeJsonLine(control, { type: 'launched', requestId, pid: child.pid })
    })
  } finally {
    await log.close()
  }
}

function relayRfb(): void {
  const daemonSide = connect(join(linkFolder, 'rfb.sock'))
  const serverSide = connect(xvncSocket)
  daemonSide.pipe(serverSide)
  serverSide.pipe(daemonSide)
  daemonSide.on('error', () => serverSide.destroy())
  serverSide.on('error', () => daemonSide.destroy())
  daemonSide.on('close', () => serverSide.destroy())
  serverSide.on('close', () => daemonSide.destroy())
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {}
  }
}

async function shutdown(): Promise<never> {
  if (!shuttingDown) {
    shuttingDown = true
    for (const child of children) signalGroup(child, 'SIGTERM')
    const deadline = Date.now() + terminateGraceMs
    while (children.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    for (const child of children) signalGroup(child, 'SIGKILL')
  }
  process.exit(0)
}

function handleDaemonMessage(message: unknown, control: Socket): void {
  if (!isRecord(message)) return
  if (message.type === 'rfb') relayRfb()
  else if (message.type === 'stop') void shutdown()
  else if (
    message.type === 'launch' &&
    Number.isSafeInteger(message.requestId) &&
    isStringArray(message.argv) &&
    message.argv.length > 0
  ) {
    const requestId = message.requestId as number
    launch(message.argv, requestId, control).catch((error: Error) => {
      writeJsonLine(control, { type: 'launch-failed', requestId, message: error.message })
    })
  }
}

async function main(): Promise<void> {
  await mkdir(home, { recursive: true })
  await mkdir(appTmp, { recursive: true })
  await mkdir(appRuntime, { recursive: true, mode: 0o700 })
  await mkdir(xvncSocketFolder, { recursive: true, mode: 0o700 })
  const xvnc = startInSession(
    'Xvnc',
    [
      display,
      '-rfbunixpath',
      xvncSocket,
      '-rfbunixmode',
      '0600',
      '-rfbport',
      '0',
      '-SecurityTypes',
      'None',
      '-AlwaysShared',
      '-nolisten',
      'tcp',
      '-geometry',
      `${width}x${height}`,
      '-depth',
      '24',
    ],
    { env: appEnv, session, detached: true, stdio: 'ignore' },
  )
  track(xvnc)
  xvnc.on('exit', () => void shutdown())
  await waitForPath(xvncSocket, 5_000)
  if (process.env.HTTP_PROXY) proxyPort = await startProxyForwarder(process.env.HTTP_PROXY)
  const control = connect(join(linkFolder, 'launch.sock'))
  control.on('close', () => void shutdown())
  control.on('error', () => void shutdown())
  onJsonLines(control, (message) => handleDaemonMessage(message, control))
  control.on('connect', () => writeJsonLine(control, { type: 'ready' }))
}

process.on('SIGTERM', () => void shutdown())
main().catch(() => shutdown())
