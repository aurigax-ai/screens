import { expect, test } from 'vitest'
import {
  characterKeysym,
  KeyNameError,
  parseCombination,
  parseKeys,
  parseModifiers,
} from '../../src/keys.js'

test('key names map to X keysyms, case-insensitively', () => {
  expect(parseCombination('Return')).toEqual([0xff0d])
  expect(parseCombination('ctrl+s')).toEqual([0xffe3, 0x73])
  expect(parseCombination('alt+Tab')).toEqual([0xffe9, 0xff09])
  expect(parseCombination('super+shift+F5')).toEqual([0xffeb, 0xffe1, 0xffc2])
  expect(parseCombination('BackSpace')).toEqual([0xff08])
  expect(parseCombination('Page_Down')).toEqual([0xff56])
})

test('a key sequence is space separated combinations', () => {
  expect(parseKeys('ctrl+a BackSpace')).toEqual([[0xffe3, 0x61], [0xff08]])
})

test('unknown names, empty parts and non-modifiers are refused', () => {
  expect(() => parseCombination('NoSuchKey')).toThrow(KeyNameError)
  expect(() => parseCombination('ctrl+')).toThrow(KeyNameError)
  expect(() => parseKeys('  ')).toThrow(KeyNameError)
  expect(() => parseModifiers('ctrl+a')).toThrow(KeyNameError)
  expect(parseModifiers('ctrl+shift')).toEqual([0xffe3, 0xffe1])
  expect(parseModifiers('')).toEqual([])
})

test('typed characters map to Latin-1 or Unicode keysyms', () => {
  expect(characterKeysym('a')).toBe(0x61)
  expect(characterKeysym('é')).toBe(0xe9)
  expect(characterKeysym('€')).toBe(0x010020ac)
  expect(characterKeysym('\n')).toBe(0xff0d)
})
