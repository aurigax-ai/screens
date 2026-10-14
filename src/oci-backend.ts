import { type ChildProcess, fork, spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import {
  BackendError,
  type BackendEvents,
  type ScreenBackend,
  waitForExit,
  withTimeout,
} from './backend.js'
import { isRecord, onJsonLines, writeJsonLine } from './json-lines.js'
import { Mux } from './mux.js'
import { containerName, type RuntimeName, runArguments, runCommand } from './oci-runtime.js'
import { screenHostPath } from './paths.js'
import type { ScreenHostConfig } from './screen-host.js'

const proxyStartTimeoutMs = 15_000
const containerStopGraceMs = 4_000
const hostExitTimeoutMs = 2_000

export type OciOptions = {
  id: string
  folder: string
  width: number
  height: number
  allowedDomains: string[]
  runtime: RuntimeName
  image: string
  seccomp: string | undefined
  daemon: string
  env: NodeJS.ProcessEnv
}

export class OciBackend implements ScreenBackend {
  readonly name = 'oci'
  private readonly bridgeFolder: string
  private host: ChildProcess | undefined
  private hostExited: Promise<void> = Promise.resolve()
  private container: ChildProcess | undefined
  private containerExited: Promise<void> = Promise.resolve()
  private mux: Mux | undefined

  constructor(private readonly options: OciOptions) {
    this.bridgeFolder = join(options.folder, 'bridge')
  }

  get runtime(): string {
    return this.options.runtime
  }

  async start(events: BackendEvents): Promise<void> {
    await mkdir(this.options.folder, { mode: 0o700 })
    await mkdir(this.bridgeFolder, { mode: 0o700 })
    const log = createWriteStream(join(this.options.folder, 'screen.log'), { flags: 'a' })
    const proxy = await this.startProxy(events, log)
    const container = spawn(
      this.options.runtime,
      runArguments({
        runtime: this.options.runtime,
        id: this.options.id,
        daemon: this.options.daemon,
        image: this.options.image,
        width: this.options.width,
        height: this.options.height,
        seccomp: this.options.seccomp,
      }),
      { env: this.options.env, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    this.container = container
    this.containerExited = new Promise((resolve) => container.once('exit', () => resolve()))
    container.stderr.pipe(log)
    container.on('error', (error) =>
      events.gone(`${this.options.runtime} failed: ${error.message}`),
    )
    container.once('exit', (code) => events.gone(`the container exited (${code})`))
    container.stdin.on('error', () => {})
    const mux = new Mux(container.stdout, container.stdin, {
      side: 'daemon',
      acceptKinds: ['proxy'],
    })
    this.mux = mux
    mux.on('failure', (reason) => events.gone(`the screen broke the stream: ${reason}`))
    mux.on('channel', (channel) => {
      const upstream = connect(proxy.port, 'localhost')
      channel.pipe(upstream)
      upstream.pipe(channel)
      upstream.on('error', () => channel.destroy())
      channel.on('error', () => upstream.destroy())
      upstream.on('close', () => channel.destroy())
      channel.on('close', () => upstream.destroy())
    })
    onJsonLines(mux.control, (message) => {
      if (isRecord(message)) events.message(message)
    })
    this.send({ type: 'proxy', url: `http://screens:${proxy.token}@proxy/` })
  }

  private startProxy(
    events: BackendEvents,
    log: NodeJS.WritableStream,
  ): Promise<{ port: number; token: string }> {
    const host = fork(screenHostPath, [], {
      cwd: this.bridgeFolder,
      env: { ...process.env, TMPDIR: this.bridgeFolder },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    host.stdout?.pipe(log)
    host.stderr?.pipe(log)
    this.host = host
    this.hostExited = new Promise((resolve) => host.once('exit', () => resolve()))
    const ready = new Promise<{ port: number; token: string }>((resolve, reject) => {
      host.on('message', (message: unknown) => {
        if (!isRecord(message)) return
        if (
          message.type === 'proxy' &&
          typeof message.port === 'number' &&
          typeof message.token === 'string'
        ) {
          resolve({ port: message.port, token: message.token })
        } else if (message.type === 'failed') {
          reject(new BackendError(`network proxy failed: ${String(message.message)}`))
        } else if (
          message.type === 'ask' &&
          typeof message.requestId === 'number' &&
          typeof message.host === 'string'
        ) {
          const requestId = message.requestId
          void events
            .ask(message.host, typeof message.port === 'number' ? message.port : undefined)
            .then((allow) => {
              if (host.connected) host.send({ type: 'answer', requestId, allow })
            })
        }
      })
      host.once('exit', () => {
        reject(new BackendError('the network proxy exited'))
        events.gone('the network proxy exited')
      })
    })
    const config: ScreenHostConfig = {
      mode: 'proxy',
      screenFolder: '',
      linkFolder: '',
      width: this.options.width,
      height: this.options.height,
      allowedDomains: this.options.allowedDomains,
      deniedFolders: [],
      readableFolders: [],
    }
    host.send({ type: 'start', config })
    return withTimeout(ready, proxyStartTimeoutMs, 'network proxy start')
  }

  send(message: Record<string, unknown>): void {
    if (this.mux) writeJsonLine(this.mux.control, message)
  }

  async openRelay(): Promise<Duplex> {
    if (!this.mux) throw new BackendError('screen is not connected')
    return this.mux.open('rfb')
  }

  async stop(): Promise<void> {
    if (this.host?.connected) this.host.send({ type: 'stop' })
    const containerGone = waitForExit(this.containerExited, containerStopGraceMs).then(
      async (exited) => {
        if (exited) return
        await runCommand(
          this.options.runtime,
          ['rm', '-f', containerName(this.options.id)],
          this.options.env,
          2_000,
        )
        this.container?.kill('SIGKILL')
        await waitForExit(this.containerExited, 500)
      },
    )
    const hostGone = waitForExit(this.hostExited, hostExitTimeoutMs).then((exited) => {
      if (!exited) this.host?.kill('SIGKILL')
    })
    await Promise.all([containerGone, hostGone])
    this.container?.stdin?.destroy()
    await rm(this.options.folder, { recursive: true, force: true })
  }
}
