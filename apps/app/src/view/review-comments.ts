// 行评论(切片 4,设计稿 line-review「入口」手机一条)的纯视图:手机只做整块评论(不选行)+「发出 N 条评论」;
// 按块撤回不上手机。纯 TS,不碰 react / expo。
import type { PhoneChangesTurnT } from '../backend/types'
import type { SubmitResult } from '../state/store'
import { t, type Lang } from '../i18n'
import { formatSynced } from './connection'

type File = PhoneChangesTurnT['files'][number]
type Comment = NonNullable<File['comments']>[number]

/** 正文上限(同 daemon)。 */
export const COMMENT_MAX = 2000

/** 切好的一块:daemon 的序号 / sha + 这块自己的 diff 文本。 */
export type HunkPiece = { index: number; sha256: string; header: string; text: string }

/** 块头对不对得上:daemon 把长块头裁到 200 字、末尾补 …。 */
function sameHeader(line: string, header: string): boolean {
  if (line === header) return true
  return header.endsWith('…') && line.startsWith(header.slice(0, -1))
}

/**
 * 按 daemon 的切法(`^(?=@@ )`)切这个文件的 diff,块数、序号、块头都对得上才回;否则 null(界面照旧整段显示、不给评论)。
 * sha 不在手机上算 —— 带着 daemon 给的 sha 去建,对不上 daemon 回 review_hunk_stale。
 */
export function fileHunks(f: Pick<File, 'diff' | 'hunks'>): HunkPiece[] | null {
  if (typeof f.diff !== 'string' || !f.hunks?.length) return null
  const parts = f.diff.split(/^(?=@@ )/m)
  if (parts[0] !== undefined && parts[0] !== '' && !parts[0].startsWith('@@ ')) return null
  const raw = parts.filter(p => p.startsWith('@@ '))
  if (raw.length !== f.hunks.length) return null
  const out: HunkPiece[] = []
  for (const [i, text] of raw.entries()) {
    const h = f.hunks[i]!
    const first = text.slice(0, text.indexOf('\n') < 0 ? text.length : text.indexOf('\n'))
    if (h.index !== i || !sameHeader(first, h.header)) return null
    out.push({ index: h.index, sha256: h.sha256, header: h.header, text: text.replace(/\n$/, '') })
  }
  return out
}

/** 能不能在这个文件上写评论:有轮次 id、这一轮没撤掉、路径没被裁(…开头)、块对得上。 */
export function canComment(turn: PhoneChangesTurnT | null | undefined, f: File): boolean {
  return !!turn && typeof turn.artifactId === 'string' && turn.discarded !== true && !f.path.startsWith('…') && f.kind !== 'not_reviewed' && fileHunks(f) !== null
}

/** 一条评论怎么显示:草稿(能删)/ 已发出 · 时间 / 认不得的状态(只读,不给按钮)。 */
export type CommentRow = { id: string; body: string; draft: boolean; meta: string | null }
export function commentRow(c: Comment, now: number, lang: Lang): CommentRow {
  if (c.state === 'draft') return { id: c.id, body: c.body, draft: true, meta: t(lang, 'lineReview.draft') }
  if (c.state === 'sent') return { id: c.id, body: c.body, draft: false, meta: typeof c.sentAt === 'number' ? t(lang, 'lineReview.sentAt', { time: formatSynced(c.sentAt, now, lang) }) : t(lang, 'lineReview.sent') }
  return { id: c.id, body: c.body, draft: false, meta: null }
}

/** 某一块上的评论(按 daemon 给的顺序)。 */
export function hunkComments(f: Pick<File, 'comments'>, hunk: number, now: number, lang: Lang): CommentRow[] {
  return (f.comments ?? []).filter(c => c.hunk === hunk).map(c => commentRow(c, now, lang))
}

/**
 * 「发出 N 条评论」那一块给不给:这件事有草稿、这一轮没撤掉。在不在线另算(按钮置灰)。
 * notes:更早几轮上也有草稿 / 其中 K 条所在的改动这里显示不全(照样会发出)。
 * key:这一批草稿的样子(总数 + 看得见的草稿 id);变了就该换一个投递 id。
 */
export type SendBlock = { label: string; n: number; notes: string[]; key: string }
export function sendBlock(turn: PhoneChangesTurnT | null | undefined, lang: Lang): SendBlock | null {
  const n = turn?.pendingComments ?? 0
  if (!turn || turn.discarded === true || n <= 0) return null
  const drafts = turn.files.flatMap(f => (f.comments ?? []).filter(c => c.state === 'draft').map(c => ({ id: c.id, shown: canComment(turn, f) })))
  const hidden = drafts.filter(d => !d.shown).length
  const notes: string[] = []
  if (n > drafts.length) notes.push(t(lang, 'lineReview.olderDrafts'))
  if (hidden > 0) notes.push(t(lang, 'lineReview.hiddenDrafts', { n: hidden }))
  return { n, label: n === 1 ? t(lang, 'lineReview.sendOne') : t(lang, 'lineReview.send', { n }), notes, key: `${n}|${drafts.map(d => d.id).sort().join(',')}` }
}

/**
 * 投递 id:同一批重点沿用(daemon 按它去重,不确定之后重发不会发两次);
 * 草稿变了(刷新后 key 不同)⇒ 换新的,免得新的一批撞上旧 id(input_conflict)。
 */
export function batchRequestId(prev: { id: string; key: string } | null, key: string, mint: () => string): { id: string; key: string } {
  return prev && prev.key === key ? prev : { id: mint(), key }
}

/** 建 / 删一条评论失败的那一句。 */
export function commentFailure(r: SubmitResult, lang: Lang): string | null {
  if (r === 'ok') return null
  if (r === 'busy') return t(lang, 'lineReview.inFlight')
  switch (r.error) {
    case 'uncertain': return t(lang, 'lineReview.uncertain')
    case 'hunk_stale': case 'rewind_stale': return t(lang, 'lineReview.stale')
    case 'comment_sent': return t(lang, 'lineReview.alreadySent')
    case 'comment_limit': return t(lang, 'lineReview.limit')
    case 'not_found': return t(lang, 'lineReview.gone')
    case 'offline': return t(lang, 'lineReview.offline')
    default: return t(lang, 'lineReview.failed')
  }
}

/** 发出之后那一句:成了(还剩几条装不下)/ 不确定 / 要在电脑上确认重新开始 / 在写 / 没有草稿了。 */
export function sendOutcome(r: SubmitResult, counts: { sent: number; remaining: number; skippedDiscarded: number } | null, lang: Lang): { text: string; ok: boolean } {
  if (r === 'ok') {
    const parts = [t(lang, 'lineReview.sentDone', { n: counts?.sent ?? 0 })]
    if (counts?.remaining) parts.push(t(lang, 'lineReview.remaining', { n: counts.remaining }))
    if (counts?.skippedDiscarded) parts.push(t(lang, 'lineReview.skipped', { n: counts.skippedDiscarded }))
    return { text: parts.join(' '), ok: true }
  }
  if (r === 'busy') return { text: t(lang, 'lineReview.inFlight'), ok: false }
  switch (r.error) {
    // 超时:可能已经送到了 —— 不说成功,也不说失败
    case 'uncertain': return { text: t(lang, 'lineReview.sendUncertain'), ok: false }
    // 原会话接不上(restart_confirmation_required):手机不能替主人重新开始
    case 'session_changed': return { text: t(lang, 'lineReview.needsRestart'), ok: false }
    case 'busy': return { text: t(lang, 'lineReview.writing'), ok: false }
    case 'not_found': return { text: t(lang, 'lineReview.nothingToSend'), ok: false }
    case 'rewind_needs_owner': return { text: t(lang, 'rewind.blocked'), ok: false }
    case 'offline': return { text: t(lang, 'lineReview.offline'), ok: false }
    default: return { text: t(lang, 'lineReview.sendFailed'), ok: false }
  }
}
