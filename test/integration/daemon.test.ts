import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, mkdir, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  cliPath,
  createSandbox,
  createScreen,
  processesMentioning,
  type Sandbox,
  screenDir,
  waitFor,
} from './harness.js'

let sandbox: Sandbox

beforeEach(async () => {
  sandbox = await createSandbox()
})

afterEach(async () => {
  await sandbox.cleanup()
})

type ListResult = { screens: { id: string }[] }

test('SCR-C2 any screens command starts the daemon with a 0600 socket in a 0700 folder', async () => {
  const started = Date.now()
  const result = await sandbox.screens(['list'])
  expect(result.code).toBe(0)
  expect(Date.now() - started).toBeLessThan(5_000)
  const folder = await stat(sandbox.socketDir)
  expect(folder.mode & 0o777).toBe(0o700)
  const socket = await lstat(join(sandbox.socketDir, 'daemon.sock'))
  expect(socket.isSocket()).toBe(true)
  expect(socket.mode & 0o777).toBe(0o600)
})

test('SCR-C3 a second daemon exits non-zero and the first keeps serving', async () => {
  await sandbox.screensJson<ListResult>(['list'])
  const second = await sandbox.screens(['daemon', 'run'])
  expect(second.code).not.toBe(0)
  const list = await sandbox.screensJson<ListResult>(['list'])
  expect(list.screens).toEqual([])
})

async function listenCanary(path: string): Promise<{ server: Server; connections: () => number }> {
  let connections = 0
  const server = createServer((socket) => {
    connections++
    socket.destroy()
  })
  await new Promise<void>((resolveListen) => server.listen(path, resolveListen))
  return { server, connections: () => connections }
}

async function leaveStaleSocket(path: string): Promise<void> {
  const child = spawn(process.execPath, [
    '-e',
    `require('node:net').createServer().listen(${JSON.stringify(path)}, () => process.kill(process.pid, 'SIGKILL'))`,
  ])
  await new Promise((resolveExit) => child.on('exit', resolveExit))
}

test('SCR-C4 a stale socket file or a symlink at the socket path is unlinked, never followed', async () => {
  await mkdir(sandbox.socketDir, { mode: 0o700 })
  const socketPath = join(sandbox.socketDir, 'daemon.sock')

  await leaveStaleSocket(socketPath)
  expect((await lstat(socketPath)).isSocket()).toBe(true)
  expect((await sandbox.screens(['list'])).code).toBe(0)
  expect((await lstat(socketPath)).isSocket()).toBe(true)
  expect((await sandbox.screens(['daemon', 'stop'])).code).toBe(0)

  const canaryPath = join(sandbox.root, 'canary.sock')
  const canary = await listenCanary(canaryPath)
  await symlink(canaryPath, socketPath)
  try {
    expect((await sandbox.screens(['list'])).code).toBe(0)
    const placed = await lstat(socketPath)
    expect(placed.isSymbolicLink()).toBe(false)
    expect(placed.isSocket()).toBe(true)
    expect(canary.connections()).toBe(0)
    expect((await lstat(canaryPath)).isSocket()).toBe(true)
    expect((await sandbox.screens(['daemon', 'stop'])).code).toBe(0)

    await writeFile(socketPath, 'not a socket')
    expect((await sandbox.screens(['list'])).code).toBe(0)
    expect((await lstat(socketPath)).isSocket()).toBe(true)
  } finally {
    canary.server.close()
  }
})

test('SCR-C5 SIGTERM to the daemon stops every screen and removes their folders before it exits', async () => {
  const first = await createScreen(sandbox)
  const second = await createScreen(sandbox)
  const folders = [screenDir(sandbox, first.id), screenDir(sandbox, second.id)]
  for (const folder of folders) {
    expect(existsSync(folder)).toBe(true)
    expect((await processesMentioning(folder)).length).toBeGreaterThan(0)
  }
  const { pid } = await sandbox.screensJson<{ pid: number }>(['daemon', 'status'])
  const exited = new Promise<void>((resolveExit) => {
    const timer = setInterval(() => {
      try {
        process.kill(pid, 0)
      } catch {
        clearInterval(timer)
        resolveExit()
      }
    }, 20)
  })
  process.kill(pid, 'SIGTERM')
  await exited
  for (const folder of folders) {
    expect(existsSync(folder)).toBe(false)
    expect(await processesMentioning(folder)).toEqual([])
  }
})

test('daemon status reports the pid of a daemon started with daemon run', async () => {
  const daemon = spawn(process.execPath, [cliPath, 'daemon', 'run'], {
    env: sandbox.env,
    stdio: 'ignore',
  })
  await waitFor(async () => existsSync(join(sandbox.socketDir, 'daemon.sock')), 5_000)
  const { pid } = await sandbox.screensJson<{ pid: number }>(['daemon', 'status'])
  expect(pid).toBe(daemon.pid)
})
