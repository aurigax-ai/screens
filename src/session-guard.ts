import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process'
import { resolve, sep } from 'node:path'

export type Session = { folder: string; display: string }

export class SessionEnvError extends Error {
  readonly code = 'session-env'

  constructor(readonly variable: string) {
    super(`session-env: ${variable} points outside the screen`)
  }
}

function isInside(path: string, folder: string): boolean {
  return resolve(path).startsWith(resolve(folder) + sep)
}

function busPath(address: string): string | undefined {
  const match = /^unix:path=([^,]+)(,.*)?$/.exec(address)
  return match?.[1]
}

export function sessionEnvViolation(env: NodeJS.ProcessEnv, session: Session): string | undefined {
  if (env.DISPLAY !== session.display) return 'DISPLAY'
  if (env.WAYLAND_DISPLAY !== undefined) return 'WAYLAND_DISPLAY'
  const bus = env.DBUS_SESSION_BUS_ADDRESS
  if (bus !== undefined) {
    const path = busPath(bus)
    if (path === undefined || !isInside(path, session.folder)) return 'DBUS_SESSION_BUS_ADDRESS'
  }
  const runtime = env.XDG_RUNTIME_DIR
  if (runtime === undefined || !isInside(runtime, session.folder)) return 'XDG_RUNTIME_DIR'
  return undefined
}

export function startInSession(
  command: string,
  args: string[],
  options: SpawnOptions & { env: NodeJS.ProcessEnv; session: Session },
): ChildProcess {
  const { session, ...spawnOptions } = options
  const variable = sessionEnvViolation(options.env, session)
  if (variable !== undefined) throw new SessionEnvError(variable)
  return spawn(command, args, spawnOptions)
}
