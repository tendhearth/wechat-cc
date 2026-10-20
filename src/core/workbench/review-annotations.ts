import { parseHunks, type Hunk } from './review-hunks'
import type { ReviewComment } from './review-comments'
import type { ReviewHunkEntry } from './review-hunk-log'

/**
 * reviewList 给每个文件加的两样(行评论设计稿,切片 1,只读):块清单与这一轮上的行评论。
 * 都是 optional 字段,老客户端不看就不受影响。纯函数,服务端在 reviewList 里拼。
 */
export interface ReviewHunkView {
  index: number; sha256: string; header: string
  oldStart: number; oldCount: number; newStart: number; newCount: number
  /** 块体行数(不含 `\ No newline` 标记行);客户端自己切 diff 后拿它和 sha 对一下。 */
  rows: number
  /** 主人撤回过这一块,且比这件事最近一次回退 / 撤销回退新 —— 只是小签,写入从不信它。 */
  reverted?: { at: number }
}
export interface ReviewCommentView {
  id: string; hunk: number; rowStart?: number; rowEnd?: number
  side?: 'old' | 'new'; lineStart?: number; lineEnd?: number
  body: string; state: 'draft' | 'sent'; sentAt?: number
  /** 之后没撤掉的轮里最早又改过这个文件的那一轮(1 起);没有就不带。 */
  laterTouched?: number
}

/** 块清单:只给 diff 解析得了的文件;解析不了 ⇒ undefined(界面照旧显示整段)。 */
export function hunkViews(diff: string | undefined, revertedAt: (index: number, sha256: string) => number | undefined, parse: (diff: string) => Hunk[] | null = parseHunks): ReviewHunkView[] | undefined {
  if (!diff) return undefined
  const hunks = parse(diff)
  if (!hunks) return undefined
  return hunks.map(h => {
    const at = revertedAt(h.index, h.sha256)
    return { index: h.index, sha256: h.sha256, header: h.header, oldStart: h.oldStart, oldCount: h.oldCount, newStart: h.newStart, newCount: h.newCount, rows: h.rows.length, ...(at !== undefined ? { reverted: { at } } : {}) }
  })
}

/** 留痕表 ⇒ 「这一块现在该不该标已撤回」:reverted、块 sha 对得上、比 since(最近一次回退 / 撤销回退)新。 */
export function revertedLookup(entries: readonly ReviewHunkEntry[], since: number) {
  const map = new Map<string, ReviewHunkEntry>()
  for (const e of entries) if (e.state === 'reverted' && e.createdAt > since) map.set(`${e.artifactSha256}\0${e.path}\0${e.hunkIndex}`, e)
  return (artifactSha256: string, path: string) => (index: number, sha256: string): number | undefined => {
    const e = map.get(`${artifactSha256}\0${path}\0${index}`)
    return e && e.hunkSha256 === sha256 ? e.createdAt : undefined
  }
}

export function commentView(c: ReviewComment, laterTouched?: number): ReviewCommentView {
  return {
    id: c.id, hunk: c.hunkIndex,
    ...(c.rowStart !== null ? { rowStart: c.rowStart } : {}), ...(c.rowEnd !== null ? { rowEnd: c.rowEnd } : {}),
    ...(c.side !== null ? { side: c.side } : {}), ...(c.lineStart !== null ? { lineStart: c.lineStart } : {}), ...(c.lineEnd !== null ? { lineEnd: c.lineEnd } : {}),
    body: c.body, state: c.state, ...(c.sentAt !== null ? { sentAt: c.sentAt } : {}),
    ...(laterTouched !== undefined ? { laterTouched } : {}),
  }
}

/**
 * 轮次(旧 → 新,round = 下标 + 1)⇒ 「这一轮的这个文件,之后最早哪一轮又改过」。撤掉的轮不算。
 * 从不据此说「已解决」。
 */
export function laterTouchLookup(rounds: ReadonlyArray<{ artifactId: string; discarded: boolean; paths: ReadonlySet<string> }>) {
  const position = new Map(rounds.map((r, i) => [r.artifactId, i]))
  return (artifactId: string, path: string): number | undefined => {
    const from = position.get(artifactId)
    if (from === undefined) return undefined
    for (let i = from + 1; i < rounds.length; i++) if (!rounds[i]!.discarded && rounds[i]!.paths.has(path)) return i + 1
    return undefined
  }
}
