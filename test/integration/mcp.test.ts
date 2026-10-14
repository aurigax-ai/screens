import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  type Created,
  cliPath,
  createSandbox,
  createScreen,
  decodePng,
  type EchoServer,
  type Sandbox,
  startEchoServer,
} from './harness.js'

const toolsetMembers = [
  'screenshot',
  'zoom',
  'left_click',
  'right_click',
  'middle_click',
  'double_click',
  'triple_click',
  'left_click_drag',
  'mouse_move',
  'left_mouse_down',
  'left_mouse_up',
  'cursor_position',
  'scroll',
  'type',
  'key',
  'hold_key',
  'wait',
]

let sandbox: Sandbox
let echo: EchoServer
const clients: Client[] = []

beforeEach(async () => {
  sandbox = await createSandbox()
  echo = await startEchoServer()
})

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
  echo.close()
  await sandbox.cleanup()
})

async function connectMcp(screen: Created, token: string | undefined): Promise<Client> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(sandbox.env)) {
    if (value !== undefined) env[name] = value
  }
  if (token !== undefined) env.SCREENS_TOKEN = token
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, 'mcp', '--screen', screen.id],
    env,
    stderr: 'ignore',
  })
  const client = new Client({ name: 'screens-test', version: '1.0.0' })
  await client.connect(transport)
  clients.push(client)
  return client
}

type ToolContent = { type: string; text?: string; data?: string; mimeType?: string }

function content(result: unknown): ToolContent[] {
  return (result as { content: ToolContent[] }).content
}

test('SCR-C33 the MCP computer tool matches the toolset and a click lands at the scaled coordinate', async () => {
  const screen = await createScreen(sandbox, [
    '--width',
    '1600',
    '--height',
    '1000',
    '--allow',
    'localhost',
  ])
  const client = await connectMcp(screen, screen.agentToken)

  const { tools } = await client.listTools()
  expect(tools.map((tool) => tool.name).sort()).toEqual([
    'computer',
    'screen_launch',
    'screen_windows',
  ])
  const computer = tools.find((tool) => tool.name === 'computer')
  const properties = computer?.inputSchema.properties as Record<string, Record<string, unknown>>
  expect([...((properties.action?.enum as string[] | undefined) ?? [])].sort()).toEqual(
    [...toolsetMembers].sort(),
  )
  expect(Object.keys(properties).sort()).toEqual(
    [
      'action',
      'coordinate',
      'duration',
      'region',
      'repeat',
      'scroll_amount',
      'scroll_direction',
      'start_coordinate',
      'text',
    ].sort(),
  )
  expect(properties.scroll_direction?.enum).toEqual(['up', 'down', 'left', 'right'])
  expect(computer?.inputSchema.required).toEqual(['action'])

  const launched = await client.callTool({
    name: 'screen_launch',
    arguments: { argv: ['google-chrome-stable', '--kiosk', echo.url] },
  })
  expect(launched.isError).toBeFalsy()
  await echo.waitForEvent(
    (event) => event.type === 'size' && Number(event.width) >= 1599 && Number(event.height) >= 999,
    20_000,
  )

  const shot = await client.callTool({ name: 'computer', arguments: { action: 'screenshot' } })
  expect(shot.isError).toBeFalsy()
  const [image] = content(shot)
  expect(image?.type).toBe('image')
  expect(image?.mimeType).toBe('image/png')
  const decoded = decodePng(Buffer.from(image?.data ?? '', 'base64'))
  expect([decoded.width, decoded.height]).toEqual([1280, 800])

  const click = await client.callTool({
    name: 'computer',
    arguments: { action: 'left_click', coordinate: [400, 240] },
  })
  expect(click.isError).toBeFalsy()
  await echo.waitForEvent((event) => event.type === 'click' && event.x === 500 && event.y === 300)

  const cursor = await client.callTool({
    name: 'computer',
    arguments: { action: 'cursor_position' },
  })
  expect(content(cursor)[0]?.text).toBe('X=400, Y=240')

  const zoom = await client.callTool({
    name: 'computer',
    arguments: { action: 'zoom', region: [0, 0, 640, 400] },
  })
  const [zoomed] = content(zoom)
  expect(zoomed?.type).toBe('image')
  const zoomImage = decodePng(Buffer.from(zoomed?.data ?? '', 'base64'))
  expect([zoomImage.width, zoomImage.height]).toEqual([1280, 800])

  const typed = await client.callTool({
    name: 'computer',
    arguments: { action: 'type', text: 'ok' },
  })
  expect(typed.isError).toBeFalsy()

  const windows = await client.callTool({ name: 'screen_windows', arguments: {} })
  expect(windows.isError).toBeFalsy()
  expect(content(windows)[0]?.text).toMatch(/"windows"/)
})

test('SCR-C34 MCP without a valid SCREENS_TOKEN returns a tool error and leaves the screen untouched', async () => {
  const screen = await createScreen(sandbox)
  for (const token of [undefined, 'f'.repeat(64)]) {
    const client = await connectMcp(screen, token)
    for (const call of [
      { action: 'left_click', coordinate: [10, 10] },
      { action: 'type', text: 'secret' },
      { action: 'screenshot' },
    ]) {
      const result = await client.callTool({ name: 'computer', arguments: call })
      expect(result.isError, `${call.action} with token ${token}`).toBe(true)
    }
    const launched = await client.callTool({
      name: 'screen_launch',
      arguments: { argv: ['true'] },
    })
    expect(launched.isError).toBe(true)
  }
  const log = await sandbox.screensJson<{ entries: unknown[] }>([
    'log',
    screen.id,
    '--token',
    screen.agentToken,
  ])
  expect(log.entries).toEqual([])
})
