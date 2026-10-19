import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { request } from './daemon-client.js'
import { readPackageVersion } from './paths.js'

export const toolsetMembers = [
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
] as const

export const maximumScreenshotSide = 1280

const coordinate = z.tuple([z.number().int(), z.number().int()])

const computerInput = {
  action: z.enum(toolsetMembers),
  coordinate: coordinate.optional(),
  start_coordinate: coordinate.optional(),
  text: z.string().optional(),
  scroll_direction: z.enum(['up', 'down', 'left', 'right']).optional(),
  scroll_amount: z.number().int().min(1).max(100).optional(),
  repeat: z.number().int().min(1).max(100).optional(),
  duration: z.number().min(0).max(300).optional(),
  region: z
    .tuple([z.number().int(), z.number().int(), z.number().int(), z.number().int()])
    .optional(),
}

type ComputerInput = {
  action: (typeof toolsetMembers)[number]
  coordinate?: [number, number] | undefined
  start_coordinate?: [number, number] | undefined
  text?: string | undefined
  scroll_direction?: 'up' | 'down' | 'left' | 'right' | undefined
  scroll_amount?: number | undefined
  repeat?: number | undefined
  duration?: number | undefined
  region?: [number, number, number, number] | undefined
}

class ToolError extends Error {}

function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] }
}

function done(text = 'OK'): CallToolResult {
  return { content: [{ type: 'text', text }] }
}

export async function runMcpServer(screenId: string, env: NodeJS.ProcessEnv): Promise<number> {
  const token = env.SCREENS_TOKEN ?? ''
  let scale: number | undefined

  async function call(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    const reply = await request({ ...message, id: screenId, token }, env, { startIfNeeded: true })
    if (!reply) throw new ToolError('the screens daemon is not running')
    if (!reply.ok) throw new ToolError(`${reply.code}: ${reply.message}`)
    return reply
  }

  async function screenScale(): Promise<number> {
    if (scale === undefined) {
      const size = await request({ verb: 'list' }, env, { startIfNeeded: true })
      const screens = (size?.ok ? size.screens : []) as {
        id: string
        width: number
        height: number
      }[]
      const screen = screens.find((entry) => entry.id === screenId)
      if (!screen) throw new ToolError(`no screen ${screenId}`)
      scale = Math.min(1, maximumScreenshotSide / Math.max(screen.width, screen.height))
    }
    return scale
  }

  async function toScreen(
    point: [number, number] | undefined,
  ): Promise<[number, number] | undefined> {
    if (point === undefined) return undefined
    const factor = await screenScale()
    return [Math.round(point[0] / factor), Math.round(point[1] / factor)]
  }

  function required<T>(value: T | undefined, name: string): T {
    if (value === undefined) throw new ToolError(`${name} is required for this action`)
    return value
  }

  async function picture(message: Record<string, unknown>): Promise<CallToolResult> {
    const factor = await screenScale()
    const reply = await call(factor < 1 ? { ...message, maxSide: maximumScreenshotSide } : message)
    return { content: [{ type: 'image', data: String(reply.png), mimeType: 'image/png' }] }
  }

  async function click(
    input: ComputerInput,
    button: 'left' | 'middle' | 'right',
    count: number,
    press: 'click' | 'down' | 'up' = 'click',
  ): Promise<CallToolResult> {
    await call({
      verb: 'click',
      at: await toScreen(input.coordinate),
      button,
      count,
      modifiers: input.text ?? '',
      press,
    })
    return done()
  }

  async function computer(input: ComputerInput): Promise<CallToolResult> {
    switch (input.action) {
      case 'screenshot':
        return picture({ verb: 'screenshot' })
      case 'zoom': {
        const [x0, y0, x1, y1] = required(input.region, 'region')
        const [left, top] = (await toScreen([x0, y0])) ?? [0, 0]
        const [right, bottom] = (await toScreen([x1, y1])) ?? [0, 0]
        return picture({ verb: 'zoom', region: [left, top, right, bottom] })
      }
      case 'left_click':
        return click(input, 'left', 1)
      case 'right_click':
        return click(input, 'right', 1)
      case 'middle_click':
        return click(input, 'middle', 1)
      case 'double_click':
        return click(input, 'left', 2)
      case 'triple_click':
        return click(input, 'left', 3)
      case 'left_mouse_down':
        return click({ action: input.action }, 'left', 1, 'down')
      case 'left_mouse_up':
        return click({ action: input.action }, 'left', 1, 'up')
      case 'left_click_drag':
        await call({
          verb: 'drag',
          from: await toScreen(required(input.start_coordinate, 'start_coordinate')),
          to: await toScreen(required(input.coordinate, 'coordinate')),
          modifiers: input.text ?? '',
        })
        return done()
      case 'mouse_move':
        await call({ verb: 'move', to: await toScreen(required(input.coordinate, 'coordinate')) })
        return done()
      case 'cursor_position': {
        const factor = await screenScale()
        const cursor = await call({ verb: 'cursor' })
        return done(
          `X=${Math.round(Number(cursor.x) * factor)}, Y=${Math.round(Number(cursor.y) * factor)}`,
        )
      }
      case 'scroll':
        await call({
          verb: 'scroll',
          direction: required(input.scroll_direction, 'scroll_direction'),
          amount: required(input.scroll_amount, 'scroll_amount'),
          at: await toScreen(input.coordinate),
          modifiers: input.text ?? '',
        })
        return done()
      case 'type':
        await call({ verb: 'type', text: required(input.text, 'text') })
        return done()
      case 'key':
        await call({ verb: 'key', keys: required(input.text, 'text'), repeat: input.repeat ?? 1 })
        return done()
      case 'hold_key':
        await call({
          verb: 'hold-key',
          keys: required(input.text, 'text'),
          duration: required(input.duration, 'duration'),
        })
        return done()
      case 'wait':
        await new Promise((resolve) =>
          setTimeout(resolve, required(input.duration, 'duration') * 1000),
        )
        return done()
    }
  }

  async function guarded(work: () => Promise<CallToolResult>): Promise<CallToolResult> {
    try {
      return await work()
    } catch (error) {
      if (error instanceof ToolError) return failure(error.message)
      return failure(`backend: ${(error as Error).message}`)
    }
  }

  const server = new McpServer({ name: 'screens', version: readPackageVersion() })
  server.registerTool(
    'computer',
    {
      description:
        "Look at and drive this screen: the actions and arguments of Anthropic's computer use toolset. Coordinates are in the pixel space of the screenshots this tool returns.",
      inputSchema: computerInput,
    },
    (input) => guarded(() => computer(input as ComputerInput)),
  )
  server.registerTool(
    'screen_launch',
    {
      description:
        'Start a program in this screen from an argv list (no shell). On a phone screen: one app package name.',
      inputSchema: { argv: z.array(z.string()).min(1) },
    },
    ({ argv }) =>
      guarded(async () => {
        const reply = await call({ verb: 'launch', argv })
        return done(reply.pid === undefined ? 'started' : `started pid ${reply.pid}`)
      }),
  )
  server.registerTool(
    'screen_windows',
    {
      description: 'List the visible windows of this screen.',
      inputSchema: {},
    },
    () =>
      guarded(async () => {
        const reply = await call({ verb: 'windows' })
        return done(JSON.stringify({ windows: reply.windows }))
      }),
  )
  await server.connect(new StdioServerTransport())
  await new Promise<void>((resolve) => {
    server.server.onclose = () => resolve()
  })
  return 0
}
