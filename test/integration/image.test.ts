import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'
import {
  type Created,
  containerName,
  createSandbox,
  daemonLabel,
  runtimeCli,
  type Sandbox,
  testImage,
} from './harness.js'

let sandbox: Sandbox
let registryPort: number
let registriesConf: string
const registryName = `screens-test-registry-${process.pid}`
const testRepository = () => `localhost:${registryPort}/screens-desktop-test`
const pulled: string[] = []
const registryImage = 'docker.io/library/registry:2'
let registryImageWasPresent = false

function freePort(): Promise<number> {
  return new Promise((resolvePort) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolvePort(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

async function registry(args: string[]) {
  const result = await runtimeCli(args, {
    ...process.env,
    CONTAINERS_REGISTRIES_CONF: registriesConf,
  })
  if (result.code !== 0) throw new Error(`${args.join(' ')}: ${result.stderr}`)
  return result.stdout.toString().trim()
}

async function pushAs(source: string, tag: string): Promise<string> {
  const target = `${testRepository()}:${tag}`
  await registry(['tag', source, target])
  const digestFile = join(process.env.TMPDIR ?? '/tmp', `screens-test-digest-${process.pid}`)
  await registry(['push', '--tls-verify=false', '--digestfile', digestFile, target])
  const digest = (await readFile(digestFile, 'utf8')).trim()
  await rm(digestFile, { force: true })
  await registry(['rmi', target])
  return digest
}

beforeAll(async () => {
  registryPort = await freePort()
  registriesConf = join(process.env.TMPDIR ?? '/tmp', `screens-test-registries-${process.pid}.conf`)
  await writeFile(
    registriesConf,
    `[[registry]]\nlocation = "localhost:${registryPort}"\ninsecure = true\n`,
  )
  registryImageWasPresent = await registry(['image', 'exists', registryImage])
    .then(() => true)
    .catch(() => false)
  await registry([
    'run',
    '-d',
    '--rm',
    '--name',
    registryName,
    '--label',
    'screens.test=registry',
    '-p',
    `127.0.0.1:${registryPort}:5000`,
    registryImage,
  ])
  for (let attempt = 0; attempt < 50; attempt++) {
    const probe = await fetch(`http://127.0.0.1:${registryPort}/v2/`).catch(() => undefined)
    if (probe?.ok) break
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200))
  }
}, 120_000)

afterAll(async () => {
  await registry(['rm', '-f', registryName]).catch(() => undefined)
  if (!registryImageWasPresent) await registry(['rmi', registryImage]).catch(() => undefined)
  await rm(registriesConf, { force: true })
})

beforeEach(async () => {
  sandbox = await createSandbox()
  sandbox.env.CONTAINERS_REGISTRIES_CONF = registriesConf
})

afterEach(async () => {
  await sandbox.cleanup()
  for (const reference of pulled.splice(0)) {
    await runtimeCli(['rmi', '-f', reference], sandbox.env)
  }
})

async function create(pinned: string) {
  return sandbox.screens(['create', '--backend', 'oci', '--json'], {
    env: { SCREENS_OCI_IMAGE: pinned },
  })
}

test('CON-C15 without the image create pulls the pinned digest with progress on stderr and starts the screen', async () => {
  const digest = await pushAs(testImage, 'c15')
  const pinned = `${testRepository()}@${digest}`
  pulled.push(pinned)
  expect((await runtimeCli(['image', 'exists', pinned], sandbox.env)).code).not.toBe(0)
  const result = await create(pinned)
  expect(result.code, result.stderr).toBe(0)
  expect(result.stderr).toMatch(/pull/i)
  expect(result.stderr).toMatch(/Copying|Writing manifest|Storing signatures|Getting image source/)
  const screen = JSON.parse(result.stdout.toString()) as Created
  const running = await runtimeCli(
    ['inspect', containerName(screen), '--format', '{{.ImageName}}'],
    sandbox.env,
  )
  expect(running.stdout.toString().trim()).toBe(pinned)
})

test('CON-C16 when the tag moved to other content the container runs the pinned digest', async () => {
  const pinnedId = await registry(['image', 'inspect', testImage, '--format', '{{.Id}}'])
  const pinnedDigest = await pushAs(testImage, 'moving')
  const other = `localhost/screens-desktop-test-other:${process.pid}`
  const context = join(sandbox.root, 'other')
  await mkdir(context)
  await writeFile(join(context, 'Containerfile'), `FROM ${testImage}\nLABEL screens.test=other\n`)
  await registry(['build', '-t', other, context])
  const otherId = await registry(['image', 'inspect', other, '--format', '{{.Id}}'])
  const movedDigest = await pushAs(other, 'moving')
  await registry(['rmi', other])
  expect(movedDigest).not.toBe(pinnedDigest)
  const pinned = `${testRepository()}@${pinnedDigest}`
  pulled.push(pinned)
  const result = await create(pinned)
  expect(result.code, result.stderr).toBe(0)
  const screen = JSON.parse(result.stdout.toString()) as Created
  const running = await runtimeCli(
    ['inspect', containerName(screen), '--format', '{{.Image}}'],
    sandbox.env,
  )
  expect(running.stdout.toString().trim()).toBe(pinnedId)
  expect(running.stdout.toString().trim()).not.toBe(otherId)
})

test('CON-C17 with no registry and no local image create exits 5 saying the pull failed and nothing runs', async () => {
  const unreachable = await freePort()
  const pinned = `localhost:${unreachable}/screens-desktop-test@sha256:${'0'.repeat(64)}`
  const result = await create(pinned)
  expect(result.code).toBe(5)
  expect(result.stderr).toMatch(/pull/i)
  expect(result.stderr).toMatch(/fail/i)
  expect(
    (await readdir(sandbox.stateDir)).filter((entry) => !entry.startsWith('seccomp-')),
  ).toEqual([])
  const label = `label=screens.daemon=${daemonLabel(join(sandbox.socketDir, 'daemon.sock'))}`
  const listed = await runtimeCli(['ps', '-aq', '--filter', label], sandbox.env)
  expect(listed.stdout.toString().trim()).toBe('')
  const daemon = await sandbox.screensJson<{ screens: unknown[] }>(['list'])
  expect(daemon.screens).toEqual([])
})
