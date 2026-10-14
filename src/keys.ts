const namedKeysyms: Record<string, number> = {
  return: 0xff0d,
  enter: 0xff0d,
  kp_enter: 0xff8d,
  tab: 0xff09,
  escape: 0xff1b,
  esc: 0xff1b,
  backspace: 0xff08,
  delete: 0xffff,
  del: 0xffff,
  insert: 0xff63,
  home: 0xff50,
  end: 0xff57,
  page_up: 0xff55,
  pageup: 0xff55,
  prior: 0xff55,
  page_down: 0xff56,
  pagedown: 0xff56,
  next: 0xff56,
  left: 0xff51,
  up: 0xff52,
  right: 0xff53,
  down: 0xff54,
  space: 0x0020,
  minus: 0x002d,
  plus: 0x002b,
  equal: 0x003d,
  comma: 0x002c,
  period: 0x002e,
  slash: 0x002f,
  backslash: 0x005c,
  semicolon: 0x003b,
  apostrophe: 0x0027,
  grave: 0x0060,
  bracketleft: 0x005b,
  bracketright: 0x005d,
  caps_lock: 0xffe5,
  num_lock: 0xff7f,
  scroll_lock: 0xff14,
  print: 0xff61,
  pause: 0xff13,
  menu: 0xff67,
  shift: 0xffe1,
  shift_l: 0xffe1,
  shift_r: 0xffe2,
  ctrl: 0xffe3,
  control: 0xffe3,
  control_l: 0xffe3,
  control_r: 0xffe4,
  alt: 0xffe9,
  alt_l: 0xffe9,
  alt_r: 0xffea,
  super: 0xffeb,
  super_l: 0xffeb,
  super_r: 0xffec,
  meta: 0xffeb,
  cmd: 0xffeb,
  win: 0xffeb,
}

const modifierNames = new Set(['shift', 'ctrl', 'control', 'alt', 'super', 'meta', 'cmd', 'win'])

export class KeyNameError extends Error {}

export function characterKeysym(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0
  if (character === '\n') return 0xff0d
  if (character === '\t') return 0xff09
  if (codePoint >= 0x20 && codePoint <= 0x7e) return codePoint
  if (codePoint >= 0xa0 && codePoint <= 0xff) return codePoint
  return 0x01000000 + codePoint
}

function keysymOf(name: string): number {
  const named = namedKeysyms[name.toLowerCase()]
  if (named !== undefined) return named
  const functionKey = /^f([1-9]|1[0-9]|2[0-4])$/i.exec(name)
  if (functionKey) return 0xffbe + Number(functionKey[1]) - 1
  if ([...name].length === 1) return characterKeysym(name)
  throw new KeyNameError(`unknown key ${name}`)
}

export function parseCombination(text: string): number[] {
  const names = text.split('+')
  if (text.trim() === '' || names.some((name) => name === '')) {
    throw new KeyNameError(`not a key combination: ${text}`)
  }
  return names.map(keysymOf)
}

export function parseKeys(text: string): number[][] {
  const combinations = text.trim().split(/\s+/)
  if (combinations.length === 0 || combinations[0] === '') {
    throw new KeyNameError('no key given')
  }
  return combinations.map(parseCombination)
}

export function parseModifiers(text: string): number[] {
  if (text === '') return []
  const names = text.split('+')
  for (const name of names) {
    if (!modifierNames.has(name.toLowerCase())) throw new KeyNameError(`not a modifier: ${name}`)
  }
  return names.map(keysymOf)
}
