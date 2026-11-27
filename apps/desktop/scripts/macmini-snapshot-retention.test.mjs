import { expect, test } from 'vitest'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pruneInactiveSnapshots } from './macmini-snapshot-retention.mjs'

const snapshot = (kind, timestamp, sha = 'a') => `${kind}-${sha.repeat(40)}-${timestamp}`
const dirLink = process.platform === 'win32' ? 'junction' : 'dir'

async function fixture(run) {
  const temp = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'cc-snapshot-retention-')))
  const lab = join(temp, 'disk', 'lab')
  const labHome = join(temp, 'legacy')
  const outside = join(temp, 'outside')
  try {
    await fs.mkdir(lab, { recursive: true })
    await fs.mkdir(outside)
    await fs.symlink(lab, labHome, dirLink)
    await run({ lab, labHome, outside })
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
}

test('retention keeps all referenced directories and two inactive snapshots per kind', async () => {
  await fixture(async ({ lab, labHome, outside }) => {
    const alias = join(lab, 'source-alias')
    const entries = [
      [snapshot('app', 1), 'directory', true],
      [snapshot('app', 2), 'directory', true],
      [snapshot('browser', 3), 'directory', true],
      [snapshot('app', 4), 'directory', false],
      [snapshot('browser', 5), 'directory', false],
      [snapshot('browser', 8, 'b'), 'directory', true],
      [snapshot('browser', 99), 'directory', true],
      [snapshot('app', 9, 'b'), 'directory', true],
      [snapshot('app', 100), 'directory', true],
      [snapshot('app', 101), 'directory', true],
      [snapshot('app', 102), 'link', true],
      [snapshot('browser', 102), 'file', true],
      ['runtime-20261030', 'directory', true],
      ['app-executor', 'directory', true],
      ['app-tools', 'directory', true],
      [snapshot('browser', 0, 'A'), 'directory', true],
      [snapshot('app', 0) + '.backup', 'directory', true],
    ]
    for (const [name, type] of entries) {
      const path = join(lab, name)
      if (type === 'link') await fs.symlink(outside, path, dirLink)
      else if (type === 'file') await fs.writeFile(path, 'fixture')
      else await fs.mkdir(path)
    }
    await fs.symlink(join(lab, snapshot('app', 2)), alias, dirLink)
    await fs.writeFile(join(outside, 'keep'), 'outside')
    await fs.writeFile(join(labHome, 'active.json'), JSON.stringify({
      appRoot: join(labHome, snapshot('app', 101)),
      browserSourceRoot: join(lab, snapshot('app', 1)),
      future: { paths: [join(alias, 'missing-receipt.json'), join(labHome, snapshot('browser', 3), 'missing', 'receipt')] },
    }))

    await pruneInactiveSnapshots(labHome)

    const remaining = await fs.readdir(lab)
    expect(remaining.sort()).toEqual(['active.json', 'source-alias', ...entries.filter(([, , keep]) => keep).map(([name]) => name)].sort())
    expect(await fs.readFile(join(outside, 'keep'), 'utf8')).toBe('outside')
  })
})

test('a deletion failure emits one line and does not stop pruning', async () => {
  await fixture(async ({ lab, labHome }) => {
    for (const timestamp of [1, 2, 3, 4]) await fs.mkdir(join(lab, snapshot('app', timestamp)))
    await fs.writeFile(join(lab, 'active.json'), '{}')
    const warnings = []
    const failed = join(lab, snapshot('app', 2))
    await pruneInactiveSnapshots(labHome, {
      fs: { ...fs, rm: async (path, options) => {
        if (path === failed) throw Error('permission denied\nfixture detail')
        await fs.rm(path, options)
      } },
      warn: line => warnings.push(line),
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).not.toContain('\n')
    expect(JSON.parse(warnings[0])).toMatchObject({ path: failed, error: 'Error: permission denied\nfixture detail' })
    expect(await fs.readdir(lab)).not.toContain(snapshot('app', 1))
  })
})
