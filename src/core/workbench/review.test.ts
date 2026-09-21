import { describe, it, expect } from 'vitest'
import { composeReturnText, derivedReturnRequestId, parseGitReviewSnapshot } from './review'
import { normalizeInputRequestId } from './live-inputs'
import { serializeGitReview, type GitReview, type ReviewFile } from './git-review'

const file = (path: string, over: Partial<ReviewFile> = {}): ReviewFile => ({ path, preexisting: false, kind: 'modified', beforeSha256: 'a'.repeat(64), afterSha256: 'b'.repeat(64), diff: `@@ -1 +1 @@\n-老 ${path}\n+新 ${path}`, ...over })
const review = (over: Partial<GitReview> = {}): GitReview => ({ version: 1, scope: 'working-tree-before-after', startedAt: 1, finishedAt: 2, headBefore: 'h1', headAfter: 'h2', status: 'complete', preexistingPaths: ['old.ts'], notes: ['一句提示'], files: [file('src/a.ts'), file('src/big.bin', { kind: 'not_reviewed', reason: '二进制文件未展开', beforeSha256: undefined, afterSha256: undefined, diff: undefined })], ...over })
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value))

describe('parseGitReviewSnapshot', () => {
  it('接受 serializeGitReview 写出的合法快照,保留文件、状态与说明', () => {
    const parsed = parseGitReviewSnapshot(serializeGitReview(review()))
    expect(parsed).not.toBeNull()
    expect(parsed).toMatchObject({ version: 1, scope: 'working-tree-before-after', status: 'complete', headBefore: 'h1', headAfter: 'h2', preexistingPaths: ['old.ts'], notes: ['一句提示'] })
    expect(parsed!.files.map(f => [f.path, f.kind])).toEqual([['src/a.ts', 'modified'], ['src/big.bin', 'not_reviewed']])
    expect(parsed!.files[0]!.diff).toContain('+新 src/a.ts')
  })

  it('坏快照一律 null:非 JSON、空对象、错 version、错 scope、files 非数组、文件项的 path/kind 不合法', () => {
    expect(parseGitReviewSnapshot(Buffer.from('not json at all'))).toBeNull()
    expect(parseGitReviewSnapshot(bytes({}))).toBeNull()
    expect(parseGitReviewSnapshot(bytes([1, 2]))).toBeNull()
    expect(parseGitReviewSnapshot(bytes({ ...review(), version: 2 }))).toBeNull()
    expect(parseGitReviewSnapshot(bytes({ ...review(), scope: 'whatever' }))).toBeNull()
    expect(parseGitReviewSnapshot(bytes({ ...review(), files: '不是数组' }))).toBeNull()
    expect(parseGitReviewSnapshot(bytes({ ...review(), status: 'nope' }))).toBeNull()
    expect(parseGitReviewSnapshot(bytes({ ...review(), files: [{ path: 'a.ts', kind: '随便' }] }))).toBeNull()
    expect(parseGitReviewSnapshot(bytes({ ...review(), files: [{ path: '', kind: 'modified' }] }))).toBeNull()
    expect(parseGitReviewSnapshot(bytes({ ...review(), files: [null] }))).toBeNull()
  })
})

describe('composeReturnText', () => {
  it('列出路径、写上意见,并逐个附上 diff 节选', () => {
    const text = composeReturnText([{ path: 'src/a.ts', diff: '@@ -1 +1 @@\n-老\n+新' }, { path: 'src/b.ts', diff: '@@ -2 +2 @@\n+加一行' }], '这里不对,请改')
    expect(text.startsWith('打回以下改动,请按意见修改:\n- src/a.ts\n- src/b.ts\n意见:这里不对,请改')).toBe(true)
    expect(text).toContain('--- src/a.ts ---')
    expect(text).toContain('+新')
    expect(text).toContain('--- src/b.ts ---')
    expect(text).toContain('+加一行')
    expect(text).not.toContain('(已截断)')
  })

  it('每个文件最多 60 行,超出的部分截断并标注', () => {
    const diff = Array.from({ length: 200 }, (_, i) => `+line${i + 1}`).join('\n')
    const text = composeReturnText([{ path: 'src/long.ts', diff }], '太长了')
    expect(text).toContain('+line60')
    expect(text).not.toContain('+line61')
    expect(text).toContain('(已截断)')
  })

  it('总长不超过 6000 字,截断处标注', () => {
    const diff = Array.from({ length: 60 }, () => `+${'x'.repeat(100)}`).join('\n')
    const text = composeReturnText([{ path: 'a.ts', diff }, { path: 'b.ts', diff }, { path: 'c.ts', diff }], '都要改')
    expect(text.length).toBeLessThanOrEqual(6000)
    expect(text).toContain('(已截断)')
    expect(text).toContain('- c.ts')
  })

  it('没有 diff 的文件只出现在清单里;上限可调', () => {
    const text = composeReturnText([{ path: 'gone.ts' }, { path: 'src/a.ts', diff: '@@\n+一\n+二\n+三' }], '改', { maxLinesPerFile: 3, maxTotalChars: 6000 })
    expect(text).toContain('- gone.ts')
    expect(text).not.toContain('--- gone.ts ---')
    expect(text).toContain('+二')
    expect(text).not.toContain('+三')
    expect(text).toContain('(已截断)')
  })

  it('连清单都放不下时也不越界', () => {
    const text = composeReturnText([{ path: 'x'.repeat(300), diff: '@@\n+一' }], 'y'.repeat(300), { maxTotalChars: 120 })
    expect(text.length).toBeLessThanOrEqual(120)
    expect(text).toContain('(已截断)')
  })

  it('预算比标注本身还小也不越界', () => {
    for (const maxTotalChars of [0, 1, 3, 5]) {
      const text = composeReturnText([{ path: 'a.ts', diff: '@@\n+一' }], '改', { maxTotalChars })
      expect(text.length).toBeLessThanOrEqual(maxTotalChars)
    }
  })
})

// 打回的请求 id 要能从这一笔打回本身算出来:主人重发同一份打回(桌面重试、微信再点一次)
// 必须落到 liveInputs 的幂等分支,而不是每次一个新的 randomUUID 各投递一遍(评审 2026-09-21 #7)。
describe('derivedReturnRequestId', () => {
  it('同一笔打回算出同一个 id:顺序无关、UUID 形状(过 normalizeInputRequestId)、内容一变就换一个', () => {
    const sha = 'a'.repeat(64)
    const id = derivedReturnRequestId(sha, ['src/b.ts', 'src/a.ts'], '这两处判空漏了')
    expect(derivedReturnRequestId(sha, ['src/a.ts', 'src/b.ts'], '这两处判空漏了')).toBe(id)
    expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/)
    expect(normalizeInputRequestId(id)).toBe(id)
    expect(derivedReturnRequestId(sha, ['src/a.ts'], '这两处判空漏了')).not.toBe(id)
    expect(derivedReturnRequestId(sha, ['src/a.ts', 'src/b.ts'], '再改改')).not.toBe(id)
    expect(derivedReturnRequestId('b'.repeat(64), ['src/a.ts', 'src/b.ts'], '这两处判空漏了')).not.toBe(id)
  })
})
