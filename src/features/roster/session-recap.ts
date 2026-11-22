import type { SessionRecapT } from '@wechat-cc/protocol'
import type { Db } from '../../lib/db'
import { localTopicContext, topicMatterAccess } from '../../lib/topic-provenance'
import type { CheapEval } from '../../ports/agent-provider'
import { parseRecap, recapPrompt, type RecapStep } from './recap-prompt'
import { readAwaySummary } from './recap-transcript'

export const RECAP_IDLE_MS = 30 * 60_000
export const RECAP_INTERVAL_MS = 5 * 60_000
const CALL_LIMIT = 8
type Session = {
  id: string; matterId: string; source: string; path: string | null; activity: number
  replyAt: number; prompts: number; running: number; waiting: number; position: string
}
type Saved = { text: string | null; source: SessionRecapT['source']; at: number; position: string; away_from: number }
type Settings = { enabled(): boolean; setEnabled(value: boolean): void }

export function makeSessionRecaps(deps: {
  db: Db
  settings: Settings
  owner: () => string | null
  seenSince: (matterId: string, since: number) => boolean
  evaluator: () => CheapEval | null
  holdBusy: (label: string) => () => void
  now?: () => number
  transcript?: typeof readAwaySummary
  log?: (tag: string, line: string) => void
}) {
  const { db, settings } = deps
  const now = deps.now ?? Date.now
  const startedAt = now()
  let active = false, stopped = false, generation = 0
  let request: AbortController | undefined
  // Permissions outrank the running turn, as in the terminal session store.
  const sessionSql = `SELECT c.session_id AS id,b.matter_id AS matterId,c.source,c.transcript_path AS path,
    max(c.last_event_at,coalesce(c.last_prompt_at,0),m.updated_at,
      coalesce((SELECT max(updated_at) FROM matter_items WHERE matter_id=m.id),0)) AS activity,
    coalesce((SELECT max(coalesce(json_extract(payload_json,'$.at'),created_at))
      FROM matter_items WHERE matter_id=m.id AND kind='agent_message'),0) AS replyAt,
    (SELECT count(*) FROM matter_items WHERE matter_id=m.id AND kind='user_message') AS prompts,
    EXISTS(SELECT 1 FROM matter_turns WHERE matter_id=m.id AND status='running') AS running,
    EXISTS(SELECT 1 FROM matter_items WHERE matter_id=m.id AND kind='permission' AND status='started') AS waiting,
    json_array(m.id,m.cursor,c.last_event_at,c.last_prompt_at,m.updated_at) AS position
    FROM cli_sessions c JOIN matter_bindings b ON b.surface='cli' AND b.surface_key=c.session_id
    JOIN matters m ON m.id=b.matter_id AND m.kind='terminal'
    WHERE m.archived_at IS NULL AND m.state <> 'done'
      AND (SELECT count(*) FROM matter_bindings WHERE surface='cli' AND surface_key=c.session_id)=1
      AND (SELECT count(*) FROM matter_bindings WHERE surface='cli' AND matter_id=m.id)=1`

  const allowed = (owner: string, sessions: Session[]) =>
    topicMatterAccess(db, localTopicContext(owner), sessions.map(s => s.matterId)).entryAllowed
  function session(owner: string, id: string) {
    const row = db.query<Session, [string]>(sessionSql + ' AND c.session_id=?').get(id)
    return row && allowed(owner, [row]).has(row.matterId) ? row : null
  }
  const saved = (id: string) => db.query<Saved, [string]>(
    'SELECT text,source,at,position,away_from FROM terminal_recaps WHERE session_id=?',
  ).get(id)
  const position = (owner: string, row: Session) => JSON.stringify([owner, row.position])
  const running = (row: Session) => row.running && !row.waiting
  const eligible = (row: Session, owner: string, at: number) =>
    row.prompts >= 3 && !running(row) && at - row.activity >= RECAP_IDLE_MS
    && !deps.seenSince(row.matterId, at - RECAP_IDLE_MS) && saved(row.id)?.position !== position(owner, row)

  function material(matterId: string) {
    // Fetch at most 1,500 characters per step from SQLite, even if the stored full text is large.
    const rows = db.query<RecapStep, [string]>(`
      SELECT CASE kind WHEN 'user_message' THEN 'you' ELSE 'said' END AS who,
        substr(coalesce(json_extract(payload_json,'$.full'),json_extract(payload_json,'$.text')),1,1500) AS text
      FROM matter_items WHERE matter_id=? AND kind IN ('user_message','agent_message')
        AND length(trim(coalesce(json_extract(payload_json,'$.full'),json_extract(payload_json,'$.text'))))>0
      ORDER BY seq DESC LIMIT 6000
    `).iterate(matterId)
    let left = 6000
    const steps: RecapStep[] = []
    // What it is waiting on may exist only in the request itself; it goes last and is budgeted first.
    const ask = db.query<{ tool: string | null; summary: string | null }, [string]>(`
      SELECT json_extract(payload_json,'$.tool') AS tool,substr(json_extract(payload_json,'$.summary'),1,500) AS summary
      FROM matter_items WHERE matter_id=? AND kind='permission' AND status='started' ORDER BY seq DESC LIMIT 1
    `).get(matterId)
    const asks = [ask?.tool, ask?.summary].filter(part => typeof part === 'string' && part.trim()).join(': ')
    if (asks) left -= [...asks].length
    for (const row of rows) {
      const text = [...row.text.trim()].slice(0, left).join('')
      if (!text) continue
      steps.push({ who: row.who, text })
      left -= [...text].length
      if (!left) break
    }
    steps.reverse()
    if (asks) steps.push({ who: 'asks', text: asks })
    return steps
  }

  const day = () => {
    const local = new Date(now())
    const pad = (value: number) => String(value).padStart(2, '0')
    return `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`
  }
  function reserve(id: string) {
    return db.query(`INSERT INTO terminal_recaps(session_id,call_day,call_count) VALUES(?,?,1)
      ON CONFLICT(session_id) DO UPDATE SET call_count=CASE WHEN call_day=excluded.call_day THEN call_count+1 ELSE 1 END,
        call_day=excluded.call_day
      WHERE call_day<>excluded.call_day OR call_count<?`).run(id, day(), CALL_LIMIT).changes > 0
  }

  // saved and called use up the scan's budget; blocked means the model route is shut for now.
  async function write(row: Session, owner: string, epoch: number, allowModel: boolean): Promise<'saved' | 'called' | 'blocked' | 'none'> {
    const start = now()
    let source: SessionRecapT['source'] = 'claude'
    let code = 'unavailable'
    let attempted = false, dispatched = false, declined = false
    let release: (() => void) | undefined
    const current = () => {
      if (stopped || generation !== epoch || !settings.enabled() || deps.owner() !== owner) return false
      const fresh = session(owner, row.id)
      return !!fresh && fresh.position === row.position && eligible(fresh, owner, now())
    }
    try {
      let text = row.source === 'claude' && row.path
        ? (deps.transcript ?? readAwaySummary)(row.path, row.replyAt) : null
      if (!text) {
        source = 'cc'
        if (!allowModel) { code = 'deferred'; return 'none' }
        const quota = db.query<{ call_count: number }, [string, string]>('SELECT call_count FROM terminal_recaps WHERE session_id=? AND call_day=?').get(row.id, day())
        if ((quota?.call_count ?? 0) >= CALL_LIMIT) { code = 'quota'; return 'none' }
        const evaluate = deps.evaluator()
        if (!evaluate) { code = 'no_private_model'; return 'none' }
        const steps = material(row.matterId)
        if (!steps.length) { code = 'no_material'; return 'none' }
        const controller = request = new AbortController()
        release = deps.holdBusy('session-recap')
        attempted = true
        const output = await evaluate(recapPrompt(steps), { singleAttempt: true, signal: controller.signal, beforeRequest() {
          if (dispatched || !current() || !reserve(row.id)) { declined = true; controller.abort() }
          controller.signal.throwIfAborted()
          dispatched = true
        } })
        if (!dispatched) { code = declined ? 'stale' : 'blocked'; return declined ? 'none' : 'blocked' }
        text = parseRecap(output)
      }
      if (!text) { code = 'bad_output'; return 'called' }
      if (!current()) { code = 'stale'; return dispatched ? 'called' : 'none' }
      db.query(`INSERT INTO terminal_recaps(session_id,text,source,at,position,away_from) VALUES(?,?,?,?,?,?)
        ON CONFLICT(session_id) DO UPDATE SET text=excluded.text,source=excluded.source,at=excluded.at,
          position=excluded.position,away_from=excluded.away_from`).run(row.id, text, source, now(), position(owner, row), row.activity)
      code = 'ready'
      return 'saved'
    } catch {
      if (dispatched) return 'called'
      if (attempted && !declined) { code = 'blocked'; return 'blocked' }
      return 'none'
    } finally {
      request = undefined
      release?.()
      if (code !== 'deferred') deps.log?.('RECAP', `${row.id.slice(0, 6)} ${source} ${now() - start}ms ${code}`)
    }
  }

  return {
    enabled: settings.enabled,
    setEnabled(value: boolean) {
      settings.setEnabled(value)
      generation++
      request?.abort()
    },
    read(id: string): SessionRecapT | undefined {
      if (!settings.enabled()) return
      try {
        const row = saved(id)
        if (!row?.text) return
        const owner = deps.owner()
        const fresh = owner && session(owner, id)
        if (!owner || !fresh || running(fresh) || position(owner, fresh) !== row.position) return
        // The start of the absence, not its length: the payload stays the same between polls.
        return { text: row.text, source: row.source, at: row.at, awayFrom: row.away_from }
      } catch { return undefined }
    },
    async check() {
      if (active || stopped || !settings.enabled()) return
      const owner = deps.owner()
      if (!owner) return
      active = true
      const epoch = generation
      const at = now()
      try {
        // Only sessions whose absence window elapsed during this daemon run can start a recap.
        const rows = db.query<Session, [number, number]>(
          `SELECT s.* FROM (${sessionSql}) s
           LEFT JOIN terminal_recaps r ON r.session_id=s.id
           WHERE s.activity BETWEEN ? AND ? AND s.prompts>=3 AND (NOT s.running OR s.waiting)
           ORDER BY coalesce(r.call_count,0), s.activity, s.id`,
        ).all(startedAt - RECAP_IDLE_MS, at - RECAP_IDLE_MS)
        const permitted = allowed(owner, rows)
        // A shut model route is not retried within the scan and takes no slot, so sessions
        // that carry their own summary are still served behind ones that need the model.
        let used = 0, allowModel = true
        for (const row of rows) {
          if (stopped || epoch !== generation || !settings.enabled() || deps.owner() !== owner) break
          if (!permitted.has(row.matterId) || !eligible(row, owner, now())) continue
          const fresh = session(owner, row.id)
          if (!fresh || fresh.position !== row.position) continue
          const outcome = await write(row, owner, epoch, allowModel)
          if (outcome === 'blocked') allowModel = false
          else if (outcome !== 'none' && ++used === 2) break
        }
      } finally { active = false }
    },
    stop() { stopped = true; request?.abort() },
  }
}

export type SessionRecaps = ReturnType<typeof makeSessionRecaps>
