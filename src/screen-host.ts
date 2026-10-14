import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { isRecord } from './json-lines.js'
import { screensInitPath } from './paths.js'

export type ScreenHostConfig = {
  screenFolder: string
  linkFolder: string
  width: number
  height: number
  allowedDomains: string[]
  deniedFolders: string[]
  readableFolders: string[]
}

const stopGraceMs = 4_500

let wrap: ChildProcess | undefined
let wrapExited: Promise<void> = Promise.resolve()
let stopping = false

function quote(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`
}

function screenEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => ['PATH', 'LANG', 'LANGUAGE', 'TZ'].includes(name) || name.startsWith('LC_'),
    ),
  )
}

function nodeInstallFolder(): string {
  return dirname(dirname(realpathSync(process.execPath)))
}

async function start(config: ScreenHostConfig): Promise<void> {
  await SandboxManager.initialize(
    {
      network: {
        allowedDomains: config.allowedDomains,
        deniedDomains: [],
        allowAllUnixSockets: true,
        allowLocalBinding: true,
      },
      filesystem: {
        denyRead: config.deniedFolders.filter((folder) => existsSync(folder)),
        allowRead: [
          config.screenFolder,
          config.linkFolder,
          nodeInstallFolder(),
          ...config.readableFolders,
        ],
        allowWrite: [config.screenFolder],
        denyWrite: [],
      },
    },
    async () => false,
  )
  const command = [
    'exec',
    quote(process.execPath),
    quote(screensInitPath),
    '--link',
    quote(config.linkFolder),
    '--screen',
    quote(config.screenFolder),
    '--width',
    String(config.width),
    '--height',
    String(config.height),
  ].join(' ')
  const wrapped = await SandboxManager.wrapWithSandbox(command)
  const child = spawn('/bin/bash', ['-c', `exec ${wrapped}`], {
    env: screenEnvironment(),
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  wrap = child
  wrapExited = new Promise((resolve) => child.on('exit', () => resolve()))
  child.on('exit', (code, signal) => {
    process.send?.({ type: 'wrap-exited', code, signal })
  })
  process.send?.({ type: 'started', wrapPid: child.pid })
}

async function stop(): Promise<never> {
  if (!stopping) {
    stopping = true
    const graceOver = new Promise((resolve) => setTimeout(resolve, stopGraceMs))
    await Promise.race([wrapExited, graceOver])
    if (wrap && wrap.exitCode === null && wrap.signalCode === null) {
      wrap.kill('SIGKILL')
      await wrapExited
    }
    SandboxManager.cleanupAfterCommand()
    await SandboxManager.reset()
  }
  process.exit(0)
}

process.on('message', (message: unknown) => {
  if (!isRecord(message)) return
  if (message.type === 'start') {
    start(message.config as ScreenHostConfig).catch((error: Error) => {
      process.send?.({ type: 'failed', message: error.message })
    })
  } else if (message.type === 'stop') {
    void stop()
  }
})

process.on('disconnect', () => {
  wrap?.kill('SIGKILL')
  process.exit(1)
})
process.on('SIGTERM', () => void stop())
