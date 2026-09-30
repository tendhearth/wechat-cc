import { describe, it, expect } from 'vitest'
import { latestChanges, CHANGES_FILE_DIFF_MAX, CHANGES_TOTAL_DIFF_MAX, CHANGES_MAX_FILES } from './phone-changes'

const turn = (createdAt: number, files: Array<{ path: string; kind: 'added' | 'deleted' | 'modified' | 'not_reviewed'; diff?: string }>) =>
  ({ artifactId: `a${createdAt}`, sha256: 's', name: 'n', createdAt, status: 'complete' as const, headBefore: null, headAfter: null, preexistingPaths: [], notes: [], files: files.map(f => ({ preexisting: false, ...f })) })

describe('latestChanges', () => {
  it('没有轮次 ⇒ null', () => { expect(latestChanges([])).toBeNull() })
  it('取最近一轮;diff 原样;not_reviewed 无 diff', () => {
    const r = latestChanges([turn(1, [{ path: 'old', kind: 'modified', diff: '@@ -1 +1 @@\n-a\n+b' }]), turn(5, [
      { path: 'src/a.ts', kind: 'modified', diff: '@@ -1 +1 @@\n-x\n+y' },
      { path: 'big.bin', kind: 'not_reviewed' },
    ])])!
    expect(r.createdAt).toBe(5)
    expect(r.files).toEqual([
      { path: 'src/a.ts', kind: 'modified', diff: '@@ -1 +1 @@\n-x\n+y', truncated: false },
      { path: 'big.bin', kind: 'not_reviewed', truncated: false },
    ])
    expect(r.omittedFiles).toBe(0)
  })
  it('单文件超上限 ⇒ 不给 diff、truncated;按 UTF-8 字节算', () => {
    const cjk = '中'.repeat(Math.ceil(CHANGES_FILE_DIFF_MAX / 3) + 10)
    const r = latestChanges([turn(1, [{ path: 'a', kind: 'modified', diff: cjk }])])!
    expect(r.files[0]).toEqual({ path: 'a', kind: 'modified', truncated: true })
  })
  it('累计超总量 ⇒ 之后的文件不给 diff;5 MB 的 diff 不会进回包', () => {
    const chunk = 'x'.repeat(CHANGES_FILE_DIFF_MAX - 10)
    const n = Math.ceil(CHANGES_TOTAL_DIFF_MAX / chunk.length) + 2
    const files = Array.from({ length: n }, (_, i) => ({ path: `f${i}`, kind: 'modified' as const, diff: chunk }))
    files.push({ path: 'huge', kind: 'modified', diff: 'y'.repeat(5 * 1024 * 1024) })
    const r = latestChanges([turn(1, files)])!
    const total = r.files.reduce((s, f) => s + (f.diff ? Buffer.byteLength(f.diff) : 0), 0)
    expect(total).toBeLessThanOrEqual(CHANGES_TOTAL_DIFF_MAX)
    expect(r.files.at(-1)).toEqual({ path: 'huge', kind: 'modified', truncated: true })
    expect(JSON.stringify(r).length).toBeLessThan(CHANGES_TOTAL_DIFF_MAX + 64 * 1024)
  })
  it('文件数超上限 ⇒ 计入 omittedFiles', () => {
    const files = Array.from({ length: CHANGES_MAX_FILES + 7 }, (_, i) => ({ path: `f${i}`, kind: 'added' as const, diff: '+1' }))
    const r = latestChanges([turn(1, files)])!
    expect(r.files).toHaveLength(CHANGES_MAX_FILES)
    expect(r.omittedFiles).toBe(7)
  })
})
