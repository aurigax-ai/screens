import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { isRecord } from './json-lines.js'

const pinnedImageFile = fileURLToPath(new URL('../image.json', import.meta.url))

export async function pinnedImage(): Promise<string | undefined> {
  try {
    const pinned: unknown = JSON.parse(await readFile(pinnedImageFile, 'utf8'))
    return isRecord(pinned) && typeof pinned.image === 'string' ? pinned.image : undefined
  } catch {
    return undefined
  }
}

export async function screenImage(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return (await pinnedImage()) ?? env.SCREENS_OCI_IMAGE
}
