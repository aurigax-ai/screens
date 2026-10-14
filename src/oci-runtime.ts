import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const runtimeNames = ['container', 'podman', 'docker'] as const
export type RuntimeName = (typeof runtimeNames)[number]

export type CommandResult = { code: number; stdout: string; stderr: string }

export function runCommand(
  program: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 30_000,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(program, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

async function answers(runtime: RuntimeName, env: NodeJS.ProcessEnv): Promise<boolean> {
  const probe: Record<RuntimeName, string[]> = {
    container: ['system', 'status'],
    podman: ['version', '--format', '{{.Client.Version}}'],
    docker: ['version', '--format', '{{.Server.Version}}'],
  }
  return (await runCommand(runtime, probe[runtime], env, 15_000)).code === 0
}

export function runtimeOrder(platform: NodeJS.Platform): RuntimeName[] {
  return platform === 'darwin' ? ['container', 'docker'] : ['podman', 'docker']
}

export async function detectRuntime(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Promise<RuntimeName | undefined> {
  for (const runtime of runtimeOrder(platform)) {
    if (await answers(runtime, env)) return runtime
  }
  return undefined
}

export async function runtimeAnswers(runtime: RuntimeName, env: NodeJS.ProcessEnv) {
  return answers(runtime, env)
}

export function installHint(platform: NodeJS.Platform): string {
  return platform === 'darwin'
    ? 'install Apple container (macOS 26 on Apple silicon) or Docker Desktop, OrbStack or Colima'
    : 'install Podman (rootless) or Docker'
}

export function daemonLabel(socketPath: string): string {
  return createHash('sha256').update(socketPath).digest('hex').slice(0, 16)
}

type SeccompRule = { names?: string[]; action?: string; args?: unknown[] }
type SeccompProfile = { syscalls?: SeccompRule[] }

export function allowChroot(profile: SeccompProfile): SeccompProfile {
  const syscalls = (profile.syscalls ?? [])
    .map((rule) => ({ ...rule, names: (rule.names ?? []).filter((name) => name !== 'chroot') }))
    .filter((rule) => rule.names.length > 0)
  return {
    ...profile,
    syscalls: [...syscalls, { names: ['chroot'], action: 'SCMP_ACT_ALLOW', args: [] }],
  }
}

async function defaultProfilePath(
  runtime: RuntimeName,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (runtime === 'podman') {
    const info = await runCommand(
      'podman',
      ['info', '--format', '{{.Host.Security.SECCOMPProfilePath}}'],
      env,
    )
    const path = info.stdout.trim()
    if (info.code === 0 && path) return path
  }
  if (runtime === 'docker') return '/usr/share/containers/seccomp.json'
  return undefined
}

export async function seccompProfile(
  runtime: RuntimeName,
  stateFolder: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (env.SCREENS_OCI_SECCOMP) return env.SCREENS_OCI_SECCOMP
  const base = await defaultProfilePath(runtime, env)
  if (!base) return undefined
  let profile: SeccompProfile
  try {
    profile = JSON.parse(await readFile(base, 'utf8')) as SeccompProfile
  } catch {
    return undefined
  }
  const path = join(stateFolder, `seccomp-${runtime}.json`)
  await writeFile(path, JSON.stringify(allowChroot(profile)), { mode: 0o600 })
  return path
}

export function containerName(id: string): string {
  return `screens-${id}`
}

export function runArguments(options: {
  runtime: RuntimeName
  id: string
  daemon: string
  image: string
  width: number
  height: number
  seccomp: string | undefined
}): string[] {
  const securityOptions =
    options.runtime === 'container'
      ? []
      : [
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '--read-only',
          '--pids-limit',
          '1024',
          ...(options.seccomp ? ['--security-opt', `seccomp=${options.seccomp}`] : []),
        ]
  return [
    'run',
    '-i',
    '--rm',
    '--init',
    '--name',
    containerName(options.id),
    '--label',
    `screens.id=${options.id}`,
    '--label',
    `screens.daemon=${options.daemon}`,
    '--network',
    'none',
    '--tmpfs',
    '/tmp:rw,size=1g,mode=1777',
    '--memory',
    '2g',
    '--cpus',
    '2',
    ...securityOptions,
    options.image,
    '--width',
    String(options.width),
    '--height',
    String(options.height),
  ]
}

export async function removeContainersOf(
  runtime: RuntimeName,
  daemon: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const listed = await runCommand(
    runtime,
    ['ps', '-aq', '--filter', 'label=screens.id', '--filter', `label=screens.daemon=${daemon}`],
    env,
  )
  const ids = listed.stdout.split('\n').filter(Boolean)
  if (ids.length > 0) await runCommand(runtime, ['rm', '-f', ...ids], env)
}
