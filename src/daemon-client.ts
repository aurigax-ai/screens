import { spawn } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { connect } from 'node:net'
import { isRecord } from './json-lines.js'
import { cliPath, socketPath } from './paths.js'
import type { Reply } from './protocol.js'

const daemonStartTimeoutMs = 5_000

async function exchange(path: string, request: Record<string, unknown>): Promise<Reply> {
  const info = await lstat(path)
  if (!info.isSocket()) {
    throw Object.assign(new Error(`${path} is not a socket`), { code: 'ENOENT' })
  }
  return new Promise((resolve, reject) => {
    const socket = connect(path)
    let answer = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on('data', (chunk: string) => {
      answer += chunk
    })
    socket.on('error', reject)
    socket.on('close', () => {
      try {
        const reply: unknown = JSON.parse(answer)
        if (!isRecord(reply) || typeof reply.ok !== 'boolean') throw new Error('malformed reply')
        resolve(reply as Reply)
      } catch {
        reject(new Error('the daemon closed the connection without an answer'))
      }
    })
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

export async function request(
  message: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  { startIfNeeded }: { startIfNeeded: boolean },
): Promise<Reply | undefined> {
  const path = socketPath(env)
  try {
    return await exchange(path, message)
  } catch (error) {
    if (!isNotListening(error)) throw error
    if (!startIfNeeded) return undefined
  }
  startDaemon(env)
  const deadline = Date.now() + daemonStartTimeoutMs
  for (;;) {
    try {
      return await exchange(path, message)
    } catch (error) {
      if (!isNotListening(error) || Date.now() > deadline) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
