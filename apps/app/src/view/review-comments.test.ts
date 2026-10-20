import { describe, it, expect } from 'vitest'
import type { PhoneChangesTurnT } from '../backend/types'
import { batchRequestId, canComment, commentFailure, commentRow, fileHunks, hunkComments, sendBlock, sendOutcome } from './review-comments'

const SHA = (n: number) => String(n).repeat(64).slice(0, 64)
const diff = '@@ -1,2 +1,2 @@ fn a\n-x\n+y\n ctx\n@@ -10 +10 @@\n-p\n+q'
const hunks = [{ index: 0, sha256: SHA(1), header: '@@ -1,2 +1,2 @@ fn a' }, { index: 1, sha256: SHA(2), header: '@@ -10 +10 @@' }]
const file = (over: Partial<PhoneChangesTurnT['files'][number]> = {}): PhoneChangesTurnT['files'][number] => ({ path: 'src/a.ts', kind: 'modified', diff, truncated: false, hunks, ...over })
const turn = (over: Partial<PhoneChangesTurnT> = {}): PhoneChangesTurnT => ({ artifactId: 'a1', createdAt: 1, status: 'complete', files: [file()], omittedFiles: 0, notes: [], ...over })
const NOW = new Date(2026, 9, 21, 15, 0).getTime()

describe('fileHunks', () => {
  it('按 daemon 的切法切,块数 / 序号 / 块头都对上才回;末尾换行去掉', () => {
    expect(fileHunks(file())).toEqual([
      { index: 0, sha256: SHA(1), header: '@@ -1,2 +1,2 @@ fn a', text: '@@ -1,2 +1,2 @@ fn a\n-x\n+y\n ctx' },
      { index: 1, sha256: SHA(2), header: '@@ -10 +10 @@', text: '@@ -10 +10 @@\n-p\n+q' },
    ])
  })
  it('daemon 裁过的长块头(…结尾)按前缀认', () => {
    const long = '@@ -1 +1 @@ ' + 'f'.repeat(300)
    expect(fileHunks({ diff: `${long}\n-a\n+b`, hunks: [{ index: 0, sha256: SHA(1), header: long.slice(0, 199) + '…' }] })).toHaveLength(1)
  })
  it('对不上 ⇒ null(界面照旧整段、不给评论):没 hunks / 块数不同 / 块头不同 / 序号不对 / @@ 前有东西', () => {
    expect(fileHunks(file({ hunks: undefined }))).toBeNull()
    expect(fileHunks(file({ hunks: [] }))).toBeNull()
    expect(fileHunks(file({ hunks: hunks.slice(0, 1) }))).toBeNull()
    expect(fileHunks(file({ hunks: [hunks[0]!, { ...hunks[1]!, header: '@@ -11 +11 @@' }] }))).toBeNull()
    expect(fileHunks(file({ hunks: [hunks[0]!, { ...hunks[1]!, index: 5 }] }))).toBeNull()
    expect(fileHunks(file({ diff: 'diff --git\n' + diff }))).toBeNull()
    expect(fileHunks(file({ diff: undefined }))).toBeNull()
  })
})

describe('canComment', () => {
  it('有轮次 id、没撤掉、路径没裁、块对得上才给', () => {
    expect(canComment(turn(), file())).toBe(true)
    expect(canComment(null, file())).toBe(false)
    expect(canComment(turn({ artifactId: undefined }), file())).toBe(false)
    expect(canComment(turn({ discarded: true }), file())).toBe(false)
    expect(canComment(turn(), file({ path: '…/a.ts' }))).toBe(false)
    expect(canComment(turn(), file({ hunks: undefined }))).toBe(false)
  })
})

describe('评论显示', () => {
  it('草稿能删;已发出 · 时间;认不得的状态只读、不写状态', () => {
    expect(commentRow({ id: 'c', hunk: 0, body: '改', state: 'draft' }, NOW, 'zh-Hans')).toEqual({ id: 'c', body: '改', draft: true, meta: '草稿，还没发出' })
    expect(commentRow({ id: 'c', hunk: 0, body: '改', state: 'sent', sentAt: NOW - 3600_000 }, NOW, 'zh-Hans').meta).toBe('已发出 · 14:00')
    expect(commentRow({ id: 'c', hunk: 0, body: '改', state: 'sent' }, NOW, 'en').meta).toBe('Sent')
    expect(commentRow({ id: 'c', hunk: 0, body: '改', state: 'resolved' }, NOW, 'en')).toEqual({ id: 'c', body: '改', draft: false, meta: null })
  })
  it('按块分', () => {
    const f = file({ comments: [{ id: 'a', hunk: 0, body: '1', state: 'draft' }, { id: 'b', hunk: 1, body: '2', state: 'draft' }, { id: 'c', hunk: 0, body: '3', state: 'sent' }] })
    expect(hunkComments(f, 0, NOW, 'en').map(r => r.id)).toEqual(['a', 'c'])
    expect(hunkComments(file(), 0, NOW, 'en')).toEqual([])
  })
  it('「发出 N 条评论」:有草稿、没撤掉才给', () => {
    expect(sendBlock(turn({ pendingComments: 3 }), 'zh-Hans')).toMatchObject({ n: 3, label: '发出 3 条评论' })
    expect(sendBlock(turn({ pendingComments: 1 }), 'en')).toMatchObject({ n: 1, label: 'Send 1 comment' })
    expect(sendBlock(turn(), 'en')).toBeNull()
    expect(sendBlock(turn({ pendingComments: 2, discarded: true }), 'en')).toBeNull()
    expect(sendBlock(null, 'en')).toBeNull()
  })
})

describe('结果那一句', () => {
  it('建 / 删:成了不说话;不确定不说成功;块变了 / 已发出 / 满了 / 不在了 / 离线 / 别的', () => {
    expect(commentFailure('ok', 'zh-Hans')).toBeNull()
    expect(commentFailure({ error: 'uncertain' }, 'zh-Hans')).toBe('不确定存上没有，刷新看看。')
    expect(commentFailure({ error: 'hunk_stale' }, 'zh-Hans')).toBe('这块已经变了，刷新再看一眼。')
    expect(commentFailure({ error: 'rewind_stale' }, 'zh-Hans')).toBe('这块已经变了，刷新再看一眼。')
    expect(commentFailure({ error: 'comment_sent' }, 'zh-Hans')).toBe('这条已经发出了，删不了。')
    expect(commentFailure({ error: 'comment_limit' }, 'zh-Hans')).toBe('草稿太多了，先发出去一批。')
    expect(commentFailure({ error: 'not_found' }, 'zh-Hans')).toBe('这条已经不在了，刷新看看。')
    expect(commentFailure('busy', 'zh-Hans')).toBe('上一下还在发，稍等。')
    expect(commentFailure({ error: 'something_new' }, 'zh-Hans')).toBe('没存上，再试一次。')
  })
  it('发出:成了带数(装不下的 / 撤掉轮上的另说);超时 ⇒ 不确定,不说成功;原会话接不上 ⇒ 要在电脑上确认重新开始', () => {
    expect(sendOutcome('ok', { sent: 2, remaining: 0, skippedDiscarded: 0 }, 'zh-Hans')).toEqual({ ok: true, text: '发出了 2 条，它会照着改。' })
    expect(sendOutcome('ok', { sent: 2, remaining: 1, skippedDiscarded: 1 }, 'zh-Hans').text).toBe('发出了 2 条，它会照着改。 还有 1 条装不下，留在草稿里，再发一次。 1 条在已撤掉的轮上，没有发出。')
    const unsure = sendOutcome({ error: 'uncertain' }, null, 'zh-Hans')
    expect(unsure).toEqual({ ok: false, text: '不确定电脑那边收到没有，过一会儿看看。' })
    expect(unsure.text).not.toMatch(/发出了/)
    expect(sendOutcome({ error: 'session_changed' }, null, 'zh-Hans').text).toBe('原来的会话接不上了，要在电脑上确认重新开始。')
    expect(sendOutcome({ error: 'session_changed' }, null, 'en').text).toMatch(/on your computer/)
    expect(sendOutcome({ error: 'busy' }, null, 'zh-Hans').text).toBe('它还在写这一轮，等它答完再发。')
    expect(sendOutcome({ error: 'not_found' }, null, 'zh-Hans').ok).toBe(false)
    expect(sendOutcome({ error: 'rewind_needs_owner' }, null, 'zh-Hans').text).toBe('这件事回退时出了状况，请在电脑上处理')
    expect(sendOutcome({ error: 'whatever' }, null, 'en')).toEqual({ ok: false, text: "Didn't send. Try again." })
  })
})

describe('发出那一块的说明与投递 id', () => {
  const d = (id: string, state = 'draft') => ({ id, hunk: 0, body: 'x', state })
  it('显示不全的文件(被截 / 块对不上)上的草稿照样数进去,并说一句;更早几轮的草稿另说一句', () => {
    const t1 = turn({ pendingComments: 4, files: [
      file({ comments: [d('a'), d('s', 'sent')] }),
      file({ path: 'big.ts', diff: undefined, truncated: true, hunks: undefined, comments: [d('b')] }),
      file({ path: 'odd.ts', hunks: hunks.slice(0, 1), comments: [d('c')] }),
    ] })
    const b = sendBlock(t1, 'zh-Hans')!
    expect(b.n).toBe(4)
    expect(b.notes).toEqual(['更早几轮上的草稿也会一起发出。', '其中 2 条所在的改动这里显示不全，照样会发出。'])
    expect(sendBlock(turn({ pendingComments: 1, files: [file({ comments: [d('a')] })] }), 'zh-Hans')!.notes).toEqual([])
    expect(sendBlock(turn({ pendingComments: 1, files: [file({ path: 'x', truncated: true, diff: undefined, comments: [d('a')] })] }), 'en')!.notes).toEqual(["1 of them are on changes this page can't show in full. They still go out."])
  })
  it('key 跟着草稿变:同一批不变,换了草稿 / 数目就变', () => {
    const k = (ids: string[], n = ids.length) => sendBlock(turn({ pendingComments: n, files: [file({ comments: ids.map(i => d(i)) })] }), 'en')!.key
    expect(k(['b', 'a'])).toBe(k(['a', 'b']))
    expect(k(['a', 'b'])).not.toBe(k(['a', 'c']))
    expect(k(['a'], 1)).not.toBe(k(['a'], 2))
  })
  it('batchRequestId:同一批(不确定之后重点)沿用旧 id;草稿变了 ⇒ 新 id', () => {
    let n = 0
    const mint = () => `id-${++n}`
    const first = batchRequestId(null, 'k1', mint)
    expect(first).toEqual({ id: 'id-1', key: 'k1' })
    expect(batchRequestId(first, 'k1', mint)).toBe(first)
    expect(batchRequestId(first, 'k2', mint)).toEqual({ id: 'id-2', key: 'k2' })
  })
})
