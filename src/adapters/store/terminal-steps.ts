import type { Db } from '../../lib/db'
import type { MatterLog } from '../../ports/matters'
import { STEP_KEY_PREFIX, type TerminalReadState, type TerminalStepStore, type TerminalStepPayload } from '../../ports/terminal-steps'

/**
 * terminal-steps.ts —— 终端会话记录读进来的步存在哪(M4b)。步只经 MatterLog 写(matter_items);读到哪了在 terminal_reads(v98)。
 * 新的步挂在这件事正在跑的那一轮上(没有就不挂)。apply 一个事务:步和读到哪了一起落,不会读过了却没写上。
 */
const PENDING_MAX = 500
export function makeTerminalStepStore(deps: { db: Db; log: MatterLog; matters: { findBySurface(surface: 'cli', key: string): { id: string } | null } }): TerminalStepStore {
  const { db, log, matters } = deps
  const runningTurn = (matterId: string) => db.query<{ id: string }, [string]>("SELECT id FROM matter_turns WHERE matter_id=? AND status='running' ORDER BY seq DESC LIMIT 1").get(matterId)?.id ?? null
  const like = `${STEP_KEY_PREFIX}%`
  const apply = db.transaction((matterId: string, writes: Parameters<TerminalStepStore['apply']>[1], state: TerminalReadState) => {
    const turnId = runningTurn(matterId)
    for (const w of writes) {
      const fresh = !log.item(matterId, w.key)
      log.writeItem({ matterId, ...(fresh && turnId ? { turnId } : {}), kind: w.kind, status: w.status, key: w.key, payload: w.payload })
    }
    const ids = Object.keys(state.pending)
    const pending = ids.length > PENDING_MAX ? Object.fromEntries(ids.slice(-PENDING_MAX).map(id => [id, state.pending[id]!])) : state.pending
    db.query('INSERT INTO terminal_reads(matter_id,path,offset,gen,pending_json,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(matter_id) DO UPDATE SET path=excluded.path,offset=excluded.offset,gen=excluded.gen,pending_json=excluded.pending_json,updated_at=excluded.updated_at')
      .run(matterId, state.path, state.offset, state.gen, JSON.stringify(pending), Date.now())
  })
  // seq 在就地更新时不变。游标绑定这件事,并验证它确实指向一条终端步。
  const cursor = (matterId: string, seq: number) => Buffer.from(`1:${matterId}:${seq}`).toString('base64url')
  const anchor = db.query<{ seq: number }, [string, string, number]>('SELECT seq FROM matter_items WHERE matter_id=? AND item_key LIKE ? AND seq=?')
  const page = db.query<{ seq: number; payload_json: string }, [string, string, number, number]>('SELECT seq, payload_json FROM matter_items WHERE matter_id=? AND item_key LIKE ? AND seq<? ORDER BY seq DESC LIMIT ?')
  return {
    matterOf: (sessionId) => matters.findBySurface('cli', sessionId)?.id ?? null,
    readState(matterId) {
      const r = db.query<{ path: string; offset: number; gen: number; pending_json: string }, [string]>('SELECT path, offset, gen, pending_json FROM terminal_reads WHERE matter_id=?').get(matterId)
      return r ? { path: r.path, offset: r.offset, gen: r.gen, pending: JSON.parse(r.pending_json) as TerminalReadState['pending'] } : null
    },
    item(matterId, key) {
      if (!key.startsWith(STEP_KEY_PREFIX)) return null
      return log.item(matterId, key)?.payload ?? null
    },
    last(matterId) {
      const r = db.query<{ item_key: string; payload_json: string }, [string, string]>('SELECT item_key, payload_json FROM matter_items WHERE matter_id=? AND item_key LIKE ? ORDER BY seq DESC LIMIT 1').get(matterId, like)
      return r ? { key: r.item_key, payload: JSON.parse(r.payload_json) as Record<string, unknown> } : null
    },
    apply: (matterId, writes, state) => apply(matterId, writes, state),
    page(matterId, limit, before) {
      let seq = Number.MAX_SAFE_INTEGER
      if (before !== undefined) {
        const decoded = Buffer.from(before, 'base64url').toString('utf8')
        seq = Number(decoded.slice(decoded.lastIndexOf(':') + 1))
        if (!Number.isSafeInteger(seq) || seq < 1 || cursor(matterId, seq) !== before || !anchor.get(matterId, like, seq)) return null
      }
      const rows = page.all(matterId, like, seq, limit + 1)
      const earlier = rows.length > limit ? cursor(matterId, rows[limit - 1]!.seq) : null
      return { items: rows.slice(0, limit).reverse().map(row => ({ ...(JSON.parse(row.payload_json) as TerminalStepPayload), id: row.seq.toString(36) })), earlier }
    },
    recent(matterId, max) {
      return db.query<{ payload_json: string }, [string, string, number]>('SELECT payload_json FROM matter_items WHERE matter_id=? AND item_key LIKE ? ORDER BY seq DESC LIMIT ?').all(matterId, like, max)
        .reverse().map(r => JSON.parse(r.payload_json) as Record<string, unknown>)
    },
  }
}
