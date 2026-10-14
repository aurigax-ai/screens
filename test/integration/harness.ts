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
