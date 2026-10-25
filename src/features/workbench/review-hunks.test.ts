import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureGitBaseline, finishGitReview, reverseApplyDiff } from './git-review'
import { anchorFromDiff, deriveCommentAnchor, locateHunks, parseHunks, switchHunks, type HunkSide } from './review-hunks'

const sha = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex')

// 同 git-review-revert.test.ts 的 roundTrip:真 git、和工作台存下来的同一种 diff
async function snapshot(before: string | null, after: string | null) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cc-hunks-')))
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir })
    if (before !== null) writeFileSync(join(dir, 'f.txt'), before)
    const baseline = await captureGitBaseline(dir)
    if (after === null) unlinkSync(join(dir, 'f.txt')); else writeFileSync(join(dir, 'f.txt'), after)
    const review = await finishGitReview(baseline)
    return review!.files.find(f => f.path === 'f.txt')!
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
const lines = (n: number, tag = 'line', eol = '\n') => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}${eol}`)
const all = (n: number, side: HunkSide) => Array.from({ length: n }, () => side)
const subsets = (n: number) => Array.from({ length: 1 << n }, (_, m) => Array.from({ length: n }, (_, i) => ((m >> i) & 1 ? 'old' : 'new') as HunkSide))

/** 每个子集:从 after 翻出来、无状态认得回来、翻回全新 / 全旧逐字节一致。 */
function exhaust(before: string, after: string, diff: string) {
  const hunks = parseHunks(diff)!
  expect(hunks).not.toBeNull()
  const fresh = all(hunks.length, 'new'), stale = all(hunks.length, 'old')
  for (const target of subsets(hunks.length)) {
    const content = switchHunks(after, hunks, fresh, target)!
    expect(content).not.toBeNull()
    const state = locateHunks(content, hunks, s => switchHunks(content, hunks, s, fresh) === after)
    expect(state).toEqual(target)
    expect(switchHunks(content, hunks, state!, fresh)).toBe(after)
    expect(switchHunks(content, hunks, state!, stale)).toBe(before)
  }
  return hunks
}

describe('switchHunks ≡ reverseApplyDiff on every reverseApplyDiff fixture', () => {
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
      const file = await snapshot(before, after)
      const hunks = parseHunks(file.diff!)!
      expect(hunks).not.toBeNull()
      const now = after ?? ''
      expect(locateHunks(now, hunks)).toEqual(all(hunks.length, 'new'))
      const back = switchHunks(now, hunks, all(hunks.length, 'new'), all(hunks.length, 'old'))
      expect(back).toBe(reverseApplyDiff(now, file.diff!))
      expect(back).toBe(before ?? '')
    })
  }
})

describe('parseHunks / locateHunks / switchHunks (行评论设计稿)', () => {
  it('multi-hunk file: each hunk alone and every subset round-trips, mixed state is detected', async () => {
    const before = lines(40).join('')
    const after = lines(40).map((l, i) => i === 4 ? 'changed 5\n' : i === 19 ? 'changed 20\nadded 20b\n' : i === 34 ? '' : l).join('')
    const file = await snapshot(before, after)
    const hunks = exhaust(before, after, file.diff!)
    expect(hunks).toHaveLength(3)
    expect(hunks.map(h => h.index)).toEqual([0, 1, 2])
    expect(new Set(hunks.map(h => h.sha256)).size).toBe(3)
    expect(hunks[0]).toMatchObject({ oldStart: 2, oldCount: 7, newStart: 2, newCount: 7, gap: 1 })
    expect(hunks[0]!.header).toMatch(/^@@ -2,7 \+2,7 @@/)
  })

  it('hunk at line 1, pure insertion and pure deletion hunks', async () => {
    const before = lines(30).join('')
    const after = ['first!\n', ...lines(30).slice(1, 12), 'inserted a\n', 'inserted b\n', ...lines(30).slice(12, 22), ...lines(30).slice(25)].join('')
    const file = await snapshot(before, after)
    const hunks = exhaust(before, after, file.diff!)
    expect(hunks).toHaveLength(3)
    expect(hunks[0]!.gap).toBe(0)
    expect(hunks[1]!.rows.every(r => r.kind !== 'del')).toBe(true)
    expect(hunks[2]!.rows.every(r => r.kind !== 'add')).toBe(true)
  })

  for (const [name, before, after] of [
    ['old side', lines(20).join('') + 'tail', lines(20).map((l, i) => i === 2 ? 'X\n' : l).join('') + 'tail\nmore\n'],
    ['new side', lines(20).join(''), lines(20).map((l, i) => i === 2 ? 'X\n' : l).join('') + 'end'],
    ['both sides', lines(20).join('') + 'a', lines(20).map((l, i) => i === 2 ? 'X\n' : l).join('') + 'b'],
  ] as const) {
    it(`no newline at end of file on the last hunk (${name})`, async () => {
      const file = await snapshot(before, after)
      const hunks = exhaust(before, after, file.diff!)
      expect(hunks).toHaveLength(2)
      expect(hunks[0]!.oldNoEol || hunks[0]!.newNoEol).toBe(false)
      expect(hunks[1]!.oldNoEol || hunks[1]!.newNoEol).toBe(true)
    })
  }

  it('CRLF file: byte-exact round trip against the snapshot shas, no normalization', async () => {
    const before = lines(30, 'row', '\r\n').join('')
    const after = lines(30, 'row', '\r\n').map((l, i) => i === 3 ? 'ROW 4\r\n' : i === 25 ? 'ROW 26\r\nextra\r\n' : l).join('')
    const file = await snapshot(before, after)
    const hunks = exhaust(before, after, file.diff!)
    expect(hunks).toHaveLength(2)
    expect(hunks[0]!.rows.some(r => r.text.endsWith('\r'))).toBe(true)
    const old = switchHunks(after, hunks, ['new', 'new'], ['old', 'old'])!
    expect(Buffer.from(old, 'utf8').equals(Buffer.from(before, 'utf8'))).toBe(true)
    expect(sha(old)).toBe(file.beforeSha256)
    expect(sha(switchHunks(old, hunks, ['old', 'old'], ['new', 'new'])!)).toBe(file.afterSha256)
    // 被转成 LF 的文件不是快照的 after:认不出,不去猜
    expect(locateHunks(after.replace(/\r\n/g, '\n'), hunks)).toBeNull()
  })

  it('repeated content: both sides match at EOF, the caller check picks the right one', async () => {
    const before = 'k\nl\nm\nn\n', after = 'k\nl\nm\nn\nn\n'
    const file = await snapshot(before, after)
    const hunks = parseHunks(file.diff!)!
    // 现在是「新」:先试新的一侧就对
    expect(locateHunks(after, hunks)).toEqual(['new'])
    // 一份「旧侧 + 多一行 n」的内容两侧都对得上;要求翻成全新后等于另一份内容 ⇒ 回溯到旧侧
    const tricky = 'k\nl\nm\nn\nn\n', wantAfter = 'k\nl\nm\nn\nn\nn\n'
    expect(locateHunks(tricky, hunks, s => switchHunks(tricky, hunks, s, ['new']) === wantAfter)).toEqual(['old'])
    expect(locateHunks(tricky, hunks, () => false)).toBeNull()
  })

  it('repeated content mid-file: a wrong guess on hunk 0 is undone by hunk 1 (hand-written diff)', () => {
    // 手写 diff:git 自己很难生成「旧侧是新侧前缀」的中间块,这里直接钉住回溯
    const hunks = parseHunks('@@ -1,2 +1,4 @@\n x\n x\n+x\n+x\n@@ -6 +8 @@\n-a\n+b\n')!
    expect(hunks).not.toBeNull()
    const content = 'x\nx\nx\nx\ng\nb\n' // 第 0 块旧侧 + 第 1 块新侧;第 0 块新侧在开头也对得上
    expect(locateHunks(content, hunks)).toEqual(['old', 'new'])
    expect(switchHunks(content, hunks, ['old', 'new'], ['new', 'new'])).toBe('x\nx\nx\nx\nx\nx\ng\nb\n')
  })

  it('refuses diffs whose headers or bodies are inconsistent', () => {
    const good = '@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -10,3 +10,3 @@\n h\n-i\n+I\n j\n'
    expect(parseHunks(good)).toHaveLength(2)
    expect(parseHunks(good.replace('@@ -10,3 +10,3 @@', '@@ -10,3 +11,3 @@'))).toBeNull() // 两侧间隔不等
    expect(parseHunks(good.replace('@@ -10,3 +10,3 @@', '@@ -2,3 +2,3 @@'))).toBeNull() // 重叠
    expect(parseHunks(good.replace('@@ -1,3 +1,3 @@', '@@ -1,4 +1,3 @@'))).toBeNull() // 计数对不上
    expect(parseHunks(good.replace(' a\n', '?a\n'))).toBeNull()
    expect(parseHunks('@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n@@ -9 +9 @@\n-x\n+y\n')).toBeNull() // noEol 不在最后一块
    expect(parseHunks('diff --git a b\n@@ -1 +1 @@\n-a\n+b\n')).toBeNull()
    expect(parseHunks('')).toBeNull()
    expect(parseHunks('not a diff')).toBeNull()
  })

  it('switchHunks refuses content that does not match the claimed state', async () => {
    const before = lines(10).join(''), after = lines(10).map((l, i) => i === 4 ? 'five\n' : l).join('')
    const hunks = parseHunks((await snapshot(before, after)).diff!)!
    expect(switchHunks(before, hunks, ['new'], ['old'])).toBeNull()
    expect(switchHunks(after, hunks, ['new'], ['old', 'old'])).toBeNull()
    expect(locateHunks(after.replace('line 3', 'LINE 3'), hunks)).toBeNull()
  })
})

describe('deriveCommentAnchor', () => {
  const hunk = parseHunks('@@ -40,6 +40,4 @@ fn\n a\n-b\n-c\n+C\n d\n e\n-f\n')![0]!
  it('new-side numbers when the range touches the new side, old-side for pure deletions', () => {
    expect(deriveCommentAnchor(hunk, 3, 3)).toEqual({ side: 'new', lineStart: 41, lineEnd: 41, quote: '+C' })
    expect(deriveCommentAnchor(hunk, 1, 2)).toEqual({ side: 'old', lineStart: 41, lineEnd: 42, quote: '-b\n-c' })
    expect(deriveCommentAnchor(hunk, 0, 4)).toMatchObject({ side: 'new', lineStart: 40, lineEnd: 42 })
    expect(deriveCommentAnchor(hunk, 6, 6)).toEqual({ side: 'old', lineStart: 45, lineEnd: 45, quote: '-f' })
    expect(deriveCommentAnchor(hunk)).toMatchObject({ side: 'new', lineStart: 40, lineEnd: 43, quote: ' a\n-b\n-c\n+C\n d\n e\n-f' })
  })
  it('rejects bad ranges', () => {
    for (const [a, b] of [[0, undefined], [undefined, 1], [2, 1], [-1, 0], [0, 7], [0.5, 1]] as Array<[number | undefined, number | undefined]>) {
      expect(() => deriveCommentAnchor(hunk, a, b)).toThrow('invalid_review_reference')
    }
    const big = parseHunks(`@@ -0,0 +1,50 @@\n${Array.from({ length: 50 }, (_, i) => `+l${i}`).join('\n')}\n`)![0]!
    expect(() => deriveCommentAnchor(big, 0, 40)).toThrow('invalid_review_reference')
    expect(deriveCommentAnchor(big, 0, 39).lineEnd).toBe(40)
    expect(deriveCommentAnchor(big).quote.split('\n')).toHaveLength(40)
  })
})

describe('anchorFromDiff', () => {
  const diff = '@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -10,3 +10,3 @@\n h\n-i\n+I\n j\n'
  const [h0, h1] = parseHunks(diff)!
  it('derives the anchor from the snapshot diff and checks the hunk sha', () => {
    expect(anchorFromDiff(diff, 1, h1!.sha256, 2, 2)).toMatchObject({ side: 'new', lineStart: 11, lineEnd: 11, quote: '+I' })
    expect(anchorFromDiff(diff, 0, h0!.sha256)).toMatchObject({ side: 'new', lineStart: 1, lineEnd: 3 })
    expect(() => anchorFromDiff(diff, 1, h0!.sha256)).toThrow('review_hunk_stale')
    expect(() => anchorFromDiff(diff, 2, h0!.sha256)).toThrow('invalid_review_reference')
    expect(() => anchorFromDiff('junk', 0, h0!.sha256)).toThrow('invalid_review_reference')
    expect(() => anchorFromDiff(undefined, 0, h0!.sha256)).toThrow('invalid_review_reference')
  })
})

describe('huge gaps (评审 #449)', () => {
  it('switchHunks / locateHunks / whole-hunk anchors survive hundreds of thousands of lines without RangeError', () => {
    const n = 300_000
    const before = Array.from({ length: n }, (_, i) => `l${i}\n`)
    const after = [...before]; after[0] = 'L0\n'; after[n - 1] = `L${n - 1}\n`
    const diff = `@@ -1,4 +1,4 @@\n-l0\n+L0\n l1\n l2\n l3\n@@ -${n - 2},3 +${n - 2},3 @@\n l${n - 3}\n l${n - 2}\n-l${n - 1}\n+L${n - 1}\n`
    const hunks = parseHunks(diff)!
    expect(hunks).toHaveLength(2)
    const current = after.join('')
    const state = locateHunks(current, hunks)!
    expect(state).toEqual(['new', 'new'])
    const back = switchHunks(current, hunks, state, ['old', 'old'])!
    expect(back).toBe(before.join(''))
    expect(switchHunks(current, hunks, state, ['old', 'new'])!.startsWith('l0\nl1\n')).toBe(true)
    const wide = parseHunks(`@@ -0,0 +1,${n} @@\n${before.map(l => `+${l}`).join('')}`)![0]!
    expect(deriveCommentAnchor(wide)).toMatchObject({ lineStart: 1, lineEnd: n })
  })
})
