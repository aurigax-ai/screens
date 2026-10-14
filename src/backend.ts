import type { Duplex } from 'node:stream'

export type BackendName = 'xvnc' | 'oci'

export type BackendEvents = {
  message(message: Record<string, unknown>): void
  ask(host: string, port: number | undefined): Promise<boolean>
  gone(reason: string): void
}

export interface ScreenBackend {
  readonly name: BackendName
  readonly runtime: string | undefined
  start(events: BackendEvents): Promise<void>
  send(message: Record<string, unknown>): void
  openRelay(): Promise<Duplex>
  stop(): Promise<void>
}

export class BackendError extends Error {}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new BackendError(`${what} timed out`)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export function waitForExit(exited: Promise<void>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    exited.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ])
}
