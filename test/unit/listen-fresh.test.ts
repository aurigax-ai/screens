import { lstat, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { listenFresh } from '../../src/listen-fresh.js'

let folder: string

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'screens-unit-'))
})

afterEach(async () => {
  await rm(folder, { recursive: true, force: true })
})

test('SCR-C9 a symlink where a link socket goes is unlinked before listen and its target never reached', async () => {
  let canaryConnections = 0
  const canaryPath = join(folder, 'canary.sock')
  const canary = createServer((socket) => {
    canaryConnections++
    socket.destroy()
  })
  await new Promise<void>((resolveListen) => canary.listen(canaryPath, resolveListen))
  const socketPath = join(folder, 'rfb.sock')
  await symlink(canaryPath, socketPath)
  const server = await listenFresh(socketPath, (socket) => socket.destroy())
  try {
    const placed = await lstat(socketPath)
    expect(placed.isSymbolicLink()).toBe(false)
    expect(placed.isSocket()).toBe(true)
    expect(placed.mode & 0o777).toBe(0o600)
    expect((await lstat(canaryPath)).isSocket()).toBe(true)
    expect(canaryConnections).toBe(0)
  } finally {
    server.close()
    canary.close()
  }
})

test('listenFresh replaces a plain file at the socket path', async () => {
  const socketPath = join(folder, 'launch.sock')
  await writeFile(socketPath, 'planted')
  const server = await listenFresh(socketPath, (socket) => socket.destroy())
  try {
    expect((await lstat(socketPath)).isSocket()).toBe(true)
  } finally {
    server.close()
  }
})
