import { spawn } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import { isRecord, onJsonLines } from './json-lines.js'
import { cliPath, socketPath } from './paths.js'
import type { ErrorCode, Reply } from './protocol.js'

const daemonStartTimeoutMs = 5_000

async function open(path: string): Promise<Socket> {
  const info = await lstat(path)
  if (!info.isSocket()) {
    throw Object.assign(new Error(`${path} is not a socket`), { code: 'ENOENT' })
  }
  return new Promise((resolve, reject) => {
    const socket = connect(path)
    socket.once('connect', () => {
      socket.off('error', reject)
      resolve(socket)
    })
    socket.once('error', reject)
  })
}

function isNotListening(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ECONNREFUSED'
}

function startDaemon(env: NodeJS.ProcessEnv): void {
  spawn(process.execPath, [cliPath, 'daemon', 'run'], {
    env,
    detached: true,
    stdio: 'ignore',
  }).unref()
}

async function connectToDaemon(
  env: NodeJS.ProcessEnv,
  startIfNeeded: boolean,
): Promise<Socket | undefined> {
  const path = socketPath(env)
  try {
    return await open(path)
  } catch (error) {
    if (!isNotListening(error)) throw error
    if (!startIfNeeded) return undefined
  }
  startDaemon(env)
  const deadline = Date.now() + daemonStartTimeoutMs
  for (;;) {
    try {
      return await open(path)
    } catch (error) {
      if (!isNotListening(error) || Date.now() > deadline) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function asReply(value: unknown): Reply {
  if (!isRecord(value) || typeof value.ok !== 'boolean') throw new Error('malformed reply')
  return value as Reply
}

function isProgress(line: unknown): line is { type: 'progress'; message: string } {
  return isRecord(line) && line.type === 'progress' && !('ok' in line)
}

export async function request(
  message: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  { startIfNeeded, onProgress }: { startIfNeeded: boolean; onProgress?: (line: string) => void },
): Promise<Reply | undefined> {
  const socket = await connectToDaemon(env, startIfNeeded)
  if (!socket) return undefined
  return new Promise((resolve, reject) => {
    let reply: Reply | undefined
    onJsonLines(socket, (line) => {
      if (isProgress(line)) {
        if (!reply) onProgress?.(String(line.message))
        return
      }
      reply ??= asReply(line)
    })
    socket.on('error', reject)
    socket.on('close', () => {
      if (reply) resolve(reply)
      else reject(new Error('the daemon closed the connection without an answer'))
    })
    socket.write(`${JSON.stringify(message)}\n`)
  })
}

export type Subscription = { ok: true } | { ok: false; code: ErrorCode; message: string }

export async function subscribe(
  message: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  onEvent: (event: Record<string, unknown>) => void,
): Promise<Subscription> {
  const socket = await connectToDaemon(env, true)
  if (!socket) throw new Error('the daemon is not running')
  return new Promise((resolve, reject) => {
    let first: Reply | undefined
    onJsonLines(socket, (line) => {
      if (!first) {
        first = asReply(line)
        return
      }
      if (isRecord(line)) onEvent(line)
    })
    socket.on('error', reject)
    socket.on('close', () => {
      if (!first) reject(new Error('the daemon closed the connection without an answer'))
      else if (first.ok) resolve({ ok: true })
      else resolve({ ok: false, code: first.code, message: first.message })
    })
    socket.write(`${JSON.stringify(message)}\n`)
  })
}

export type ViewOpening =
  | { ok: true; viewer: string; socket: Socket }
  | { ok: false; code: ErrorCode; message: string }

export async function openView(
  message: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Promise<ViewOpening> {
  const socket = await connectToDaemon(env, true)
  if (!socket) throw new Error('the daemon is not running')
  socket.write(`${JSON.stringify(message)}\n`)
  const line = await new Promise<Buffer>((resolve, reject) => {
    let pending = Buffer.alloc(0)
    const onData = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])
      const newline = pending.indexOf(10)
      if (newline < 0) return
      socket.off('data', onData)
      socket.pause()
      const rest = pending.subarray(newline + 1)
      if (rest.length > 0) socket.unshift(rest)
      resolve(pending.subarray(0, newline))
    }
    socket.on('data', onData)
    socket.once('error', reject)
    socket.once('close', () =>
      reject(new Error('the daemon closed the connection without an answer')),
    )
  })
  const reply = asReply(JSON.parse(line.toString('utf8')))
  if (!reply.ok) {
    socket.destroy()
    return { ok: false, code: reply.code, message: reply.message }
  }
  return { ok: true, viewer: String(reply.viewer), socket }
}

export async function openLease(
  message: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  onProgress: (line: string) => void,
): Promise<{ reply: Reply; closed: Promise<void> }> {
  const socket = await connectToDaemon(env, true)
  if (!socket) throw new Error('the daemon is not running')
  const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()))
  const reply = await new Promise<Reply>((resolve, reject) => {
    let answered = false
    onJsonLines(socket, (line) => {
      if (answered) return
      if (isProgress(line)) {
        onProgress(String(line.message))
        return
      }
      answered = true
      resolve(asReply(line))
    })
    socket.on('error', reject)
    socket.on('close', () => {
      if (!answered) reject(new Error('the daemon closed the connection without an answer'))
    })
    socket.write(`${JSON.stringify(message)}\n`)
  })
  return { reply, closed }
}
