import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { runArguments, seccompProfile } from '../../src/oci-runtime.js'

type Rule = { names?: string[]; action?: string; includes?: { caps?: string[] } }

test('Docker gets a seccomp profile that allows chroot without CAP_SYS_CHROOT when no local default exists', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'screens-seccomp-'))
  try {
    const profile = await seccompProfile('docker', folder, process.env, '/nonexistent/seccomp.json')
    expect(profile).toBeDefined()
    const rules = (JSON.parse(await readFile(profile ?? '', 'utf8')) as { syscalls: Rule[] })
      .syscalls
    const chroot = rules.filter((rule) => rule.names?.includes('chroot'))
    expect(chroot).toEqual([{ names: ['chroot'], action: 'SCMP_ACT_ALLOW', args: [] }])
    const moby = JSON.parse(
      await readFile(join(import.meta.dirname, '../../seccomp/moby-default.json'), 'utf8'),
    ) as { syscalls: Rule[] }
    const unchanged = (list: Rule[]) =>
      JSON.stringify(list.filter((rule) => !rule.names?.includes('chroot')))
    expect(unchanged(rules)).toBe(unchanged(moby.syscalls))
    const args = runArguments({
      runtime: 'docker',
      id: 'abcd1234',
      daemon: 'label',
      image: 'image@sha256:00',
      width: 1280,
      height: 800,
      seccomp: profile,
    })
    expect(args).toContain(`seccomp=${profile}`)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('the vendored Moby profile matches its recorded source', async () => {
  const root = join(import.meta.dirname, '../..')
  const source = JSON.parse(await readFile(join(root, 'seccomp/source.json'), 'utf8'))
  const { createHash } = await import('node:crypto')
  const content = await readFile(join(root, 'seccomp/moby-default.json'))
  expect(createHash('sha256').update(content).digest('hex')).toBe(source.sha256)
})
