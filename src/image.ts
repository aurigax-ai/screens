export type Raster = { width: number; height: number; rgbx: Buffer }

export function crop(source: Raster, x0: number, y0: number, x1: number, y1: number): Raster {
  const width = x1 - x0
  const height = y1 - y0
  const rgbx = Buffer.alloc(width * height * 4)
  for (let row = 0; row < height; row++) {
    const start = ((y0 + row) * source.width + x0) * 4
    source.rgbx.copy(rgbx, row * width * 4, start, start + width * 4)
  }
  return { width, height, rgbx }
}

export function fitWithin(
  width: number,
  height: number,
  boxWidth: number,
  boxHeight: number,
): { width: number; height: number } {
  const scale = Math.min(boxWidth / width, boxHeight / height)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

export function resize(source: Raster, width: number, height: number): Raster {
  if (width === source.width && height === source.height) return source
  const rgbx = Buffer.alloc(width * height * 4)
  const scaleX = source.width / width
  const scaleY = source.height / height
  for (let y = 0; y < height; y++) {
    const top = Math.floor(y * scaleY)
    const bottom = Math.max(top + 1, Math.min(source.height, Math.floor((y + 1) * scaleY)))
    for (let x = 0; x < width; x++) {
      const left = Math.floor(x * scaleX)
      const right = Math.max(left + 1, Math.min(source.width, Math.floor((x + 1) * scaleX)))
      let red = 0
      let green = 0
      let blue = 0
      for (let sy = top; sy < bottom; sy++) {
        for (let sx = left; sx < right; sx++) {
          const offset = (sy * source.width + sx) * 4
          red += source.rgbx[offset] ?? 0
          green += source.rgbx[offset + 1] ?? 0
          blue += source.rgbx[offset + 2] ?? 0
        }
      }
      const count = (bottom - top) * (right - left)
      const target = (y * width + x) * 4
      rgbx[target] = Math.round(red / count)
      rgbx[target + 1] = Math.round(green / count)
      rgbx[target + 2] = Math.round(blue / count)
    }
  }
  return { width, height, rgbx }
}
