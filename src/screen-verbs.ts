import { basename } from 'node:path'
import {
  type Button,
  click,
  type Direction,
  drag,
  holdKey,
  key,
  move,
  type Point,
  scroll,
  type,
} from './agent-actions.js'
import { crop, fitWithin, type Raster, resize } from './image.js'
import { isStringArray } from './json-lines.js'
import { KeyNameError, parseCombination, parseKeys, parseModifiers } from './keys.js'
import { encodePng } from './png.js'
import { RequestError } from './protocol.js'
import type { Screen } from './screen.js'

export type Request = Record<string, unknown>
export type Body = Record<string, unknown>
export type Area = { width: number; height: number }

export const maximumHoldSeconds = 300
export const maximumRepeat = 100
export const maximumScrollAmount = 100

export function usage(message: string): never {
  throw new RequestError('usage', message)
}

export function wholeNumber(
  request: Request,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const value = request[name]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    usage(`${name} must be a whole number from ${minimum} to ${maximum}`)
  }
  return value
}

export function optionalWholeNumber(
  request: Request,
  name: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  return request[name] === undefined ? fallback : wholeNumber(request, name, minimum, maximum)
}

export function pointOn(screen: Area, value: unknown, name: string): Point {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every((coordinate) => Number.isInteger(coordinate))
  ) {
    usage(`${name} must be [x, y]`)
  }
  const [x, y] = value as number[]
  if (
    x === undefined ||
    y === undefined ||
    x < 0 ||
    y < 0 ||
    x >= screen.width ||
    y >= screen.height
  ) {
    usage(`${name} must lie on the ${screen.width}x${screen.height} screen`)
  }
  return { x, y }
}

export function optionalPoint(screen: Area, request: Request, name: string): Point | undefined {
  return request[name] === undefined ? undefined : pointOn(screen, request[name], name)
}

export function text(request: Request, name: string, allowEmpty = false): string {
  const value = request[name]
  if (typeof value !== 'string' || (!allowEmpty && value === '')) usage(`${name} must be text`)
  return value
}

function keysOf<T>(parse: (value: string) => T, value: string): T {
  try {
    return parse(value)
  } catch (error) {
    if (error instanceof KeyNameError) usage(error.message)
    throw error
  }
}

export function oneOf<T extends string>(
  request: Request,
  name: string,
  values: T[],
  fallback?: T,
): T {
  const value = request[name] ?? fallback
  if (typeof value !== 'string' || !values.includes(value as T)) {
    usage(`${name} must be one of ${values.join(', ')}`)
  }
  return value as T
}

export async function picture(raster: Raster, boxWidth: number, boxHeight: number): Promise<Body> {
  const size = fitWithin(raster.width, raster.height, boxWidth, boxHeight)
  const sized = resize(raster, size.width, size.height)
  return {
    width: sized.width,
    height: sized.height,
    png: (await encodePng(sized.width, sized.height, sized.rgbx)).toString('base64'),
  }
}

export function outputBox(screen: Area, request: Request): Area {
  const maxSide = optionalWholeNumber(
    request,
    'maxSide',
    16,
    8192,
    Math.max(screen.width, screen.height),
  )
  return fitWithin(
    screen.width,
    screen.height,
    Math.min(maxSide, screen.width),
    Math.min(maxSide, screen.height),
  )
}

export function regionOn(screen: Area, request: Request): [number, number, number, number] {
  const region = request.region
  if (!Array.isArray(region) || region.length !== 4 || !region.every(Number.isInteger)) {
    usage('region must be [x0, y0, x1, y1]')
  }
  const [x0, y0, x1, y1] = region as [number, number, number, number]
  if (x0 < 0 || y0 < 0 || x1 > screen.width || y1 > screen.height || x0 >= x1 || y0 >= y1) {
    usage(`region must be a rectangle on the ${screen.width}x${screen.height} screen`)
  }
  return [x0, y0, x1, y1]
}

type Window = { id: number; name: string; x: number; y: number; width: number; height: number }

async function xdotool(screen: Screen, args: string[]): Promise<string> {
  const result = await screen.run(['xdotool', ...args])
  return result.code === 0 ? result.stdout : ''
}

async function windows(screen: Screen): Promise<Window[]> {
  const ids = (await xdotool(screen, ['search', '--onlyvisible', '--name', '']))
    .split('\n')
    .filter((line) => /^\d+$/.test(line))
  const found: Window[] = []
  for (const id of ids) {
    const name = (await xdotool(screen, ['getwindowname', id])).replace(/\n$/, '')
    const geometry = Object.fromEntries(
      (await xdotool(screen, ['getwindowgeometry', '--shell', id]))
        .split('\n')
        .map((line) => line.split('='))
        .filter((pair) => pair.length === 2),
    )
    found.push({
      id: Number(id),
      name,
      x: Number(geometry.X ?? 0),
      y: Number(geometry.Y ?? 0),
      width: Number(geometry.WIDTH ?? 0),
      height: Number(geometry.HEIGHT ?? 0),
    })
  }
  return found
}

export const screenVerbs: Record<string, (screen: Screen, request: Request) => Promise<Body>> = {
  async screenshot(screen, request) {
    const box = outputBox(screen, request)
    return picture(await screen.frame(), box.width, box.height)
  },

  async zoom(screen, request) {
    const [x0, y0, x1, y1] = regionOn(screen, request)
    const box = outputBox(screen, request)
    return picture(crop(await screen.frame(), x0, y0, x1, y1), box.width, box.height)
  },

  async click(screen, request) {
    const modifierNames = text(request, 'modifiers', true)
    await click(screen, {
      at: optionalPoint(screen, request, 'at'),
      button: oneOf<Button>(request, 'button', ['left', 'middle', 'right'], 'left'),
      count: optionalWholeNumber(request, 'count', 1, 3, 1),
      modifiers: keysOf(parseModifiers, modifierNames),
      modifierNames,
      press: oneOf(request, 'press', ['click', 'down', 'up'], 'click'),
    })
    return {}
  },

  async move(screen, request) {
    await move(screen, pointOn(screen, request.to, 'to'))
    return {}
  },

  async drag(screen, request) {
    const modifierNames = text(request, 'modifiers', true)
    await drag(
      screen,
      pointOn(screen, request.from, 'from'),
      pointOn(screen, request.to, 'to'),
      keysOf(parseModifiers, modifierNames),
      modifierNames,
    )
    return {}
  },

  async scroll(screen, request) {
    const modifierNames = text(request, 'modifiers', true)
    await scroll(screen, {
      at: optionalPoint(screen, request, 'at'),
      direction: oneOf<Direction>(request, 'direction', ['up', 'down', 'left', 'right']),
      amount: wholeNumber(request, 'amount', 1, maximumScrollAmount),
      modifiers: keysOf(parseModifiers, modifierNames),
      modifierNames,
    })
    return {}
  },

  async type(screen, request) {
    await type(screen, text(request, 'text'))
    return {}
  },

  async key(screen, request) {
    const keys = text(request, 'keys')
    await key(
      screen,
      keysOf(parseKeys, keys),
      keys,
      optionalWholeNumber(request, 'repeat', 1, maximumRepeat, 1),
    )
    return {}
  },

  async 'hold-key'(screen, request) {
    const keys = text(request, 'keys')
    const duration = request.duration
    if (typeof duration !== 'number' || duration < 0 || duration > maximumHoldSeconds) {
      usage(`duration must be from 0 to ${maximumHoldSeconds} seconds`)
    }
    await holdKey(screen, keysOf(parseCombination, keys), keys, duration)
    return {}
  },

  async cursor(screen) {
    return { x: screen.cursor.x, y: screen.cursor.y }
  },

  async launch(screen, request) {
    if (!isStringArray(request.argv) || request.argv.length === 0) usage('launch needs a program')
    const pid = await screen.launch(request.argv)
    screen.log.add('launch', { program: basename(request.argv[0] ?? '') })
    return { pid }
  },

  async windows(screen) {
    return { windows: await windows(screen) }
  },

  async focus(screen, request) {
    const window = text(request, 'window')
    if (!/^\d+$/.test(window)) usage('window must be a window id')
    const result = await screen.run(['xdotool', 'windowraise', window, 'windowfocus', window])
    if (result.code !== 0) throw new RequestError('not-found', `no window ${window}`)
    screen.log.add('focus', { window: Number(window) })
    return {}
  },

  async log(screen) {
    return { entries: screen.log.list() }
  },

  async apps() {
    throw new RequestError('unsupported', 'apps works on phone screens only')
  },

  async tree() {
    throw new RequestError('unsupported', 'tree works on phone screens only')
  },
}
