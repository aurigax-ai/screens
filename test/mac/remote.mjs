import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { join } from 'node:path'

const packageDist = join(process.cwd(), 'node_modules', '@aurigax-ai', 'screens', 'dist')
const { RfbClient } = await import(join(packageDist, 'rfb-client.js'))
const { socketPath } = await import(join(packageDist, 'paths.js'))
const cli = join(packageDist, 'cli.js')
const results = {}

function screens(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    const out = []
    let stderr = ''
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out), stderr }))
  })
}

async function openViewer(id, token) {
  const socket = connect(socketPath(process.env))
  await new Promise((resolve) => socket.once('connect', resolve))
  socket.write(`${JSON.stringify({ verb: 'view', id, token })}\n`)
  const reply = await new Promise((resolve) => {
    let pending = Buffer.alloc(0)
    const onData = (chunk) => {
      pending = Buffer.concat([pending, chunk])
      const newline = pending.indexOf(10)
      if (newline < 0) return
      socket.off('data', onData)
      socket.pause()
      const rest = pending.subarray(newline + 1)
      if (rest.length > 0) socket.unshift(rest)
      resolve(JSON.parse(pending.subarray(0, newline).toString()))
    }
    socket.on('data', onData)
  })
  const connecting = RfbClient.connect(socket)
  socket.resume()
  return { id: reply.viewer, rfb: await connecting, socket }
}

try {
  const created = await screens(['create', '--backend', 'oci', '--runtime', 'docker', '--json'])
  results.create = created.code
  if (created.code !== 0) throw new Error(created.stderr)
  const screen = JSON.parse(created.stdout.toString())
  const token = ['--token', screen.agentToken]
  const shot = await screens(['screenshot', screen.id, ...token])
  results.screenshot = shot.code === 0 && shot.stdout.subarray(1, 4).toString() === 'PNG' ? 0 : 1
  results.click = (await screens(['click', screen.id, '100', '100', ...token])).code
  results.type = (await screens(['type', screen.id, 'hello', ...token])).code
  const viewer = await openViewer(screen.id, screen.viewerToken)
  results.takeover = (
    await screens(['takeover', screen.id, viewer.id, '--token', screen.viewerToken])
  ).code
  results.refusedWhileHuman = (await screens(['click', screen.id, '10', '10', ...token])).code
  results.giveback = (
    await screens(['giveback', screen.id, viewer.id, '--token', screen.viewerToken])
  ).code
  viewer.socket.destroy()
  results.stop = (await screens(['stop', screen.id, ...token])).code
} catch (error) {
  results.error = String(error)
} finally {
  await screens(['daemon', 'stop'])
  process.stdout.write(`${JSON.stringify(results)}\n`)
}
