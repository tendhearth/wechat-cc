import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { captureGitBaseline, finishGitReview, reverseApplyDiff } from './git-review'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

// 用真 git 生成 diff(和工作台存下来的同一种),再倒推回去,核对逐字节一致。
async function roundTrip(before: string | null, after: string | null) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cc-revert-')))
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir })
    if (before !== null) writeFileSync(join(dir, 'f.txt'), before)
    const baseline = await captureGitBaseline(dir)
    if (after === null) unlinkSync(join(dir, 'f.txt')); else writeFileSync(join(dir, 'f.txt'), after)
    const review = await finishGitReview(baseline)
    return review!.files.find(f => f.path === 'f.txt')!
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

describe('reverseApplyDiff (2026-10-06)', () => {
  const cases: Array<[string, string | null, string | null]> = [
    ['modified in the middle', 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n', 'a\nb\nC\nd\ne\nf\ng\nh\nI\nj\n'],
    ['lines added and removed', 'one\ntwo\nthree\n', 'zero\none\nthree\nfour\n'],
    ['no newline at end (before)', 'x\ny', 'x\ny\nz\n'],
    ['no newline at end (after)', 'x\ny\n', 'x\nY'],
    ['no newline at end (both)', 'p\nq', 'p\nQ'],
    ['emptied', 'only\nlines\n', ''],
    ['from empty', '', 'new\ncontent\n'],
    ['crlf', 'a\r\nb\r\n', 'a\r\nB\r\n'],
    ['deleted file', 'gone\nfor\ngood\n', null],
    ['added file', null, 'brand\nnew\n'],
  ]
  for (const [name, before, after] of cases) {
    it(name, async () => {
      const file = await roundTrip(before, after)
      expect(file.diff).toBeTruthy()
      const restored = reverseApplyDiff(after ?? '', file.diff!)
      expect(restored).toBe(before ?? '')
      if (file.beforeSha256) expect(sha(restored!)).toBe(file.beforeSha256)
    })
  }
  it('refuses when the current content no longer matches the diff', async () => {
    const file = await roundTrip('a\nb\nc\n', 'a\nB\nc\n')
    expect(reverseApplyDiff('a\nX\nc\n', file.diff!)).toBeNull()
    expect(reverseApplyDiff('a\nB\nc\n', 'not a diff')).toBe('a\nB\nc\n') // 没有 hunk ⇒ 原样;调用方的 beforeSha256 会拒掉
  })
})
