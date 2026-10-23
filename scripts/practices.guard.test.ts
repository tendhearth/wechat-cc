/**
 * 做法清单(docs/maintainer/practices.md)每一条都带出处。
 *
 * 规矩没有出处,半年后就分不清是「吃过亏定下的」还是「某次随手写的」,也就没人敢删、没人敢改。
 * 出处 = PR 号(#123)或日期(2026-10-23)。设计稿 2026-10-23-cc-runs-development-design.md §4.3。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const text = readFileSync(join(ROOT, 'docs', 'maintainer', 'practices.md'), 'utf8').replace(/\r\n/g, '\n')
const items = text.split('\n').filter(l => l.startsWith('- '))
const CITED = /#\d+|\b20\d\d-\d\d-\d\d\b/

describe('做法清单', () => {
  it('有条目', () => {
    expect(items.length).toBeGreaterThan(10)
  })
  it('每一条都带出处(PR 号或日期)', () => {
    const missing = items.filter(l => !CITED.test(l))
    expect(missing, '补上出处:哪个 PR、哪一天吃的亏').toEqual([])
  })
  it('维护者手册的入口指到它', () => {
    expect(readFileSync(join(ROOT, 'docs', 'maintainer', 'README.md'), 'utf8')).toContain('practices.md')
  })
})
