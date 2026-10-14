import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const packageRoot = fileURLToPath(new URL('..', import.meta.url))
export const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url))
export const screenHostPath = fileURLToPath(new URL('./screen-host.js', import.meta.url))
export const screensInitPath = fileURLToPath(new URL('./screens-init.js', import.meta.url))

export function userRuntimeDir(): string {
  return `/run/user/${process.getuid?.() ?? 0}`
}

export function runtimeDir(env: NodeJS.ProcessEnv): string {
  return env.XDG_RUNTIME_DIR || userRuntimeDir()
}

export function socketDir(env: NodeJS.ProcessEnv): string {
  return join(runtimeDir(env), 'screens')
}

export function socketPath(env: NodeJS.ProcessEnv): string {
  return join(socketDir(env), 'daemon.sock')
}

export function stateDir(env: NodeJS.ProcessEnv): string {
  return join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'screens')
}

export function configPath(env: NodeJS.ProcessEnv): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'screens', 'config.json')
}
