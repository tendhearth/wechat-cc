/**
 * a2a_events store — append-only log of A2A inbound/outbound calls
 * for observability. Backed by the SQLite a2a_events table (migration v12).
 *
 * Pure persistence; no control-flow side effects. Dashboard reads from
 * recentForAgent / counts to render the activity feed.
 */
import type { Db } from '../lib/db'

const MAX_TEXT = 8192

export type EventDirection = 'in' | 'out'
export type EventStatus =
  | 'ok'
  | 'auth_failed'
  | 'http_error'
  | 'timeout'
  | 'unknown_agent'
  | 'agent_paused'
  /** Inbound notify accepted (auth passed, agent registered, not paused) but
   *  dropped because the daemon has no operator chat to route into yet
   *  (fresh setup — operator hasn't sent the bot their first message). */
  | 'dropped_no_operator_chat'

export interface AppendInput {
  direction: EventDirection
  agent_id: string
  text: string
  urgency?: 'normal' | 'critical'
  status: EventStatus
  http_status?: number
}

export interface EventRow {
  id: string
  ts: string
  direction: EventDirection
  agent_id: string
  text: string
  urgency: 'normal' | 'critical' | null
  status: EventStatus
  http_status: number | null
}

export interface A2AEventsStore {
  append(input: AppendInput): void
  recentForAgent(agentId: string, limit: number): readonly EventRow[]
  counts(agentId: string): { inbound: number; outbound: number }
}

export function makeA2AEventsStore(db: Db): A2AEventsStore {
  const stmtAppend = db.query<unknown, [string, string, EventDirection, string, string, string | null, EventStatus, number | null]>(
    'INSERT INTO a2a_events(id, ts, direction, agent_id, text, urgency, status, http_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
  const stmtRecent = db.query<EventRow, [string, number]>(
    'SELECT id, ts, direction, agent_id, text, urgency, status, http_status FROM a2a_events WHERE agent_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?',
  )
  const stmtCount = db.query<{ direction: EventDirection; cnt: number }, [string]>(
    "SELECT direction, COUNT(*) AS cnt FROM a2a_events WHERE agent_id = ? GROUP BY direction",
  )

  return {
    append(input) {
      const id = crypto.randomUUID()
      const ts = new Date().toISOString()
      const text = input.text.length > MAX_TEXT ? input.text.slice(0, MAX_TEXT) : input.text
      stmtAppend.run(
        id, ts, input.direction, input.agent_id, text,
        input.urgency ?? null,
        input.status,
        input.http_status ?? null,
      )
    },
    recentForAgent(agentId, limit) {
      return stmtRecent.all(agentId, limit)
    },
    counts(agentId) {
      const rows = stmtCount.all(agentId)
      let inbound = 0, outbound = 0
      for (const r of rows) {
        if (r.direction === 'in') inbound = r.cnt
        else if (r.direction === 'out') outbound = r.cnt
      }
      return { inbound, outbound }
    },
  }
}
