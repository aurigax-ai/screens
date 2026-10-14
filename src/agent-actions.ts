import { characterKeysym } from './keys.js'
import { RequestError } from './protocol.js'
import type { Screen } from './screen.js'

export type Point = { x: number; y: number }
export type Button = 'left' | 'middle' | 'right'
export type Direction = 'up' | 'down' | 'left' | 'right'

const buttonMasks: Record<Button, number> = { left: 1, middle: 2, right: 4 }
const wheelMasks: Record<Direction, number> = { up: 8, down: 16, left: 32, right: 64 }
const stepMs = 15
const dragSteps = 8

const queues = new WeakMap<Screen, Promise<unknown>>()

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function exclusive<T>(screen: Screen, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(screen) ?? Promise.resolve()
  const next = previous.then(() => {
    if (screen.owner !== 'agent') throw new RequestError('refused', 'human-owns-input')
    return work()
  })
  queues.set(
    screen,
    next.catch(() => {}),
  )
  return next
}

function pressKeys(screen: Screen, keysyms: number[]): void {
  for (const keysym of keysyms) screen.key(keysym, true)
}

function releaseKeys(screen: Screen, keysyms: number[]): void {
  for (const keysym of [...keysyms].reverse()) screen.key(keysym, false)
}

async function withModifiers(screen: Screen, modifiers: number[], work: () => Promise<void>) {
  pressKeys(screen, modifiers)
  try {
    await work()
  } finally {
    releaseKeys(screen, modifiers)
  }
}

export function click(
  screen: Screen,
  options: {
    at: Point | undefined
    button: Button
    count: number
    modifiers: number[]
    modifierNames: string
    press: 'click' | 'down' | 'up'
  },
): Promise<void> {
  return exclusive(screen, async () => {
    const at = options.at ?? screen.cursor
    const mask = buttonMasks[options.button]
    await withModifiers(screen, options.modifiers, async () => {
      const held = screen.pressedButtons
      screen.pointer(at.x, at.y, held)
      if (options.press === 'down') {
        screen.pointer(at.x, at.y, held | mask)
        return
      }
      if (options.press === 'up') {
        screen.pointer(at.x, at.y, held & ~mask)
        return
      }
      for (let index = 0; index < options.count; index++) {
        screen.pointer(at.x, at.y, held | mask)
        await pause(stepMs)
        screen.pointer(at.x, at.y, held & ~mask)
        await pause(stepMs)
      }
    })
    screen.log.add(options.press === 'click' ? 'click' : `mouse-${options.press}`, {
      x: at.x,
      y: at.y,
      button: options.button,
      count: options.count,
      ...(options.modifierNames ? { modifiers: options.modifierNames } : {}),
    })
  })
}

export function move(screen: Screen, to: Point): Promise<void> {
  return exclusive(screen, async () => {
    screen.pointer(to.x, to.y, screen.pressedButtons)
    screen.log.add('move', { x: to.x, y: to.y })
  })
}

export function drag(
  screen: Screen,
  from: Point,
  to: Point,
  modifiers: number[],
  modifierNames: string,
): Promise<void> {
  return exclusive(screen, async () => {
    await withModifiers(screen, modifiers, async () => {
      screen.pointer(from.x, from.y, 0)
      await pause(stepMs)
      screen.pointer(from.x, from.y, buttonMasks.left)
      await pause(stepMs)
      for (let step = 1; step <= dragSteps; step++) {
        const x = Math.round(from.x + ((to.x - from.x) * step) / dragSteps)
        const y = Math.round(from.y + ((to.y - from.y) * step) / dragSteps)
        screen.pointer(x, y, buttonMasks.left)
        await pause(stepMs)
      }
      screen.pointer(to.x, to.y, 0)
    })
    screen.log.add('drag', {
      from: [from.x, from.y],
      to: [to.x, to.y],
      ...(modifierNames ? { modifiers: modifierNames } : {}),
    })
  })
}

export function scroll(
  screen: Screen,
  options: {
    at: Point | undefined
    direction: Direction
    amount: number
    modifiers: number[]
    modifierNames: string
  },
): Promise<void> {
  return exclusive(screen, async () => {
    const at = options.at ?? screen.cursor
    const mask = wheelMasks[options.direction]
    await withModifiers(screen, options.modifiers, async () => {
      screen.pointer(at.x, at.y, 0)
      for (let index = 0; index < options.amount; index++) {
        screen.pointer(at.x, at.y, mask)
        screen.pointer(at.x, at.y, 0)
        await pause(stepMs)
      }
    })
    screen.log.add('scroll', {
      x: at.x,
      y: at.y,
      direction: options.direction,
      amount: options.amount,
      ...(options.modifierNames ? { modifiers: options.modifierNames } : {}),
    })
  })
}

export function type(screen: Screen, text: string): Promise<void> {
  return exclusive(screen, async () => {
    for (const character of text) {
      const keysym = characterKeysym(character)
      screen.key(keysym, true)
      screen.key(keysym, false)
    }
    screen.log.add('type', { length: [...text].length })
  })
}

export function key(
  screen: Screen,
  combinations: number[][],
  names: string,
  repeat: number,
): Promise<void> {
  return exclusive(screen, async () => {
    for (let round = 0; round < repeat; round++) {
      for (const combination of combinations) {
        pressKeys(screen, combination)
        releaseKeys(screen, combination)
        await pause(stepMs)
      }
    }
    screen.log.add('key', { keys: names, repeat })
  })
}

export function holdKey(
  screen: Screen,
  combination: number[],
  names: string,
  seconds: number,
): Promise<void> {
  return exclusive(screen, async () => {
    pressKeys(screen, combination)
    try {
      await pause(seconds * 1000)
    } finally {
      releaseKeys(screen, combination)
    }
    screen.log.add('hold-key', { keys: names, duration: seconds })
  })
}
