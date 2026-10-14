import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { allowChroot } from '../dist/oci-runtime.js'

const root = new URL('..', import.meta.url)
const source = JSON.parse(await readFile(new URL('seccomp/source.json', root), 'utf8'))
const content = await readFile(new URL('seccomp/moby-default.json', root))
const digest = createHash('sha256').update(content).digest('hex')
if (digest !== source.sha256) {
  throw new Error(`seccomp/moby-default.json is not the recorded ${source.tag} (${digest})`)
}
const derived = allowChroot(JSON.parse(content.toString('utf8')))
await writeFile(new URL('dist/seccomp-docker.json', root), `${JSON.stringify(derived)}\n`)
