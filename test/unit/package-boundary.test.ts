import { readdir, readFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { join, relative, resolve } from 'node:path'
import { expect, test } from 'vitest'

const packageRoot = resolve(import.meta.dirname, '../..')
const forbiddenClientName = Buffer.from('b3N0aWE=', 'base64').toString()

async function filesUnder(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { withFileTypes: true, recursive: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

function importSpecifiers(source: string): string[] {
  const patterns = [
    /^\s*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/gm,
    /^\s*import\s*['"]([^'"]+)['"]/gm,
    /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
  ]
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1] ?? ''))
}

test('SCR-C1 the published package never names or imports a client application', async () => {
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  const dependencies = Object.keys(packageJson.dependencies ?? {})
  const sources = await filesUnder(join(packageRoot, 'src'))
  const published = [
    ...sources,
    join(packageRoot, 'package.json'),
    join(packageRoot, 'README.md'),
    join(packageRoot, 'LICENSE'),
  ]
  const naming: string[] = []
  for (const file of published) {
    const content = await readFile(file, 'utf8')
    if (content.toLowerCase().includes(forbiddenClientName))
      naming.push(relative(packageRoot, file))
  }
  expect(naming).toEqual([])

  const strayImports: string[] = []
  for (const file of sources) {
    for (const specifier of importSpecifiers(await readFile(file, 'utf8'))) {
      const isBuiltin =
        specifier.startsWith('node:') || builtinModules.includes(specifier.split('/')[0] ?? '')
      const isDependency = dependencies.some(
        (name) => specifier === name || specifier.startsWith(`${name}/`),
      )
      const isInside =
        specifier.startsWith('.') &&
        resolve(file, '..', specifier).startsWith(join(packageRoot, 'src'))
      if (!isBuiltin && !isDependency && !isInside) {
        strayImports.push(`${relative(packageRoot, file)}: ${specifier}`)
      }
    }
  }
  expect(strayImports).toEqual([])
  expect(sources.length).toBeGreaterThan(5)
})
