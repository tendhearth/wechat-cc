import { describe, it, expect } from 'vitest'
import { PhoneChangesTurn } from '@wechat-cc/protocol'
import { latestChanges, CHANGES_TEXT_MAX, CHANGES_MAX_NOTES, CHANGES_FILE_DIFF_MAX, CHANGES_TOTAL_DIFF_MAX, CHANGES_MAX_FILES, CHANGES_PATH_MAX } from './phone-changes'

const turn = (createdAt: number, files: Array<{ path: string; kind: 'added' | 'deleted' | 'modified' | 'not_reviewed'; diff?: string; reason?: string }>, notes: string[] = []) =>
  ({ artifactId: `a${createdAt}`, sha256: 's', name: 'n', createdAt, status: 'complete' as const, headBefore: null, headAfter: null, preexistingPaths: [], notes, files: files.map(f => ({ preexisting: false, ...f })) })

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
    expect(r.notes).toEqual([])
  })
  it('带上文件的 reason(为什么没审/被截)与本轮 notes;各自裁到 200 字、notes 至多 10 条;符合协议 schema', () => {
    const long = '因'.repeat(CHANGES_TEXT_MAX + 50)
    const r = latestChanges([turn(1, [
      { path: 'big.bin', kind: 'not_reviewed', reason: 'binary file' },
      { path: 'huge.txt', kind: 'not_reviewed', reason: long },
      { path: 'a.ts', kind: 'modified', diff: '+1' },
    ], [...Array.from({ length: CHANGES_MAX_NOTES + 3 }, (_, i) => `note ${i}`), long])])!
    expect(CHANGES_TEXT_MAX).toBe(200)
    expect(CHANGES_MAX_NOTES).toBe(10)
    expect(r.files[0]).toEqual({ path: 'big.bin', kind: 'not_reviewed', reason: 'binary file', truncated: false })
    expect([...r.files[1]!.reason!].length).toBeLessThanOrEqual(CHANGES_TEXT_MAX)
    expect(r.files[2]).toEqual({ path: 'a.ts', kind: 'modified', diff: '+1', truncated: false })
    expect(r.notes).toHaveLength(CHANGES_MAX_NOTES)
    expect(r.notes[0]).toBe('note 0')
    const r2 = latestChanges([turn(1, [], [long])])!
    expect([...r2.notes[0]!].length).toBeLessThanOrEqual(CHANGES_TEXT_MAX)
    expect(PhoneChangesTurn.parse(r)).toEqual(r)
    expect(PhoneChangesTurn.safeParse({ ...r, notes: undefined }).success).toBe(false)
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
  it('最坏输入:长路径 + 引号/换行密集的 diff ⇒ 序列化后 < 400 KiB,路径留尾', () => {
    const files = Array.from({ length: CHANGES_MAX_FILES + 20 }, (_, i) => ({ path: `${'d/'.repeat(2048)}file${i}.ts`, kind: 'modified' as const, diff: '"\n'.repeat(Math.floor(CHANGES_FILE_DIFF_MAX / 4)) }))
    const r = latestChanges([turn(1, files)])!
    expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThan(400 * 1024)
    for (const [i, f] of r.files.entries()) {
      expect(f.path.length).toBeLessThanOrEqual(CHANGES_PATH_MAX)
      expect(f.path.startsWith('…')).toBe(true)
      expect(f.path.endsWith(`file${i}.ts`)).toBe(true)
    }
    expect(latestChanges([turn(1, [{ path: 'short.ts', kind: 'added', diff: '+1' }])])!.files[0]!.path).toBe('short.ts')
  })
})
