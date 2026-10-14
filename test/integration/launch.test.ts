import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { type Session, startInSession } from '../../src/session-guard.js'
import {
  type Created,
  closeTo,
  createSandbox,
  createScreen,
  launch,
  processesMentioning,
  runInSession,
  type Sandbox,
  screenDir,
  screenshot,
  waitFor,
} from './harness.js'

const magentaPage =
  '<!doctype html><html><body style="margin:0;background:#ff00ff;height:100vh"></body></html>'
const magenta = [255, 0, 255]

let sandbox: Sandbox

beforeEach(async () => {
  sandbox = await createSandbox()
})

afterEach(async () => {
  await sandbox.cleanup()
})

async function waitForPageColour(screen: Created, colour: number[], timeoutMs: number) {
  let last: number[] = []
  try {
    await waitFor(
      async () => {
        const image = await screenshot(sandbox, screen)
        last = image.pixel(Math.floor(image.width / 4), Math.floor((image.height * 3) / 4))
        return closeTo(last, colour)
      },
      timeoutMs,
      250,
    )
  } catch {
    throw new Error(`page pixel stayed ${last.join(',')}, expected ${colour.join(',')}`)
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit))
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 3_000)
  await exited
  clearTimeout(timer)
}

function freeDisplayNumber(): number {
  for (let display = 60; display < 100; display++) {
    if (!existsSync(`/tmp/.X11-unix/X${display}`) && !existsSync(`/tmp/.X${display}-lock`)) {
      return display
    }
  }
  throw new Error('no free display number')
}

async function windowCount(env: NodeJS.ProcessEnv, session: Session): Promise<number> {
  const result = await runInSession(
    'xdotool',
    ['search', '--onlyvisible', '--class', 'chrome'],
    env,
    session,
  )
  return result.stdout.toString().split('\n').filter(Boolean).length
}

test("SCR-C16 Chrome launched in a screen opens there and not on the human's display", async () => {
  const humanDisplay = `:${freeDisplayNumber()}`
  const humanFolder = join(sandbox.root, 'human')
  const humanSession = { folder: humanFolder, display: humanDisplay }
  const humanEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    DISPLAY: humanDisplay,
    HOME: join(humanFolder, 'home'),
    XDG_RUNTIME_DIR: join(humanFolder, 'run'),
    XDG_CONFIG_HOME: join(humanFolder, 'config'),
  }
  for (const folder of ['home', 'run', 'config']) {
    await mkdir(join(humanFolder, folder), { recursive: true, mode: 0o700 })
  }
  const children: ChildProcess[] = []
  try {
    children.push(
      startInSession(
        'Xvnc',
        [
          humanDisplay,
          '-rfbunixpath',
          join(humanFolder, 'rfb.sock'),
          '-rfbport',
          '0',
          '-SecurityTypes',
          'None',
          '-nolisten',
          'tcp',
          '-geometry',
          '800x600',
        ],
        { env: humanEnv, session: humanSession, stdio: 'ignore' },
      ),
    )
    await waitFor(async () => existsSync(`/tmp/.X11-unix/X${humanDisplay.slice(1)}`), 5_000)
    children.push(
      startInSession(
        'google-chrome-stable',
        [
          '--ozone-platform=x11',
          '--no-first-run',
          '--no-default-browser-check',
          '--password-store=basic',
          'about:blank',
        ],
        { env: humanEnv, session: humanSession, stdio: 'ignore' },
      ),
    )
    const humanWindows = await waitFor(
      async () => (await windowCount(humanEnv, humanSession)) || false,
      20_000,
    )

    const screen = await createScreen(sandbox)
    const url = `data:text/html,${encodeURIComponent(magentaPage)}`
    const launched = await launch(sandbox, screen, ['google-chrome-stable', url])
    expect(launched.code).toBe(0)
    await waitForPageColour(screen, magenta, 20_000)
    expect(await windowCount(humanEnv, humanSession)).toBe(humanWindows)

    const screenChromes: number[] = []
    for (const pid of await processesMentioning(join(screenDir(sandbox, screen.id), 'screen'))) {
      const cmdline = await readFile(`/proc/${pid}/cmdline`, 'latin1').catch(() => '')
      if (cmdline.includes('chrome')) screenChromes.push(pid)
    }
    expect(screenChromes.length).toBeGreaterThan(0)
  } finally {
    for (const child of children.reverse()) await stopChild(child)
    await rm(`/tmp/.X11-unix/X${humanDisplay.slice(1)}`, { force: true })
    await rm(`/tmp/.X${humanDisplay.slice(1)}-lock`, { force: true })
  }
})

test("SCR-C17 with --allow localhost the screen's browser renders a dev server on the host loopback", async () => {
  let requests = 0
  const server = createServer((_request, response) => {
    requests++
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(magentaPage)
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  try {
    const { port } = server.address() as AddressInfo
    const screen = await createScreen(sandbox, ['--allow', 'localhost'])
    const launched = await launch(sandbox, screen, [
      'google-chrome-stable',
      `http://localhost:${port}/`,
    ])
    expect(launched.code).toBe(0)
    await waitForPageColour(screen, magenta, 20_000)
    expect(requests).toBeGreaterThan(0)
  } finally {
    server.close()
  }
})

test('SCR-C18 a launch string with ; or $(...) is one argv word and runs nothing else', async () => {
  const screen = await createScreen(sandbox)
  const home = join(screenDir(sandbox, screen.id), 'screen', 'home')
  const words = [
    `touch ${join(home, 'semicolon-a')}; touch ${join(home, 'semicolon-b')}`,
    `$(touch ${join(home, 'substitution')})`,
    `true && touch ${join(home, 'and')}`,
  ]
  for (const word of words) {
    const result = await launch(sandbox, screen, [word])
    expect(result.code).toBe(5)
    expect(result.stderr).toMatch(/not found/)
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
  const created = (await readdir(home).catch(() => [])).filter((name) =>
    ['semicolon-a', 'semicolon-b', 'substitution', 'and'].includes(name),
  )
  expect(created).toEqual([])
})
