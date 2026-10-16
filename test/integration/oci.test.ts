import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { type AddressInfo, connect } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  type Created,
  closeTo,
  containerName,
  containerRuntime,
  createSandbox,
  createScreen,
  daemonLabel,
  type EventStream,
  launch,
  runInScreen,
  runtimeCli,
  runtimeDefaultSeccompEnv,
  type Sandbox,
  screenshot,
  subscribeEvents,
  testImage,
  waitFor,
} from './harness.js'

let sandbox: Sandbox
let server: Server
let port: number
const paths: string[] = []
const streams: EventStream[] = []
const bystanders: string[] = []

beforeEach(async () => {
  sandbox = await createSandbox()
  paths.length = 0
  server = createServer((request, response) => {
    paths.push(request.url ?? '')
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><body style="margin:0;background:#ff00ff;height:100vh"></body>')
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  port = (server.address() as AddressInfo).port
})

afterEach(async () => {
  for (const stream of streams.splice(0)) stream.close()
  for (const name of bystanders.splice(0)) await runtimeCli(['rm', '-f', name], sandbox.env)
  server.close()
  await sandbox.cleanup()
})

const dockerInCi = process.env.SCREENS_TEST_DOCKER === '1'

function oci(args: string[] = []): Promise<Created> {
  return createScreen(sandbox, ['--backend', 'oci', ...args])
}

async function containersWithLabel(label: string, runtime = containerRuntime): Promise<string[]> {
  const listed = await runtimeCli(['ps', '-aq', '--filter', `label=${label}`], sandbox.env, runtime)
  return listed.stdout.toString().split('\n').filter(Boolean)
}

async function inspect(screen: Created, format: string): Promise<string> {
  const result = await runtimeCli(
    ['inspect', containerName(screen), '--format', format],
    sandbox.env,
  )
  return result.stdout.toString().trim()
}

function connectable(path: string): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const probe = connect(path)
    probe.on('connect', () => {
      probe.destroy()
      resolveProbe(true)
    })
    probe.on('error', () => resolveProbe(false))
  })
}

function parseProbe(output: string): Record<string, string> {
  return Object.fromEntries(
    output
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  )
}

async function listed(id: string): Promise<Record<string, unknown> | undefined> {
  const list = await sandbox.screensJson<{ screens: Record<string, unknown>[] }>(['list'])
  return list.screens.find((entry) => entry.id === id)
}

test('CON-C3 list --json shows the backend of each screen', async () => {
  const xvnc = await createScreen(sandbox, ['--backend', 'xvnc'])
  const container = await oci()
  expect((await listed(xvnc.id))?.backend).toBe('xvnc')
  expect((await listed(container.id))?.backend).toBe('oci')
  expect(container.backend).toBe('oci')
})

test('CON-C4 Podman runs an oci screen by default and Docker runs it with --runtime docker', async () => {
  const screen = await oci()
  expect(screen.runtime).toBe('podman')
  expect((await listed(screen.id))?.runtime).toBe('podman')
  expect(await containersWithLabel(`screens.id=${screen.id}`, 'podman')).toHaveLength(1)
  if (dockerInCi) {
    const docker = await oci(['--runtime', 'docker'])
    expect(docker.runtime).toBe('docker')
    expect(await containersWithLabel(`screens.id=${docker.id}`, 'docker')).toHaveLength(1)
    expect(await containersWithLabel(`screens.id=${docker.id}`, 'podman')).toHaveLength(0)
  }
})

test('CON-C5 with no container runtime create --backend oci exits 5 naming what to install', async () => {
  const bin = await mkdtemp(join(tmpdir(), 'screens-empty-bin-'))
  try {
    await symlink(process.execPath, join(bin, 'node'))
    const result = await sandbox.screens(['create', '--backend', 'oci'], { env: { PATH: bin } })
    expect(result.code).toBe(5)
    expect(result.stderr).toMatch(/podman/i)
    expect(result.stderr).toMatch(/docker/i)
    expect(await readdir(sandbox.stateDir).catch(() => [])).toEqual([])
    const label = `screens.daemon=${daemonLabel(join(sandbox.socketDir, 'daemon.sock'))}`
    expect(await containersWithLabel(label)).toEqual([])
  } finally {
    await rm(bin, { recursive: true, force: true })
  }
})

test('CON-C6 create --runtime nope exits 2 and lists the runtimes', async () => {
  const result = await sandbox.screens(['create', '--backend', 'oci', '--runtime', 'nope'])
  expect(result.code).toBe(2)
  expect(result.stderr).toMatch(/container, podman, docker/)
})

test('CON-C7 the runtime shows no mounts, no ports, network none, no capabilities, no-new-privileges, a read-only root and the label', async () => {
  const screen = await oci()
  expect(await inspect(screen, '{{json .Mounts}}')).toBe('[]')
  expect(await inspect(screen, '{{.HostConfig.NetworkMode}}')).toBe('none')
  expect(await inspect(screen, '{{json .HostConfig.PortBindings}}')).toMatch(/^(\{\}|null)$/)
  expect(await inspect(screen, '{{json .EffectiveCaps}}')).toMatch(/^(\[\]|null)$/)
  expect(await inspect(screen, '{{json .HostConfig.SecurityOpt}}')).toContain('no-new-privileges')
  expect(await inspect(screen, '{{.HostConfig.ReadonlyRootfs}}')).toBe('true')
  expect(await inspect(screen, '{{.HostConfig.Privileged}}')).toBe('false')
  expect(await inspect(screen, '{{index .Config.Labels "screens.id"}}')).toBe(screen.id)
  const inside = parseProbe(
    await runInScreen(
      sandbox,
      screen,
      [
        'echo "caps=$(grep CapEff /proc/self/status | awk \'{print $2}\')"',
        'echo "nnp=$(grep NoNewPrivs /proc/self/status | awk \'{print $2}\')"',
        'touch /usr/screens-probe 2>/dev/null && echo root=writable || echo root=read-only',
      ].join('\n'),
    ),
  )
  expect(inside.caps).toBe('0000000000000000')
  expect(inside.nnp).toBe('1')
  expect(inside.root).toBe('read-only')
})

test("CON-C8 the host's Docker socket and home are not inside a container screen", async () => {
  const reachable = (
    await Promise.all(
      ['/run/docker.sock', '/var/run/docker.sock'].map(
        async (path) => (await connectable(path)) && path,
      ),
    )
  ).filter(Boolean)
  expect(reachable.length, 'this case needs a reachable Docker socket on the host').toBeGreaterThan(
    0,
  )
  const screen = await oci()
  const inside = parseProbe(
    await runInScreen(
      sandbox,
      screen,
      [
        'for path in /run/docker.sock /var/run/docker.sock "$1"; do',
        '  if [ -e "$path" ]; then echo "path:$path=present"; else echo "path:$path=absent"; fi',
        'done',
        'echo "mounts=$(awk \'{print $2}\' /proc/mounts | grep -c "^$1" )"',
      ].join('\n'),
      [homedir()],
    ),
  )
  expect(inside['path:/run/docker.sock']).toBe('absent')
  expect(inside['path:/var/run/docker.sock']).toBe('absent')
  expect(inside[`path:${homedir()}`]).toBe('absent')
  expect(inside.mounts).toBe('0')
})

async function writeFrameFromInside(screen: Created, frameHex: string) {
  const result = await launch(sandbox, screen, [
    'bash',
    '-c',
    'pid=$(pgrep -o -f screens-init); printf "$(echo "$1" | sed "s/../\\\\\\\\x&/g")" > "/proc/$pid/fd/1"',
    'forge',
    frameHex,
  ])
  expect(result.code).toBe(0)
}

async function expectStoppedAlone(target: Created, bystander: Created) {
  await waitFor(async () => (await listed(target.id)) === undefined, 15_000)
  expect(await containersWithLabel(`screens.id=${target.id}`)).toEqual([])
  expect((await sandbox.screens(['daemon', 'status'])).code).toBe(0)
  expect((await listed(bystander.id))?.state).toBe('running')
  const shot = await sandbox.screens(['screenshot', bystander.id, '--token', bystander.agentToken])
  expect(shot.code).toBe(0)
}

test('CON-C9 a malformed frame from a container stops that screen and nothing else', async () => {
  const target = await oci()
  const bystander = await oci()
  await writeFrameFromInside(target, '000000000900000000')
  await expectStoppedAlone(target, bystander)
})

test('CON-C10 a channel the daemon did not ask for, other than a proxy connection, stops the screen', async () => {
  const target = await oci()
  const bystander = await oci()
  const kind = Buffer.from('rfb').toString('hex')
  await writeFrameFromInside(target, `000000010100000003${kind}`)
  await expectStoppedAlone(target, bystander)
})

test("CON-C11 a container's browser renders a host dev server with --allow localhost and an unlisted host waits for the viewer", async () => {
  const screen = await oci(['--allow', 'localhost'])
  const stream = subscribeEvents(sandbox, screen)
  streams.push(stream)
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 300))
  expect(
    (await launch(sandbox, screen, ['chromium', `http://localhost:${port}/listed`])).code,
  ).toBe(0)
  await waitFor(
    async () => closeTo((await screenshot(sandbox, screen)).pixel(320, 600), [255, 0, 255]),
    40_000,
    250,
  )
  expect(paths).toContain('/listed')

  expect(
    (await launch(sandbox, screen, ['chromium', `http://127.0.0.1:${port}/unlisted`])).code,
  ).toBe(0)
  await stream.waitFor(
    (event) => event.type === 'domain-request' && event.host === '127.0.0.1',
    30_000,
  )
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000))
  expect(paths).not.toContain('/unlisted')
  const agentAnswer = await sandbox.screens([
    'allow',
    screen.id,
    '127.0.0.1',
    '--token',
    screen.agentToken,
  ])
  expect(agentAnswer.code).toBe(4)
  expect(
    (await sandbox.screens(['allow', screen.id, '127.0.0.1', '--token', screen.viewerToken])).code,
  ).toBe(0)
  await waitFor(async () => paths.includes('/unlisted'), 20_000)
})

test('CON-C12 a TCP connection from a container that does not use the proxy fails', async () => {
  const screen = await oci()
  const inside = parseProbe(
    await runInScreen(
      sandbox,
      screen,
      [
        'for target in "127.0.0.1/$1" "10.0.2.2/$1" "1.1.1.1/80" "192.168.1.1/80"; do',
        '  if timeout 4 bash -c "exec 3<>/dev/tcp/$target" 2>/dev/null; then echo "tcp:$target=open"; else echo "tcp:$target=failed"; fi',
        'done',
        'echo "interfaces=$(ls /sys/class/net | tr "\\n" " ")"',
      ].join('\n'),
      [String(port)],
    ),
  )
  for (const target of [`127.0.0.1/${port}`, `10.0.2.2/${port}`, '1.1.1.1/80', '192.168.1.1/80']) {
    expect(inside[`tcp:${target}`], target).toBe('failed')
  }
  expect(inside.interfaces?.trim()).toBe('lo')
  expect(paths).toEqual([])
})

test('CON-C13 Chromium in a container runs without --no-sandbox and its renderers in their own user namespace', async () => {
  const screen = await oci()
  const page = `data:text/html,${encodeURIComponent('<body style="background:#ff00ff">')}`
  expect((await launch(sandbox, screen, ['chromium', page])).code).toBe(0)
  await waitFor(
    async () => closeTo((await screenshot(sandbox, screen)).pixel(320, 600), [255, 0, 255]),
    40_000,
    250,
  )
  const inside = parseProbe(
    await runInScreen(
      sandbox,
      screen,
      [
        'browser=$(pgrep -o -f "chromium.*--user-data-dir|/chromium/chromium ")',
        'renderer=$(pgrep -f "chromium.*--type=renderer" | head -1)',
        'echo "browser=$browser"',
        'echo "renderer=$renderer"',
        'flags=0; for pid in $(pgrep chromium); do tr "\\0" "\\n" < /proc/$pid/cmdline | grep -qx -- "--no-sandbox" && flags=$((flags + 1)); done',
        'echo "flags=$flags"',
        'echo "chromium=$(pgrep -c chromium)"',
        'echo "browser_userns=$(readlink /proc/$browser/ns/user)"',
        'echo "renderer_userns=$(readlink /proc/$renderer/ns/user)"',
      ].join('\n'),
    ),
  )
  expect(inside.browser).not.toBe('')
  expect(inside.renderer).not.toBe('')
  expect(Number(inside.chromium)).toBeGreaterThan(1)
  expect(inside.flags).toBe('0')
  expect(inside.renderer_userns).toMatch(/^user:\[\d+\]$/)
  expect(inside.renderer_userns).not.toBe(inside.browser_userns)
})

test('CON-C14 on a runtime that refuses the user namespace calls launching Chromium fails and starts nothing', async () => {
  const restricted = await sandbox.screensJson<Created>(['create', '--backend', 'oci'], {
    env: await runtimeDefaultSeccompEnv(sandbox),
  })
  const launched = await launch(sandbox, restricted, ['chromium', 'about:blank'])
  expect(launched.code).toBe(5)
  expect(launched.stderr).toMatch(/sandbox/i)
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000))
  const inside = await runInScreen(sandbox, restricted, 'echo "chromium=$(pgrep -c chromium)"')
  expect(parseProbe(inside).chromium).toBe('0')
})

test('Issue #18 Chromium in a container draws Chinese and Korean text as glyphs, not as identical empty boxes', async () => {
  const screen = await oci()
  const row = (text: string) =>
    `<div style="height:200px;line-height:200px;font-size:120px;white-space:nowrap">${text}</div>`
  const page = `data:text/html;charset=utf-8,${encodeURIComponent(
    `<!doctype html><body style="margin:0;background:#fff;color:#000">${row('漢字語')}${row('한글의')}</body>`,
  )}`
  expect((await launch(sandbox, screen, ['chromium', '--kiosk', page])).code).toBe(0)
  type Shot = Awaited<ReturnType<typeof screenshot>>
  const dark = (image: Shot, x: number, y: number) => (image.pixel(x, y)[0] ?? 255) < 128
  const inked = (image: Shot) => {
    if (dark(image, 599, 1)) return false
    for (let y = 0; y < 200; y += 2) {
      for (let x = 0; x < 600; x += 2) if (dark(image, x, y)) return true
    }
    return false
  }
  const image = await waitFor(
    async () => {
      const shot = await screenshot(sandbox, screen)
      return inked(shot) && shot
    },
    40_000,
    250,
  )
  let differing = 0
  for (let y = 0; y < 200; y++) {
    for (let x = 0; x < 600; x++) {
      if (dark(image, x, y) !== dark(image, x, y + 200)) differing++
    }
  }
  expect(differing).toBeGreaterThan(2_000)
})

test('CON-C18 a container screen running Chromium is gone within 5 s of stop', async () => {
  const screen = await oci()
  const page = `data:text/html,${encodeURIComponent('<body style="background:#ff00ff">')}`
  expect((await launch(sandbox, screen, ['chromium', page])).code).toBe(0)
  await waitFor(
    async () => closeTo((await screenshot(sandbox, screen)).pixel(320, 600), [255, 0, 255]),
    40_000,
    250,
  )
  const started = Date.now()
  expect((await sandbox.screens(['stop', screen.id, '--token', screen.agentToken])).code).toBe(0)
  expect(await containersWithLabel(`screens.id=${screen.id}`)).toEqual([])
  expect(Date.now() - started).toBeLessThan(5_000)
})

test("CON-C19 after a SIGKILLed daemon the next daemon removes its containers and leaves the user's own", async () => {
  const sleeper = (name: string, labels: string[]) =>
    runtimeCli(
      [
        'run',
        '-d',
        '--rm',
        '--name',
        name,
        ...labels.flatMap((label) => ['--label', label]),
        '--network',
        'none',
        '--entrypoint',
        'sleep',
        testImage,
        '600',
      ],
      sandbox.env,
    )
  const bystander = `screens-test-bystander-${Date.now()}`
  bystanders.push(bystander)
  const started = await sleeper(bystander, ['screens.test=bystander'])
  expect(started.code, started.stderr).toBe(0)
  const first = await oci()
  const second = await oci()
  const { pid } = await sandbox.screensJson<{ pid: number }>(['daemon', 'status'])
  process.kill(pid, 'SIGKILL')
  await waitFor(async () => {
    try {
      process.kill(pid, 0)
      return false
    } catch {
      return true
    }
  }, 5_000)
  const daemon = daemonLabel(join(sandbox.socketDir, 'daemon.sock'))
  const leftover = `screens-${first.id}0`
  bystanders.push(leftover)
  const planted = await sleeper(leftover, [`screens.id=${first.id}0`, `screens.daemon=${daemon}`])
  expect(planted.code, planted.stderr).toBe(0)
  expect(await containersWithLabel(`screens.id=${first.id}0`)).toHaveLength(1)
  expect((await sandbox.screens(['list'])).code).toBe(0)
  await waitFor(
    async () =>
      (await containersWithLabel(`screens.id=${first.id}0`)).length === 0 &&
      (await containersWithLabel(`screens.id=${first.id}`)).length === 0 &&
      (await containersWithLabel(`screens.id=${second.id}`)).length === 0,
    15_000,
  )
  const running = await runtimeCli(
    ['ps', '--filter', `name=${bystander}`, '--format', '{{.Names}}'],
    sandbox.env,
  )
  expect(running.stdout.toString().trim()).toBe(bystander)
})

test('CON-C20 maxScreens counts both backends', async () => {
  await mkdir(join(sandbox.configHome, 'screens'), { recursive: true })
  await writeFile(
    join(sandbox.configHome, 'screens', 'config.json'),
    JSON.stringify({ maxScreens: 2 }),
  )
  await createScreen(sandbox, ['--backend', 'xvnc'])
  await oci()
  for (const backend of ['xvnc', 'oci']) {
    const result = await sandbox.screens(['create', '--backend', backend])
    expect(result.code, backend).toBe(4)
    expect(result.stderr).toContain('limit')
  }
})
