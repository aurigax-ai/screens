import { expect, test } from 'vitest'
import { ActionLog } from '../../src/action-log.js'
import { crop, fitWithin, resize } from '../../src/image.js'

function raster(width: number, height: number, pixel: (x: number, y: number) => number[]) {
  const rgbx = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) rgbx.set([...pixel(x, y), 0], (y * width + x) * 4)
  }
  return { width, height, rgbx }
}

test('fitWithin keeps the aspect ratio inside the box', () => {
  expect(fitWithin(1600, 1000, 1280, 1280)).toEqual({ width: 1280, height: 800 })
  expect(fitWithin(800, 500, 1600, 1000)).toEqual({ width: 1600, height: 1000 })
  expect(fitWithin(100, 400, 1280, 800)).toEqual({ width: 200, height: 800 })
})

test('crop copies the region and resize averages or repeats pixels', () => {
  const source = raster(4, 4, (x, y) => [x * 10, y * 10, 0])
  const region = crop(source, 1, 2, 3, 4)
  expect([region.width, region.height]).toEqual([2, 2])
  expect([...region.rgbx.subarray(0, 3)]).toEqual([10, 20, 0])
  const half = resize(source, 2, 2)
  expect([...half.rgbx.subarray(0, 3)]).toEqual([5, 5, 0])
  const double = resize(region, 4, 4)
  expect([...double.rgbx.subarray(4, 7)]).toEqual([10, 20, 0])
})

test('the action log keeps the newest entries', () => {
  const log = new ActionLog()
  for (let index = 0; index < 510; index++) log.add('move', { x: index })
  const entries = log.list()
  expect(entries.length).toBe(500)
  expect(entries[0]?.x).toBe(10)
})
