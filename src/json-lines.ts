import type { Duplex } from 'node:stream'

const maxLineBytes = 64 * 1024 * 1024

export function onJsonLines(socket: Duplex, handle: (message: unknown) => void): void {
  let pending = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    pending += chunk
    let newline = pending.indexOf('\n')
    while (newline >= 0) {
      const line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        message = undefined
      }
      if (message !== undefined) handle(message)
      newline = pending.indexOf('\n')
    }
    if (pending.length > maxLineBytes) socket.destroy()
  })
}

export function writeJsonLine(socket: Duplex, message: unknown): void {
  if (socket.writable) socket.write(`${JSON.stringify(message)}\n`)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}
