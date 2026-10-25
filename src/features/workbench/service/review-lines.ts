/**
 * 行评论 + 按块撤回 / 恢复的写动作(行评论设计稿 2026-10-21,切片 2)。review 域的一部分,
 * 共用件(落点、门、投递、块缓存)由 review.ts 传进来;这里不碰别的域。
 */
import { createHash } from 'node:crypto'
import { GIT_REVIEW_MIME, type GitReview, type ReviewFile } from '../git-review'
import type { LiveInput } from '../../../adapters/store/workbench/live-inputs'
import { normalizeInputRequestId } from '../../../adapters/store/workbench/live-inputs'
import { composeCommentsText, derivedCommentsRequestId, type CommentForText, type RevertedHunkForText } from '../review'
import { anchorFromDiff, locateHunks, switchHunks, type Hunk, type HunkSide } from '../review-hunks'
import { commentView, laterTouchLookup, type ReviewCommentView } from '../review-annotations'
import { assertNotRewindBlocked } from '../../../adapters/store/workbench/rewind-store'
import type { ServiceCtx } from './ctx'
import type { WorkbenchTaskView } from './types'
import { atomicReplace, readCurrentText } from './review-write'

const COMMENT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
export const MAX_DRAFTS_PER_TASK = 50, MAX_COMMENTS_PER_ROUND = 200
export const MERGED_NOTE = '只改独立工作区,项目里已经合进去的不变'

export type ReviewCommentInput =
  | { commentId: string; artifactId: string; path: string; hunk: number; hunkSha256: string; rowStart?: number; rowEnd?: number; body: string }
  | { commentId: string; body: string }
  | { commentId: string; delete: true }
export type ReviewCommentResult = { comment: ReviewCommentView } | { deleted: string }
export interface SendCommentsCounts { sent: number; remaining: number; skippedDiscarded: number }
export type SendCommentsResult = ({ input: LiveInput } | { task: WorkbenchTaskView }) & SendCommentsCounts
export interface HunkActionInput { artifactId: string; path: string; hunk: number; hunkSha256: string; action: 'revert' | 'restore' }
export interface HunkActionResult { path: string; hunk: number; state: 'reverted' | 'restored'; unchanged?: true }

/** review.ts 给的共用件。 */
export interface ReviewLineDeps {
  reviewTarget(id: string, artifactId: string): { artifact: { id: string; sha256: string }; review: GitReview }
  markableFile(review: GitReview, path: string): ReviewFile
  readReviewSnapshot(artifact: { mime: string; storagePath: string; sha256: string }): GitReview | null
  text(value: unknown, required: boolean): string
  hunksOf(artifactSha256: string, file: ReviewFile): Hunk[] | null
  /** 撤回类写动作的门;anyRun = 这件事有 run 就拒(哪怕答复过)。回 {merged} 给事件加一句。 */
  writeGate(id: string, anyRun: boolean): { root: string; merged: boolean }
  deliver(id: string, text: string, ids: { given?: string; derive: (scope: string) => string; continueId?: string; restartToken?: string }, done: (requestId: string) => void): WorkbenchTaskView | Promise<LiveInput>
}

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const span = (start: number, count: number) => count <= 1 ? `${start}` : `${start}–${start + count - 1}`
const hunkKey = (artifactSha256: string, path: string, index: number) => `${artifactSha256}\0${path}\0${index}`

export function makeReviewLines(ctx: ServiceCtx, deps: ReviewLineDeps) {
  const { store } = ctx

  /** 轮次(旧 → 新,1 起)+ 每轮快照;回退撤掉的轮带标。 */
  function rounds(id: string) {
    const discarded = store.rewinds.discarded(id)
    // 同 reviewList:review mime 的成果都算一轮(读不出的那轮也占位,轮号才对得上)
    const list = store.artifacts(id).filter(a => a.mime === GIT_REVIEW_MIME).map(a => ({ a, review: deps.readReviewSnapshot(a) })).reverse()
    const byId = new Map(list.map((r, i) => [r.a.id, { ...r, round: i + 1, discarded: discarded.has(r.a.id) }]))
    const bySha = new Map([...byId.values()].map(r => [r.a.sha256, r]))
    const later = laterTouchLookup(list.map(r => ({ artifactId: r.a.id, discarded: discarded.has(r.a.id), paths: new Set(r.review?.files.map(f => f.path) ?? []) })))
    return { byId, bySha, later }
  }

  /** 按块翻:当前内容 + 块 ⇒ 现在每块在哪一侧(证明「文件 = 快照的 after 翻了几块」)。 */
  function locate(current: string, hunks: Hunk[], afterSha256: string): HunkSide[] | null {
    const allNew = hunks.map(() => 'new' as const)
    return locateHunks(current, hunks, state => { const full = switchHunks(current, hunks, state, allNew); return full !== null && sha(full) === afterSha256 })
  }

  return {
    locate,
    reviewComment(id: string, input: ReviewCommentInput): ReviewCommentResult {
      if (!input || typeof input !== 'object' || typeof input.commentId !== 'string' || !COMMENT_ID.test(input.commentId)) throw new Error('invalid_review_reference')
      const commentId = input.commentId.toLowerCase()
      store.get(id)
      assertNotRewindBlocked(store.rewinds, id)
      if ('delete' in input) {
        if (input.delete !== true) throw new Error('invalid_review_reference')
        // 幂等:已经不在了(删过一次、回包丢了)⇒ 照样回 deleted,什么都不动
        if (store.reviewComments.remove(id, commentId)) ctx.hub.touched(id)
        return { deleted: commentId }
      }
      const body = deps.text(input.body, true)
      if (!('artifactId' in input)) {
        const row = store.reviewComments.get(commentId)
        if (!row || row.taskId !== id) throw new Error('review_comment_not_found')
        if (store.rewinds.discarded(id).has(row.artifactId)) throw new Error('review_round_discarded')
        const next = store.reviewComments.edit(id, commentId, body)
        ctx.hub.touched(id)
        return { comment: commentView(next) }
      }
      const { artifact, review } = deps.reviewTarget(id, input.artifactId)
      const file = deps.markableFile(review, input.path)
      // 锚点由服务端从快照算;客户端只给块序号 + 块 sha + 块内行
      const anchor = anchorFromDiff(file.diff, input.hunk, input.hunkSha256, input.rowStart, input.rowEnd)
      // 同一个 id 重试 ⇒ 交给 store 判幂等 / 冲突,不算新的一条
      const existing = store.reviewComments.get(commentId)
      if (existing && existing.taskId !== id) throw new Error('review_comment_conflict')
      if (!existing) {
        if (store.reviewComments.countDrafts(id) >= MAX_DRAFTS_PER_TASK) throw new Error('review_comment_limit')
        if (store.reviewComments.list(id).filter(c => c.artifactId === artifact.id).length >= MAX_COMMENTS_PER_ROUND) throw new Error('review_comment_limit')
      }
      const row = store.reviewComments.create({
        id: commentId, taskId: id, artifactId: artifact.id, artifactSha256: artifact.sha256, path: file.path,
        hunkIndex: input.hunk, hunkSha256: anchor.hunk.sha256,
        ...(input.rowStart !== undefined ? { rowStart: input.rowStart } : {}), ...(input.rowEnd !== undefined ? { rowEnd: input.rowEnd } : {}),
        side: anchor.side, lineStart: anchor.lineStart, lineEnd: anchor.lineEnd, quote: anchor.quote, body,
      })
      ctx.hub.touched(id)
      return { comment: commentView(row) }
    },

    /**
     * 发出这件事的所有草稿:按轮 / 路径 / 块 / 行拼成一段,连同还没告知的「撤回了这几块」。
     * 投递同打回(deliver):在写 ⇒ workbench_busy;答复过 ⇒ submitInput;结束了 ⇒ continueTask。
     * **投递成功之后**才在一个事务里把这批记成已发出、撤回记成已告知;投不出去草稿原样留着。
     */
    sendReviewComments(id: string, input: { summary?: string; inputRequestId?: string; restartToken?: string }): SendCommentsResult | Promise<SendCommentsResult> {
      const summary = deps.text(input.summary, false)
      const given = input.inputRequestId === undefined ? undefined : normalizeInputRequestId(input.inputRequestId)
      store.get(id)
      assertNotRewindBlocked(store.rewinds, id)
      const { byId, bySha, later } = rounds(id)
      const drafts = store.reviewComments.list(id).filter(c => c.state === 'draft')
      let skippedDiscarded = 0
      const items: CommentForText[] = []
      for (const c of drafts) {
        const r = byId.get(c.artifactId)
        // 撤掉的轮(或快照已经读不出)上的草稿:跳过,不发
        if (!r || r.discarded || !r.review || r.a.sha256 !== c.artifactSha256) { skippedDiscarded++; continue }
        items.push({ id: c.id, round: r.round, path: c.path, hunkIndex: c.hunkIndex, rowStart: c.rowStart, createdAt: c.createdAt, side: c.side, lineStart: c.lineStart, lineEnd: c.lineEnd, quote: c.quote, body: c.body, ...(later(c.artifactId, c.path) !== undefined ? { laterTouched: true } : {}) })
      }
      if (!items.length) throw new Error('review_comment_not_found')
      // 还没告诉执行者的撤回:比最近一次回退新、那一轮没撤掉、块 sha 还对得上
      const since = store.rewinds.latest(id)?.createdAt ?? 0
      const reverts: RevertedHunkForText[] = []
      for (const e of store.reviewHunks.list(id)) {
        if (e.state !== 'reverted' || e.notifiedAt !== null || e.createdAt <= since) continue
        const r = bySha.get(e.artifactSha256)
        const file = r && !r.discarded ? r.review?.files.find(f => f.path === e.path) : undefined
        const hunk = file ? deps.hunksOf(e.artifactSha256, file)?.[e.hunkIndex] : undefined
        if (!r || !hunk || hunk.sha256 !== e.hunkSha256) continue
        reverts.push({ key: hunkKey(e.artifactSha256, e.path, e.hunkIndex), round: r.round, path: e.path, hunkIndex: e.hunkIndex, oldStart: hunk.oldStart, oldCount: hunk.oldCount })
      }
      const composed = composeCommentsText(items, { summary, reverts })
      const chosen = items.filter(c => composed.sent.includes(c.id))
      const told = reverts.filter(r => composed.reverts.includes(r.key))
      const composedRows = new Map(drafts.filter(c => composed.sent.includes(c.id)).map(c => [c.id, { body: c.body, updatedAt: c.updatedAt }]))
      const counts = { sent: chosen.length, remaining: composed.remaining, skippedDiscarded }
      const derive = (scope: string) => derivedCommentsRequestId(chosen, summary, composed.reverts, scope)
      const done = (requestId: string) => {
        store.atomic(() => {
          // 只记拼进文本的那一版:投递途中又改过的那条留在草稿里(发出去的是旧正文)
          store.reviewComments.markSent(id, composed.sent, requestId, Date.now(), composedRows)
          store.reviewHunks.markNotified(id, told.map(r => { const [artifactSha256, path, index] = r.key.split('\0'); return { artifactSha256: artifactSha256!, path: path!, hunkIndex: Number(index) } }))
          store.addEvent(id, 'system', `已把 ${chosen.length} 条行评论发给执行者。`)
        })
        ctx.hub.touched(id)
      }
      const result = deps.deliver(id, composed.text, { ...(given ? { given } : {}), derive, ...(input.restartToken !== undefined ? { restartToken: input.restartToken } : {}) }, done)
      return result instanceof Promise ? result.then(receipt => ({ input: receipt, ...counts })) : { task: result, ...counts }
    },

    /**
     * 按块撤回 / 恢复(设计稿九步)。每一条不过都拒绝;盘上内容无状态判,留痕表从不参与写入。
     */
    revertReviewHunk(id: string, input: HunkActionInput): HunkActionResult {
      if (input.action !== 'revert' && input.action !== 'restore') throw new Error('invalid_request')
      if (typeof input.path !== 'string' || !input.path) throw new Error('invalid_review_reference')
      const fail = 'review_revert_unavailable'
      // 1–2. 落点:没撤掉的轮、可标记、只认 modified 且 diff / 两个 sha 都在
      const { artifact, review } = deps.reviewTarget(id, input.artifactId)
      const file = deps.markableFile(review, input.path)
      if (file.kind !== 'modified' || !file.diff || !file.beforeSha256 || !file.afterSha256) throw new Error(fail)
      // 3. 门:这件事有 run 就拒(磁盘还在变);回退停住、检查 / 脚本在跑、工作区已删
      const { root, merged } = deps.writeGate(id, true)
      // 4. 块
      const hunks = deps.hunksOf(artifact.sha256, file)
      if (!hunks) throw new Error(fail)
      if (!Number.isInteger(input.hunk) || input.hunk < 0 || input.hunk >= hunks.length) throw new Error('invalid_review_reference')
      const h = input.hunk, hunk = hunks[h]!
      if (hunk.sha256 !== input.hunkSha256) throw new Error('review_hunk_stale')
      // 5. 读盘 + 证明
      const { text: current, mode } = readCurrentText(root, file.path, fail)
      if (current === null) throw new Error('review_file_changed')
      const want: HunkSide = input.action === 'revert' ? 'old' : 'new'
      let next: string | null
      try {
        const state = locate(current, hunks, file.afterSha256)
        if (!state) throw new Error('review_file_changed')
        // 6. 已经是目标 ⇒ 文件不写;留痕照样补一笔(上次写完盘、没来得及记就崩了的那种),同状态的 upsert 不动原行
        if (state[h] === want) {
          store.reviewHunks.set({ taskId: id, artifactSha256: artifact.sha256, path: file.path, hunkIndex: h, hunkSha256: hunk.sha256, state: input.action === 'revert' ? 'reverted' : 'restored' })
          return { path: file.path, hunk: h, state: input.action === 'revert' ? 'reverted' : 'restored', unchanged: true }
        }
        // 7. 翻这一块,再证一遍
        const target = state.map((s, i) => i === h ? want : s)
        next = switchHunks(current, hunks, state, target)
        if (next === null) throw new Error('review_file_changed')
        // 全旧 ⇒ 就该是改动前那份;否则往返翻回全新必须还是 after
        if (target.every(s => s === 'old')) { if (sha(next) !== file.beforeSha256) throw new Error(fail) }
        else { const back = switchHunks(next, hunks, target, hunks.map(() => 'new' as const)); if (back === null || sha(back) !== file.afterSha256) throw new Error(fail) }
      } catch (error) {
        // 超大内容之类的意外 ⇒ 安全失败
        if (error instanceof Error && (error.message === 'review_file_changed' || error.message === fail)) throw error
        throw new Error(fail)
      }
      // 8. 原子写回(原始字节)
      atomicReplace(root, file.path, Buffer.from(next, 'utf8'), mode, fail)
      // 9. 留痕 + 事件
      const state = input.action === 'revert' ? 'reverted' as const : 'restored' as const
      store.reviewHunks.set({ taskId: id, artifactSha256: artifact.sha256, path: file.path, hunkIndex: h, hunkSha256: hunk.sha256, state })
      const where = input.action === 'revert'
        ? (hunk.oldCount ? `原第 ${span(hunk.oldStart, hunk.oldCount)} 行` : `原第 ${hunk.oldStart} 行之后新加的内容`)
        : (hunk.newCount ? `第 ${span(hunk.newStart, hunk.newCount)} 行` : `又删掉原第 ${span(hunk.oldStart, hunk.oldCount)} 行`)
      store.addEvent(id, 'system', `${input.action === 'revert' ? '已撤回' : '已恢复'} ${file.path} 的第 ${h + 1} 块改动(${where})。${merged ? `${MERGED_NOTE}。` : ''}`)
      ctx.hub.touched(id)
      return { path: file.path, hunk: h, state }
    },
    /** 整文件撤销后:这个文件的每块都记成 reverted。 */
    logAllReverted(id: string, artifactSha256: string, path: string, hunks: Hunk[]) {
      store.atomic(() => { for (const hunk of hunks) store.reviewHunks.set({ taskId: id, artifactSha256, path, hunkIndex: hunk.index, hunkSha256: hunk.sha256, state: 'reverted' }) })
    },
  }
}
export type ReviewLines = ReturnType<typeof makeReviewLines>
