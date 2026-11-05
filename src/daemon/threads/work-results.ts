/**
 * agent 的活里「做完了的那几段的结论」(话题 T1,设计稿 docs/superpowers/specs/2026-11-05-topics-t1-t3-design.md §T1 抽什么)。
 *
 * 读 MatterLog(matters + matter_items,只读):task / terminal / act 三种 matter,按主人的话(user_message)切段,
 * 每段只取最后那条 agent 回话 —— 结论,不要过程。一段算做完:后面又有主人的话 / 这件事已结束 / 最后一条已过 SETTLE_MS。
 * 没做完的段不交出去,水位停在它第一条之前,下一拍再看。
 *
 * 水位 = matter_items.cursor(全局单调)。只看 cursor > 水位的条目;一段的「要求」可能在水位之前(那句话上一拍已经读到、
 * 那时还没做完),所以每件被碰到的 matter 都从头切段,只交出结论 cursor > 水位的那几段。
 */
import type { Db } from '../../lib/db'

export const SETTLE_MS = 30 * 60_000
const ASK_MAX = 200
const RESULT_MAX = 600
/** 一拍最多看这么多条新条目(剩下的下一拍)。 */
const SCAN_LIMIT = 5000

export interface WorkResult {
  matterId: string
  kind: string
  title: string
  /** 项目文件夹名(没有 ⇒ null)。 */
  project: string | null
  state: string
  /** 那一段主人的要求(可能没有:CC 自己发起的 / 第一段前没有主人的话)。 */
  ask: string | null
  /** 最后那条 agent 回话。 */
  result: string
  /** 结论那条的时刻(ISO)。 */
  at: string
  /** 结论那条的 cursor。 */
  cursor: number
}

/** 自检 / 草稿目录里跑的不算主人的活。 */
export function isScratchMatter(title: string, projectPath: string | null): boolean {
  if (/^selftest/i.test(title.trim())) return true
  if (!projectPath) return false
  const p = projectPath.replace(/\\/g, '/')
  return /^\/(private\/)?(tmp|var\/folders)\//.test(p) || /\/wechat-cc-selftest\//.test(p) || /\/wechat-cc-eval\//.test(p) || /\/AppData\/Local\/Temp\//i.test(p)
}

function textOf(payloadJson: string): string {
  try {
    const v = JSON.parse(payloadJson) as { text?: unknown }
    return typeof v.text === 'string' ? v.text.trim() : ''
  } catch { return '' }
}

function cap(s: string, n: number): string {
  const chars = [...s]
  return chars.length > n ? chars.slice(0, n).join('') + '…' : s
}

const DONE_STATES = new Set(['done', 'failed', 'cancelled'])

/**
 * 读水位之后做完了的结论。`nextCursor`:下一拍的水位 —— 有没做完的段 ⇒ 停在最早那段的第一条之前;否则 = 这次看到的最大 cursor。
 */
export function readWorkResults(db: Db, afterCursor: number, now: number = Date.now()): { results: WorkResult[]; nextCursor: number } {
  const fresh = db.query<{ matter_id: string; cursor: number }, [number, number]>(
    `SELECT i.matter_id, i.cursor FROM matter_items i JOIN matters m ON m.id = i.matter_id
     WHERE i.cursor > ? AND m.kind IN ('task','terminal','act') AND i.kind IN ('user_message','agent_message')
     ORDER BY i.cursor LIMIT ?`,
  ).all(afterCursor, SCAN_LIMIT)
  if (fresh.length === 0) return { results: [], nextCursor: afterCursor }
  const scanTop = fresh[fresh.length - 1]!.cursor
  const matterIds = [...new Set(fresh.map(r => r.matter_id))]

  const results: WorkResult[] = []
  let holdAt = Infinity
  for (const id of matterIds) {
    const m = db.query<{ kind: string; title: string; project_path: string | null; state: string }, [string]>(
      'SELECT kind, title, project_path, state FROM matters WHERE id = ?',
    ).get(id)
    if (!m || isScratchMatter(m.title, m.project_path)) continue
    const items = db.query<{ kind: string; payload_json: string; created_at: number; cursor: number }, [string, number]>(
      `SELECT kind, payload_json, created_at, cursor FROM matter_items
       WHERE matter_id = ? AND kind IN ('user_message','agent_message') AND cursor <= ? ORDER BY seq`,
    ).all(id, scanTop)
    // 切段:每遇到一句主人的话开新段
    type Seg = { ask: string | null; firstCursor: number; last: { text: string; at: number; cursor: number } | null; closed: boolean }
    const segs: Seg[] = []
    let cur: Seg | null = null
    for (const it of items) {
      if (it.kind === 'user_message') {
        const t = textOf(it.payload_json)
        if (cur) cur.closed = true
        cur = { ask: t || null, firstCursor: it.cursor, last: null, closed: false }
        segs.push(cur)
      } else {
        const t = textOf(it.payload_json)
        if (!t) continue
        if (!cur) { cur = { ask: null, firstCursor: it.cursor, last: null, closed: false }; segs.push(cur) }
        cur.last = { text: t, at: it.created_at, cursor: it.cursor }
      }
    }
    const matterDone = DONE_STATES.has(m.state)
    for (const s of segs) {
      if (!s.last || s.last.cursor <= afterCursor) continue
      const settled = s.closed || matterDone || now - s.last.at >= SETTLE_MS
      if (!settled) { holdAt = Math.min(holdAt, s.firstCursor); continue }
      results.push({
        matterId: id, kind: m.kind, title: m.title,
        project: m.project_path ? m.project_path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? null : null,
        state: m.state, ask: s.ask ? cap(s.ask, ASK_MAX) : null, result: cap(s.last.text, RESULT_MAX),
        at: new Date(s.last.at).toISOString(), cursor: s.last.cursor,
      })
    }
  }
  results.sort((a, b) => a.cursor - b.cursor)
  const nextCursor = holdAt === Infinity ? scanTop : Math.max(afterCursor, holdAt - 1)
  // 停在没做完的段前面时,只交出它之前的结论 —— 否则下一拍从 holdAt 起会再交一遍它之后的那些。
  return { results: results.filter(r => r.cursor <= nextCursor), nextCursor }
}
