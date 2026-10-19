import jpeg from 'jpeg-js'
import { crop, type Raster } from './image.js'
import { isStringArray } from './json-lines.js'
import type { PhoneScreen } from './phone-screen.js'
import { RequestError } from './protocol.js'
import {
  type Body,
  maximumRepeat,
  maximumScrollAmount,
  oneOf,
  optionalPoint,
  optionalWholeNumber,
  outputBox,
  picture,
  pointOn,
  type Request,
  regionOn,
  text,
  usage,
  wholeNumber,
} from './screen-verbs.js'

const captureSideMax = 1600
const captureSideMin = 64
const holdMsMax = 3000
const typedMax = 4000
const scrollStep = 0.1
const packageName = /^[A-Za-z][\w]*(\.[A-Za-z][\w]*)+$/

const phoneKeys: Record<string, string> = {
  escape: 'back',
  xf86back: 'back',
  super: 'home',
  home: 'home',
  xf86homepage: 'home',
  'alt+tab': 'recents',
  xf86taskpane: 'recents',
  return: 'enter',
  kp_enter: 'enter',
  backspace: 'delete',
  tab: 'tab',
}

function unsupported(verb: string): never {
  throw new RequestError('unsupported', `${verb} is not supported on a phone screen`)
}

function input(screen: PhoneScreen): void {
  if (screen.owner !== 'agent') throw new RequestError('refused', 'human-owns-input')
}

async function capture(screen: PhoneScreen, wanted: number): Promise<Raster> {
  const maxSide = Math.max(captureSideMin, Math.min(captureSideMax, wanted))
  const answer = await screen.call('phone.capture', { maxSide })
  if (typeof answer.data !== 'string') throw new RequestError('refused', 'no-frame')
  const decoded = jpeg.decode(Buffer.from(answer.data, 'base64'), {
    useTArray: true,
    formatAsRGBA: true,
    maxResolutionInMP: 16,
    maxMemoryUsageInMB: 256,
  })
  return { width: decoded.width, height: decoded.height, rgbx: Buffer.from(decoded.data) }
}

function phoneKey(name: string): string {
  const key = phoneKeys[name.toLowerCase()]
  if (!key) usage(`${name} has no phone key; use Escape, Home, alt+Tab, Return, BackSpace or Tab`)
  return key
}

function clamp(value: number, maximum: number): number {
  return Math.max(0, Math.min(maximum - 1, Math.round(value)))
}

export const phoneVerbs: Record<string, (screen: PhoneScreen, request: Request) => Promise<Body>> =
  {
    async screenshot(screen, request) {
      const box = outputBox(screen, request)
      const raster = await capture(screen, Math.max(box.width, box.height))
      return picture(raster, box.width, box.height)
    },

    async zoom(screen, request) {
      const [x0, y0, x1, y1] = regionOn(screen, request)
      const box = outputBox(screen, request)
      const raster = await capture(screen, captureSideMax)
      const scale = raster.width / screen.width
      const left = Math.min(raster.width - 1, Math.floor(x0 * scale))
      const top = Math.min(raster.height - 1, Math.floor(y0 * scale))
      const right = Math.max(left + 1, Math.min(raster.width, Math.ceil(x1 * scale)))
      const bottom = Math.max(top + 1, Math.min(raster.height, Math.ceil(y1 * scale)))
      return picture(crop(raster, left, top, right, bottom), box.width, box.height)
    },

    async click(screen, request) {
      input(screen)
      if (oneOf(request, 'button', ['left', 'middle', 'right'], 'left') !== 'left') {
        unsupported('a right or middle click')
      }
      if (text(request, 'modifiers', true) !== '') unsupported('a click with modifiers')
      const count = optionalWholeNumber(request, 'count', 1, 3, 1)
      if (count === 3) unsupported('a triple click')
      const at = optionalPoint(screen, request, 'at') ?? screen.cursor
      const press = oneOf(request, 'press', ['click', 'down', 'up'], 'click')
      screen.cursor = at
      if (press === 'down') {
        screen.held = { ...at, since: Date.now() }
        screen.log.add('mouse-down', { x: at.x, y: at.y, button: 'left', count })
        return {}
      }
      const held = screen.held
      screen.held = undefined
      if (press === 'up' && !held) usage('no button is down')
      const holdMs = held ? Math.min(holdMsMax, Date.now() - held.since) : 0
      const point = held ?? at
      await screen.call('phone.tap', {
        x: point.x,
        y: point.y,
        ...(count === 2 ? { count } : {}),
        ...(holdMs > 0 ? { holdMs } : {}),
      })
      screen.log.add(press === 'up' ? 'mouse-up' : 'click', {
        x: point.x,
        y: point.y,
        button: 'left',
        count,
      })
      return {}
    },

    async drag(screen, request) {
      input(screen)
      if (text(request, 'modifiers', true) !== '') unsupported('a drag with modifiers')
      const from = pointOn(screen, request.from, 'from')
      const to = pointOn(screen, request.to, 'to')
      await screen.call('phone.swipe', { from: [from.x, from.y], to: [to.x, to.y] })
      screen.cursor = to
      screen.log.add('drag', { from: [from.x, from.y], to: [to.x, to.y] })
      return {}
    },

    async scroll(screen, request) {
      input(screen)
      if (text(request, 'modifiers', true) !== '') unsupported('a scroll with modifiers')
      const direction = oneOf(request, 'direction', ['up', 'down', 'left', 'right'])
      const amount = wholeNumber(request, 'amount', 1, maximumScrollAmount)
      const at = optionalPoint(screen, request, 'at') ?? {
        x: Math.floor(screen.width / 2),
        y: Math.floor(screen.height / 2),
      }
      const vertical = direction === 'up' || direction === 'down'
      const distance = amount * scrollStep * (vertical ? screen.height : screen.width)
      const sign = direction === 'down' || direction === 'right' ? -1 : 1
      const to = vertical
        ? [at.x, clamp(at.y + sign * distance, screen.height)]
        : [clamp(at.x + sign * distance, screen.width), at.y]
      await screen.call('phone.swipe', { from: [at.x, at.y], to })
      screen.log.add('scroll', { x: at.x, y: at.y, direction, amount })
      return {}
    },

    async type(screen, request) {
      input(screen)
      const typed = text(request, 'text')
      if ([...typed].length > typedMax) usage(`text must be at most ${typedMax} characters`)
      await screen.call('phone.type', { text: typed })
      screen.log.add('type', { length: [...typed].length })
      return {}
    },

    async key(screen, request) {
      input(screen)
      const keys = text(request, 'keys')
      const repeat = optionalWholeNumber(request, 'repeat', 1, maximumRepeat, 1)
      const mapped = keys.split(/\s+/).filter(Boolean).map(phoneKey)
      for (let round = 0; round < repeat; round++) {
        for (const key of mapped) await screen.call('phone.key', { key })
      }
      screen.log.add('key', { keys, repeat })
      return {}
    },

    async launch(screen, request) {
      input(screen)
      const argv = request.argv
      if (!isStringArray(argv) || argv.length !== 1 || !packageName.test(argv[0] ?? '')) {
        usage('launch on a phone screen takes one app package name, such as com.android.settings')
      }
      const name = argv[0] as string
      await screen.call('phone.launch', { package: name })
      screen.log.add('launch', { program: name })
      return {}
    },

    async apps(screen) {
      const answer = await screen.call('phone.apps', {})
      return { apps: Array.isArray(answer.apps) ? answer.apps : [] }
    },

    async tree(screen) {
      const answer = await screen.call('phone.tree', {})
      return {
        package: typeof answer.package === 'string' ? answer.package : '',
        nodes: Array.isArray(answer.nodes) ? answer.nodes : [],
      }
    },

    async move() {
      unsupported('move')
    },

    async cursor() {
      unsupported('cursor')
    },

    async windows() {
      unsupported('windows')
    },

    async focus() {
      unsupported('focus')
    },

    async 'hold-key'() {
      unsupported('hold-key')
    },

    async log(screen) {
      return { entries: screen.log.list() }
    },
  }
