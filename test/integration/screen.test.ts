import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  type Created,
  createSandbox,
  createScreen,
  decodePng,
  launch,
  packageRoot,
  processesMentioning,
  readScreenHomeFile,
  runInScreen,
  type Sandbox,
  screenDir,
  screenshot,
  testBackend,
  waitFor,
} from './harness.js'

let sandbox: Sandbox

beforeEach(async () => {
  sandbox = await createSandbox()
})

afterEach(async () => {
  await sandbox.cleanup()
})

async function entries(folder: string): Promise<string[]> {
  try {
    return await readdir(folder)
  } catch {
    return []
  }
}

function parseProbe(output: string): Record<string, string> {
  return Object.fromEntries(
    output
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  )
}

test('SCR-C6 a new screen returns a screenshot of its size within 2 s of create', async () => {
  const screen = await createScreen(sandbox, ['--width', '1024', '--height', '640'])
  const created = Date.now()
  const result = await sandbox.screens(['screenshot', screen.id, '--token', screen.agentToken])
  expect(Date.now() - created).toBeLessThan(2_000)
  expect(result.code).toBe(0)
  const image = decodePng(result.stdout)
  expect([image.width, image.height]).toEqual([1024, 640])
})

test('SCR-C7 inside a screen the human display, runtime dir, home and daemon folder are refused or empty', async () => {
  const screen = await createScreen(sandbox)
  const uid = process.getuid?.() ?? 0
  const realHome = homedir()
  const output = await runInScreen(
    sandbox,
    screen,
    [
      'if DISPLAY=:0 xdotool getmouselocation >/dev/null 2>&1; then echo display0=open; else echo display0=refused; fi',
      'if [ -e /tmp/.X11-unix/X0 ]; then echo x0path=present; else echo x0path=absent; fi',
      'if socat -u OPEN:/dev/null ABSTRACT-CONNECT:/tmp/.X11-unix/X0 2>/dev/null; then echo x0abstract=open; else echo x0abstract=refused; fi',
      'if [ -n "$WAYLAND_DISPLAY" ] || [ -n "$XDG_SESSION_TYPE" ]; then echo session=leaked; else echo session=none; fi',
      'echo "runtime=$XDG_RUNTIME_DIR"',
      'for folder in "$@"; do echo "list:$folder=$(ls -A "$folder" 2>/dev/null | tr "\\n" " ")"; done',
    ].join('\n'),
    [
      realHome,
      `/run/user/${uid}`,
      sandbox.runtimeDir,
      sandbox.socketDir,
      sandbox.stateDir,
      screenDir(sandbox, screen.id),
    ],
  )
  const probe = parseProbe(output)
  const listed = (folder: string) =>
    (probe[`list:${folder}`] ?? '').trim().split(' ').filter(Boolean)

  expect(probe.display0).toBe('refused')
  expect(probe.x0path).toBe('absent')
  expect(probe.x0abstract).toBe('refused')
  expect(probe.session).toBe('none')
  expect(probe.runtime).toBe(join(screenDir(sandbox, screen.id), 'screen', 'run'))

  const packageSkeleton = relative(realHome, packageRoot).startsWith('..')
    ? []
    : [relative(realHome, packageRoot).split('/')[0]]
  for (const name of listed(realHome)) expect(packageSkeleton).toContain(name)
  expect(listed(`/run/user/${uid}`)).toEqual([])
  expect(listed(sandbox.runtimeDir)).toEqual([])
  expect(listed(sandbox.socketDir)).toEqual([])
  expect(listed(sandbox.stateDir)).toEqual([screen.id])
  expect(listed(screenDir(sandbox, screen.id)).sort()).toEqual(['bridge', 'link', 'screen'])
})

test('SCR-C8 a screen leaves nothing in the host /tmp/.X11-unix and keeps srt sockets in the state folder', async () => {
  const runtimeSockets = async () =>
    (await entries('/tmp')).filter((name) => /^(claude|srt)-.*\.sock$/.test(name)).sort()
  const x11Before = await entries('/tmp/.X11-unix')
  const runtimeBefore = await runtimeSockets()
  const screen = await createScreen(sandbox)
  await screenshot(sandbox, screen)
  const added = (before: string[], after: string[]) =>
    after.filter((name) => !before.includes(name))
  expect(added(x11Before, await entries('/tmp/.X11-unix'))).toEqual([])
  expect(added(runtimeBefore, await runtimeSockets())).toEqual([])
  const bridgeFolder = join(screenDir(sandbox, screen.id), 'bridge')
  const bridgeSockets = (await entries(bridgeFolder)).filter((name) => name.endsWith('.sock'))
  expect(bridgeSockets.length).toBeGreaterThan(0)
})

test('SCR-C9 a symlink planted from inside the screen never makes the daemon connect to its target', async () => {
  const screen = await createScreen(sandbox)
  const link = join(screenDir(sandbox, screen.id), 'link')
  let connections = 0
  const canaryPath = join(sandbox.root, 'canary.sock')
  const canary = createServer((socket) => {
    connections++
    socket.destroy()
  })
  await new Promise<void>((resolveListen) => canary.listen(canaryPath, resolveListen))
  try {
    const output = await runInScreen(
      sandbox,
      screen,
      [
        'for name in rfb.sock launch.sock; do',
        '  ln -sf "$1" "$2/$name" 2>/dev/null && echo "$name=replaced" || echo "$name=refused"',
        '  rm -f "$2/$name" 2>/dev/null && [ ! -e "$2/$name" ] && echo "$name-rm=removed" || echo "$name-rm=refused"',
        'done',
        'ln -s "$1" "$2/planted.sock" 2>/dev/null && echo planted=yes || echo planted=refused',
      ].join('\n'),
      [canaryPath, link],
    )
    const probe = parseProbe(output)
    expect(probe['rfb.sock']).toBe('refused')
    expect(probe['launch.sock']).toBe('refused')
    expect(probe['rfb.sock-rm']).toBe('refused')
    expect(probe['launch.sock-rm']).toBe('refused')
    expect(probe.planted).toBe('refused')
    const image = await screenshot(sandbox, screen)
    expect(image.width).toBeGreaterThan(0)
    expect(connections).toBe(0)
  } finally {
    canary.close()
  }
})

test('SCR-C10 a screen whose screens-init dies is stopped and leaves list', async () => {
  const screen = await createScreen(sandbox)
  const folder = screenDir(sandbox, screen.id)
  const initPids: number[] = []
  for (const pid of await processesMentioning(folder)) {
    const cmdline = await readFile(`/proc/${pid}/cmdline`, 'latin1').catch(() => '')
    if (cmdline.split('\0')[1]?.endsWith('screens-init.js')) initPids.push(pid)
  }
  expect(initPids.length).toBe(1)
  process.kill(initPids[0] ?? 0, 'SIGKILL')
  await waitFor(async () => {
    const list = await sandbox.screensJson<{ screens: { id: string }[] }>(['list'])
    return !list.screens.some((entry) => entry.id === screen.id)
  }, 10_000)
  expect(existsSync(folder)).toBe(false)
  expect(await processesMentioning(folder)).toEqual([])
})

test('SCR-C11 messages sent to the launch socket from inside the screen run nothing', async () => {
  const screen = await createScreen(sandbox)
  const home = join(screenDir(sandbox, screen.id), 'screen', 'home')
  const link = join(screenDir(sandbox, screen.id), 'link')
  const forged = [
    JSON.stringify({ type: 'launch', requestId: 1, argv: ['touch', join(home, 'forged-launch')] }),
    JSON.stringify({ type: 'launch', argv: ['touch', join(home, 'forged-no-id')] }),
    `touch ${join(home, 'forged-text')}`,
    '{"type":',
  ].join('\n')
  await runInScreen(
    sandbox,
    screen,
    [
      'printf "%s\\n" "$1" | socat -t1 - "UNIX-CONNECT:$2/launch.sock" || true',
      'printf "%s\\n" "$1" | socat -t1 - "UNIX-CONNECT:$2/rfb.sock" || true',
    ].join('\n'),
    [forged, link],
  )
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000))
  const files = await readdir(home)
  expect(files.filter((name) => name.startsWith('forged'))).toEqual([])
  const legit = await launch(sandbox, screen, ['touch', join(home, 'legit')])
  expect(legit.code).toBe(0)
  await waitFor(async () => existsSync(join(home, 'legit')), 5_000)
  expect((await readFile(join(home, 'legit'))).length).toBe(0)
})

const containerSockets = [
  '/run/docker.sock',
  '/var/run/docker.sock',
  '/run/containerd/containerd.sock',
  '/run/podman/podman.sock',
  '/run/crio/crio.sock',
]

const allowedEnvironment = new Set([
  'PATH',
  'LANG',
  'LANGUAGE',
  'TZ',
  'DISPLAY',
  'HOME',
  'TMPDIR',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'PWD',
  'OLDPWD',
  'SHLVL',
  '_',
  'SANDBOX_RUNTIME',
  'NO_PROXY',
  'no_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'FTP_PROXY',
  'ftp_proxy',
  'GRPC_PROXY',
  'grpc_proxy',
  'RSYNC_PROXY',
  'DOCKER_HTTP_PROXY',
  'DOCKER_HTTPS_PROXY',
  'CLOUDSDK_PROXY_ADDRESS',
  'CLOUDSDK_PROXY_PASSWORD',
  'CLOUDSDK_PROXY_PORT',
  'CLOUDSDK_PROXY_TYPE',
  'CLOUDSDK_PROXY_USERNAME',
  'GIT_CONFIG_PARAMETERS',
  'GIT_SSH_COMMAND',
  'JAVA_TOOL_OPTIONS',
  'CLAUDE_CODE_HOST_HTTP_PROXY_PORT',
  'CLAUDE_CODE_HOST_SOCKS_PROXY_PORT',
])

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

test('SCR-C36 container sockets are absent or refused inside a screen', async () => {
  const reachable: string[] = []
  for (const path of containerSockets) if (await connectable(path)) reachable.push(path)
  expect(
    reachable.length,
    'this case needs a container socket the user can connect to',
  ).toBeGreaterThan(0)
  const screen = await createScreen(sandbox)
  const output = await runInScreen(
    sandbox,
    screen,
    [
      'for path in "$@"; do',
      '  if socat -u OPEN:/dev/null "UNIX-CONNECT:$path" 2>/dev/null; then echo "socket:$path=open"; else echo "socket:$path=refused"; fi',
      'done',
    ].join('\n'),
    reachable,
  )
  const probe = parseProbe(output)
  for (const path of reachable) expect(probe[`socket:${path}`]).toBe('refused')
})

const containerEnvironment = new Set([
  'PATH',
  'HOME',
  'HOSTNAME',
  'container',
  'NODE_VERSION',
  'YARN_VERSION',
  'DISPLAY',
  'TMPDIR',
  'XDG_RUNTIME_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'DBUS_SESSION_BUS_ADDRESS',
  'PWD',
  'OLDPWD',
  'SHLVL',
  '_',
])

test('SCR-C36 the screen environment holds only the allowed names and nothing of the caller', async () => {
  const canary = `canary-${Math.random().toString(36).slice(2)}`
  const screen = await sandbox.screensJson<Created>(['create', '--backend', testBackend], {
    env: { SCREENS_TEST_SECRET: canary },
  })
  const output = await runInScreen(
    sandbox,
    screen,
    [
      'env | grep -v "^ " > "$HOME/env.txt"',
      'echo "names=$(env | grep -o "^[A-Za-z_][A-Za-z0-9_]*=" | tr -d = | tr "\\n" " ")"',
    ].join('\n'),
  )
  const probe = parseProbe(output)
  const names = (probe.names ?? '').trim().split(' ').filter(Boolean)
  expect(names).toContain('PATH')
  const allowed = screen.backend === 'oci' ? containerEnvironment : allowedEnvironment
  const outside = names.filter((name) => !allowed.has(name) && !name.startsWith('LC_'))
  expect(outside).toEqual([])
  const environment = (await readScreenHomeFile(sandbox, screen, 'env.txt')) ?? ''
  expect(environment).toContain('PATH=')
  expect(environment).not.toContain(canary)
})
