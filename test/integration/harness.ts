import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, readlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { inflateSync } from 'node:zlib'
import { type Session, startInSession } from '../../src/session-guard.js'

export const packageRoot = resolve(import.meta.dirname, '../..')
export const cliPath = join(packageRoot, 'dist/cli.js')

export type RunResult = { code: number | null; stdout: Buffer; stderr: string }

export type Sandbox = {
  root: string
  runtimeDir: string
  stateHome: string
  configHome: string
  stateDir: string
  socketDir: string
  env: NodeJS.ProcessEnv
  screens(args: string[], options?: { env?: NodeJS.ProcessEnv }): Promise<RunResult>
  screensJson<T>(args: string[], options?: { env?: NodeJS.ProcessEnv }): Promise<T>
  cleanup(): Promise<void>
}

export async function createSandbox(): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), 'screens-test-'))
  const runtimeDir = join(root, 'run')
  const stateHome = join(root, 'state')
  const configHome = join(root, 'config')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_RUNTIME_DIR: runtimeDir,
    XDG_STATE_HOME: stateHome,
    XDG_CONFIG_HOME: configHome,
  }
  for (const name of [
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'XDG_SESSION_TYPE',
    'XDG_CURRENT_DESKTOP',
    'XDG_SESSION_DESKTOP',
    'DBUS_SESSION_BUS_ADDRESS',
    'XAUTHORITY',
    'SCREENS_TOKEN',
  ]) {
    delete env[name]
  }
  await mkdir(runtimeDir, { mode: 0o700 })
  const sandbox: Sandbox = {
    root,
    runtimeDir,
    stateHome,
    configHome,
    stateDir: join(stateHome, 'screens'),
    socketDir: join(runtimeDir, 'screens'),
    env,
    screens: (args, options) => runNode([cliPath, ...args], { ...env, ...options?.env }),
    async screensJson<T>(args: string[], options?: { env?: NodeJS.ProcessEnv }) {
      const result = await sandbox.screens([...args, '--json'], options)
      if (result.code !== 0) {
        throw new Error(`screens ${args.join(' ')} exited ${result.code}: ${result.stderr}`)
      }
      return JSON.parse(result.stdout.toString()) as T
    },
    async cleanup() {
      await sandbox.screens(['daemon', 'stop'])
      await killProcessesMentioning(root)
      await rm(root, { recursive: true, force: true })
    },
  }
  return sandbox
}

export function runNode(args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => resolvePromise({ code, stdout: Buffer.concat(out), stderr }))
  })
}

export function runInSession(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  session: Session,
): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = startInSession(command, args, { env, session, stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => resolvePromise({ code, stdout: Buffer.concat(out), stderr }))
  })
}

export async function processesMentioning(text: string): Promise<number[]> {
  const pids: number[] = []
  for (const entry of await readdir('/proc')) {
    const pid = Number(entry)
    if (!Number.isInteger(pid) || pid === process.pid) continue
    for (const file of ['cmdline', 'environ']) {
      try {
        const content = await readFile(`/proc/${pid}/${file}`, 'latin1')
        if (content.includes(text)) {
          pids.push(pid)
          break
        }
      } catch {}
    }
  }
  return pids
}

export async function killProcessesMentioning(text: string): Promise<void> {
  for (const pid of await processesMentioning(text)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
}

export async function pidNamespaceOf(pid: number): Promise<string> {
  return readlink(`/proc/${pid}/ns/pid`)
}

export async function waitFor<T>(
  probe: () => Promise<T | undefined | false>,
  timeoutMs: number,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, intervalMs))
  }
}

export type Image = { width: number; height: number; pixel(x: number, y: number): number[] }

export function decodePng(png: Buffer): Image {
  if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('not a PNG')
  let offset = 8
  let width = 0
  let height = 0
  let channels = 0
  const data: Buffer[] = []
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.subarray(offset + 4, offset + 8).toString('latin1')
    const body = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      channels = body[9] === 6 ? 4 : 3
    }
    if (type === 'IDAT') data.push(body)
    offset += length + 12
  }
  const raw = inflateSync(Buffer.concat(data))
  const stride = width * channels + 1
  const pixels = Buffer.alloc(width * height * channels)
  for (let row = 0; row < height; row++) {
    const filter = raw[row * stride]
    const line = raw.subarray(row * stride + 1, (row + 1) * stride)
    const previous = row > 0 ? pixels.subarray((row - 1) * width * channels) : undefined
    for (let index = 0; index < line.length; index++) {
      const left = index >= channels ? (pixels[row * width * channels + index - channels] ?? 0) : 0
      const up = previous ? (previous[index] ?? 0) : 0
      const value = line[index] ?? 0
      pixels[row * width * channels + index] =
        filter === 0 ? value : filter === 1 ? value + left : filter === 2 ? value + up : value
    }
  }
  return {
    width,
    height,
    pixel: (x, y) => [
      ...pixels.subarray((y * width + x) * channels, (y * width + x) * channels + 3),
    ],
  }
}

export function closeTo(actual: number[], expected: number[], tolerance = 12): boolean {
  return actual.every((value, index) => Math.abs(value - (expected[index] ?? 0)) <= tolerance)
}

export type Created = { id: string; agentToken: string; viewerToken: string }

export async function createScreen(sandbox: Sandbox, args: string[] = []): Promise<Created> {
  return sandbox.screensJson<Created>(['create', ...args])
}

export function screenDir(sandbox: Sandbox, id: string): string {
  return join(sandbox.stateDir, id)
}

export async function launch(
  sandbox: Sandbox,
  screen: Created,
  argv: string[],
): Promise<RunResult> {
  return sandbox.screens(['launch', screen.id, '--token', screen.agentToken, '--', ...argv])
}

export async function screenshot(sandbox: Sandbox, screen: Created): Promise<Image> {
  const result = await sandbox.screens(['screenshot', screen.id, '--token', screen.agentToken])
  if (result.code !== 0) throw new Error(`screenshot exited ${result.code}: ${result.stderr}`)
  return decodePng(result.stdout)
}

export async function runInScreen(
  sandbox: Sandbox,
  screen: Created,
  script: string,
  args: string[] = [],
): Promise<string> {
  const home = join(screenDir(sandbox, screen.id), 'screen', 'home')
  const marker = `probe-${Math.random().toString(36).slice(2)}`
  const result = await launch(sandbox, screen, [
    'bash',
    '-c',
    `{ ${script}\n} > "$HOME/${marker}.out" 2>&1; touch "$HOME/${marker}.done"`,
    'probe',
    ...args,
  ])
  if (result.code !== 0) throw new Error(`launch exited ${result.code}: ${result.stderr}`)
  await waitFor(async () => {
    try {
      await readFile(join(home, `${marker}.done`))
      return true
    } catch {
      return false
    }
  }, 15_000)
  return readFile(join(home, `${marker}.out`), 'utf8')
}

export type EchoEvent = Record<string, unknown> & { type: string }

export type EchoServer = {
  port: number
  url: string
  events: EchoEvent[]
  waitForEvent(match: (event: EchoEvent) => boolean, timeoutMs?: number): Promise<EchoEvent>
  close(): void
}

const echoPage = `<!doctype html>
<html><body style="margin:0;height:100vh;background:#ffffff">
<input id="field" style="position:absolute;left:100px;top:100px;width:300px;height:40px">
<script>
const send = (event) => fetch('/event', { method: 'POST', body: JSON.stringify(event) })
addEventListener('mousedown', (e) => send({ type: 'mousedown', x: e.clientX, y: e.clientY, button: e.button }))
addEventListener('mouseup', (e) => send({ type: 'mouseup', x: e.clientX, y: e.clientY, button: e.button }))
addEventListener('click', (e) => send({ type: 'click', x: e.clientX, y: e.clientY, detail: e.detail, shift: e.shiftKey }))
addEventListener('contextmenu', (e) => { e.preventDefault(); send({ type: 'contextmenu', x: e.clientX, y: e.clientY }) })
addEventListener('keydown', (e) => send({ type: 'keydown', key: e.key, ctrl: e.ctrlKey, shift: e.shiftKey }))
addEventListener('wheel', (e) => send({ type: 'wheel', x: e.clientX, y: e.clientY, dx: e.deltaX, dy: e.deltaY }))
let moveTimer
addEventListener('mousemove', (e) => {
  clearTimeout(moveTimer)
  moveTimer = setTimeout(() => send({ type: 'mousemove', x: e.clientX, y: e.clientY }), 100)
})
document.getElementById('field').addEventListener('input', (e) => send({ type: 'input', value: e.target.value }))
const sendSize = () => send({ type: 'size', width: innerWidth, height: innerHeight })
addEventListener('resize', sendSize)
sendSize()
</script>
</body></html>`

export async function startEchoServer(): Promise<EchoServer> {
  const { createServer } = await import('node:http')
  const events: EchoEvent[] = []
  const listeners = new Set<() => void>()
  const server = createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/event') {
      let body = ''
      request.on('data', (chunk: Buffer) => {
        body += chunk.toString()
      })
      request.on('end', () => {
        try {
          events.push(JSON.parse(body) as EchoEvent)
        } catch {}
        for (const listener of listeners) listener()
        response.end('ok')
      })
      return
    }
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(echoPage)
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    port,
    url: `http://localhost:${port}/`,
    events,
    waitForEvent(match, timeoutMs = 10_000) {
      return new Promise((resolveEvent, reject) => {
        const check = () => {
          const found = events.find(match)
          if (!found) return false
          listeners.delete(check)
          clearTimeout(timer)
          resolveEvent(found)
          return true
        }
        const timer = setTimeout(() => {
          listeners.delete(check)
          reject(new Error(`no matching event; got ${JSON.stringify(events)}`))
        }, timeoutMs)
        listeners.add(check)
        check()
      })
    },
    close: () => server.close(),
  }
}

export async function openEchoPage(
  sandbox: Sandbox,
  screen: Created,
  echo: EchoServer,
  width: number,
  height: number,
) {
  const launched = await launch(sandbox, screen, ['google-chrome-stable', '--kiosk', echo.url])
  if (launched.code !== 0) throw new Error(`launch exited ${launched.code}: ${launched.stderr}`)
  return echo.waitForEvent(
    (event) =>
      event.type === 'size' &&
      Number(event.width) >= width - 1 &&
      Number(event.height) >= height - 1,
    20_000,
  )
}

export type Viewer = {
  id: string
  rfb: import('../../src/rfb-client.js').RfbClient
  socket: import('node:net').Socket
  click(x: number, y: number): Promise<void>
  close(): void
}

export async function openViewer(
  sandbox: Sandbox,
  screen: Created,
  token: string,
): Promise<Viewer> {
  const { connect } = await import('node:net')
  const { RfbClient } = await import('../../src/rfb-client.js')
  const socket = connect(join(sandbox.socketDir, 'daemon.sock'))
  await new Promise<void>((resolveConnect, reject) => {
    socket.once('connect', () => resolveConnect())
    socket.once('error', reject)
  })
  socket.write(`${JSON.stringify({ verb: 'view', id: screen.id, token })}\n`)
  const reply = await new Promise<Record<string, unknown>>((resolveReply, reject) => {
    let pending = Buffer.alloc(0)
    const onData = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])
      const newline = pending.indexOf(10)
      if (newline < 0) return
      socket.off('data', onData)
      socket.pause()
      const rest = pending.subarray(newline + 1)
      if (rest.length > 0) socket.unshift(rest)
      resolveReply(JSON.parse(pending.subarray(0, newline).toString()))
    }
    socket.on('data', onData)
    socket.once('error', reject)
  })
  if (reply.ok !== true) {
    socket.destroy()
    throw Object.assign(new Error(String(reply.message)), { code: reply.code })
  }
  const connecting = RfbClient.connect(socket)
  socket.resume()
  const rfb = await connecting
  return {
    id: String(reply.viewer),
    rfb,
    socket,
    async click(x, y) {
      rfb.pointer(x, y, 0)
      rfb.pointer(x, y, 1)
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
      rfb.pointer(x, y, 0)
    },
    close: () => socket.destroy(),
  }
}

export async function daemonRequest(
  sandbox: Sandbox,
  message: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { connect } = await import('node:net')
  const socket = connect(join(sandbox.socketDir, 'daemon.sock'))
  return new Promise((resolveReply, reject) => {
    let answer = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify(message)}\n`))
    socket.on('data', (chunk: string) => {
      answer += chunk
    })
    socket.on('error', reject)
    socket.on('close', () => resolveReply(JSON.parse(answer)))
  })
}

export type EventStream = {
  events: Record<string, unknown>[]
  waitFor(match: (event: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<void>
  close(): void
}

export function subscribeEvents(sandbox: Sandbox, screen: Created): EventStream {
  const child = spawn(
    process.execPath,
    [cliPath, 'events', screen.id, '--token', screen.viewerToken],
    { env: sandbox.env, stdio: ['ignore', 'pipe', 'ignore'] },
  )
  const events: Record<string, unknown>[] = []
  let pending = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    pending += chunk
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) if (line) events.push(JSON.parse(line))
  })
  return {
    events,
    waitFor: (match, timeoutMs = 15_000) =>
      waitFor(async () => events.some(match), timeoutMs, 50).then(() => undefined),
    close: () => child.kill(),
  }
}

export function startInScreen(
  sandbox: Sandbox,
  screen: Created,
  script: string,
  args: string[] = [],
): { done: () => Promise<string | undefined>; finished: () => Promise<string> } {
  const home = join(screenDir(sandbox, screen.id), 'screen', 'home')
  const marker = `job-${Math.random().toString(36).slice(2)}`
  const started = launch(sandbox, screen, [
    'bash',
    '-c',
    `{ ${script}\n} > "$HOME/${marker}.out" 2>&1; touch "$HOME/${marker}.done"`,
    'job',
    ...args,
  ])
  const done = async () => {
    await started
    try {
      await readFile(join(home, `${marker}.done`))
      return await readFile(join(home, `${marker}.out`), 'utf8')
    } catch {
      return undefined
    }
  }
  return {
    done,
    finished: () => waitFor(done, 85_000, 100),
  }
}
