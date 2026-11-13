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
import {ledgerText,LEDGER_DATA_HEAD,LEDGER_DATA_END} from '../../adapters/store/matter-ledger'
import type {MatterNote} from '../../ports/matters'
import type { Db } from '../../lib/db'
import { isScratchMatter, topicMatterAccess, type TopicSourceContext } from '../../lib/topic-provenance'
import { isRoutineTopicText } from '../../domain/topic-noise'

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

export { isScratchMatter } from '../../lib/topic-provenance'

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

interface MatterRow { kind: string; title: string; project_path: string | null; state: string }
const eligible = (m: MatterRow) => ['task', 'terminal', 'act'].includes(m.kind) && !isScratchMatter(m.title, m.project_path)
interface Segment { ask: string | null; firstCursor: number; last: { text: string; at: number; cursor: number } | null; closed: boolean }

function matterRow(db: Db, id: string): MatterRow | null {
  return db.query<MatterRow, [string]>('SELECT kind, title, project_path, state FROM matters WHERE id = ?').get(id) ?? null
}

/** 按主人的话切段,每段记最后那条 agent 回话。 */
function segments(db: Db, matterId: string, upTo: number): Segment[] {
  const items = db.query<{ kind: string; payload_json: string; created_at: number; cursor: number }, [string, number]>(
    `SELECT kind, payload_json, created_at, cursor FROM matter_items
     WHERE matter_id = ? AND kind IN ('user_message','agent_message') AND cursor <= ? ORDER BY seq`,
  ).all(matterId, upTo)
  const segs: Segment[] = []
  let cur: Segment | null = null
  for (const it of items) {
    const t = textOf(it.payload_json)
    if (it.kind === 'user_message') {
      if (cur) cur.closed = true
      cur = { ask: t || null, firstCursor: it.cursor, last: null, closed: false }
      segs.push(cur)
    } else {
      if (!t) continue
      if (!cur) { cur = { ask: null, firstCursor: it.cursor, last: null, closed: false }; segs.push(cur) }
      cur.last = { text: t, at: it.created_at, cursor: it.cursor }
    }
  }
  return segs
}

function hasLedger(db:Db,id:string):boolean {return !!db.query('SELECT 1 FROM matter_agents WHERE matter_id=? AND position=2 LIMIT 1').get(id)}
function ledgerResult(db:Db,id:string):string {
  const rows=db.query<MatterNote,[string]>("SELECT run_id AS runId,author,kind,text FROM matter_notes WHERE matter_id=? AND kind IN ('note','artifact') ORDER BY id").all(id)
  const runs=[...new Set(rows.map(r=>r.runId))].slice(-3)
  const budget=Math.floor((RESULT_MAX-LEDGER_DATA_HEAD.length-LEDGER_DATA_END.length-runs.length)/Math.max(1,runs.length))
  const workspace=db.query<{path:string},[string]>('SELECT path FROM workbench_tasks WHERE id=?').get(id)?.path??db.query<{path:string|null},[string]>('SELECT project_path AS path FROM matters WHERE id=?').get(id)?.path
  const memoryText=(text:string)=>{
    let value=ledgerText(text).replace(/\s+工作区 [\s\S]*$/,'')
    if(workspace)value=value.split(workspace.replace(/[\\/]$/,'')+'/').join('').split(workspace+'\\').join('').split(workspace).join('项目')
    // Explicit executor notes/fallback may also quote absolute output paths outside the project.
    return value.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s<>`"，、；。]+|(?<![A-Za-z0-9_\/])(?:[A-Za-z]:[\\/]|\/)[^\s<>`"，、；。]+/gi,path=>/^[a-z][a-z0-9+.-]*:\/\//i.test(path)&&!/^file:/i.test(path)?path:path.replace(/\\/g,'/').split('/').filter(Boolean).at(-1)??'')
  }
  const safe=(value:unknown)=>JSON.stringify(value).replace(/</g,'\\u003c').replace(/>/g,'\\u003e')
  const lines=runs.map(run=>{
    const own=rows.filter(r=>r.runId===run),note=own.filter(r=>r.kind==='note').at(-1),artifact=own.filter(r=>r.kind==='artifact').at(-1)
    const base={author:`执行者 ${ledgerText((note??artifact)!.author)}`,note:'',artifact:''}
    let room=Math.max(0,budget-safe(base).length)
    const n=note?memoryText(note.text):'',a=artifact?memoryText(artifact.text):''
    let value={...base,note:cap(n,Math.floor(room/3)),artifact:cap(a,Math.floor(room*2/3))}
    while(safe(value).length>budget&&room>0){room--;value={...base,note:cap(n,Math.floor(room/3)),artifact:cap(a,Math.floor(room*2/3))}}
    return safe(value)
  })
  return LEDGER_DATA_HEAD+lines.join('\n')+LEDGER_DATA_END
}
function toResult(db:Db,id: string, m: MatterRow, s: Segment): WorkResult {
  return {
    matterId: id, kind: m.kind, title: m.title,
    project: m.project_path ? m.project_path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? null : null,
    state: m.state, ask: s.ask ? cap(s.ask, ASK_MAX) : null, result: hasLedger(db,id)?ledgerResult(db,id):cap(s.last!.text,RESULT_MAX),
    at: new Date(s.last!.at).toISOString(), cursor: s.last!.cursor,
  }
}

/** T3:这件事刚做完的那一轮的结论(水位之后最后那段的最后一条 agent 回话);没有 ⇒ null。调用方知道这一轮已经结束,不看 SETTLE_MS。 */
export function readMatterConclusion(db: Db, matterId: string, afterCursor: number, context: TopicSourceContext): WorkResult | null {
  const m = matterRow(db, matterId)
  if (!m || !eligible(m) || !topicMatterAccess(db, context, [matterId]).entryAllowed.has(matterId)) return null
  const segs = segments(db, matterId, Number.MAX_SAFE_INTEGER).filter(s => s.last && s.last.cursor > afterCursor)
  const s = segs[segs.length - 1]
  return s && !isRoutineTopicText(s.last!.text) ? toResult(db,matterId, m, s) : null
}

/**
 * 读水位之后做完了的结论。`nextCursor`:下一拍的水位 —— 有没做完的段 ⇒ 停在最早那段的第一条之前;否则 = 这次看到的最大 cursor。
 */
export function readWorkResults(db: Db, afterCursor: number, context: TopicSourceContext, now: number = Date.now()): { results: WorkResult[]; nextCursor: number } {
  const fresh = db.query<{ matter_id: string; cursor: number }, [number, number]>(
    `SELECT i.matter_id, i.cursor FROM matter_items i
     WHERE i.cursor > ? AND i.kind IN ('user_message','agent_message')
     ORDER BY i.cursor LIMIT ?`,
  ).all(afterCursor, SCAN_LIMIT)
  if (fresh.length === 0) return { results: [], nextCursor: afterCursor }
  const scanTop = fresh[fresh.length - 1]!.cursor
  const matterIds = [...new Set(fresh.map(r => r.matter_id))]

  const allowed = topicMatterAccess(db, context, matterIds).entryAllowed
  const results: WorkResult[] = []
  let holdAt = Infinity
  for (const id of matterIds) {
    const m = matterRow(db, id)
    if (!m || !eligible(m) || !allowed.has(id)) continue
    // T3 已经写回过话题的那几段不再交(不重复记)
    const writtenBack = db.query<{ c: number | null }, [string]>('SELECT MAX(written_back_cursor) AS c FROM matter_topics WHERE matter_id = ?').get(id)?.c ?? 0
    const matterDone = DONE_STATES.has(m.state)
    const allSegments=segments(db,id,scanTop)
    const selected=hasLedger(db,id)?allSegments.filter(s=>s.last).slice(-1):allSegments
    for (const s of selected) {
      if (!s.last || s.last.cursor <= afterCursor) continue
      if (isRoutineTopicText(s.last.text)) continue
      const settled = s.closed || matterDone || now - s.last.at >= SETTLE_MS
      if (!settled) { holdAt = Math.min(holdAt, s.firstCursor); continue }
      if (s.last.cursor <= writtenBack) continue
      results.push(toResult(db,id, m, s))
    }
  }
  results.sort((a, b) => a.cursor - b.cursor)
  const nextCursor = holdAt === Infinity ? scanTop : Math.max(afterCursor, holdAt - 1)
  // 停在没做完的段前面时,只交出它之前的结论 —— 否则下一拍从 holdAt 起会再交一遍它之后的那些。
  return { results: results.filter(r => r.cursor <= nextCursor), nextCursor }
}
