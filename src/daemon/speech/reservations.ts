import type { Db } from '../../lib/db'
import type { SpeechKind } from '../../domain/speech/kinds'

export const INITIATIVE_INTERVAL_MS = 20 * 3600_000
export type ReserveResult = { ok: true } | { ok: false; reason: 'duplicate' | 'occupied' | 'interval' }

/** No lease expiry can turn a possibly delivered send into a retry. */
export function makeSpeechReservations(db: Db) {
  const lastOccupiedAt = (recipient: string): number | null => {
    const spoken = db.query<{ at: number | null }, [string]>("SELECT MAX(spoken_at) AS at FROM speech_log WHERE chat_id=? AND origin='initiative'").get(recipient)?.at ?? null
    const unknown = db.query<{ at: number | null }, [string]>("SELECT MAX(created_at) AS at FROM speech_pending WHERE lane='reservation' AND chat_id=? AND status='unknown'").get(recipient)?.at ?? null
    return spoken === null ? unknown : unknown === null ? spoken : Math.max(spoken, unknown)
  }
  const duplicate = (ref: string, resumeConfirmed = false): boolean => {
    const previous = db.query<{ status: string }, [string]>("SELECT status FROM speech_pending WHERE lane='reservation' AND ref=?").get(ref)
    return !!previous && !(resumeConfirmed && previous.status === 'done' && db.query('SELECT id FROM speech_log WHERE ref=? AND spoken_at IS NOT NULL').get(ref))
  }
  return {
    duplicate,
    lastOccupiedAt,
    /** Once at boot, before accepting proposals. Reserved had not begun a send. */
    recover() {
      db.transaction(() => {
        db.query("DELETE FROM speech_pending WHERE lane='reservation' AND status='reserved'").run()
        db.query("UPDATE speech_pending SET status='unknown' WHERE lane='reservation' AND status='sending'").run()
      })()
    },
    available(recipient: string, now: number, scheduled = false): boolean {
      if (db.query("SELECT id FROM speech_pending WHERE lane='reservation' AND chat_id=? AND status IN ('reserved','sending')").get(recipient)) return false
      const at = lastOccupiedAt(recipient)
      return scheduled || at === null || now - at >= INITIATIVE_INTERVAL_MS
    },
    reserve(p: { ref: string; recipient: string; kind: SpeechKind; now: number; scheduled?: boolean; resumeConfirmed?: boolean; payload: object }): ReserveResult {
      return db.transaction((): ReserveResult => {
        const previous = db.query<{ status: string }, [string]>("SELECT status FROM speech_pending WHERE lane='reservation' AND ref=?").get(p.ref)
        if (previous && !(p.resumeConfirmed && previous.status === 'done' && db.query('SELECT id FROM speech_log WHERE ref=? AND spoken_at IS NOT NULL').get(p.ref))) return { ok: false, reason: 'duplicate' }
        if (db.query("SELECT id FROM speech_pending WHERE lane='reservation' AND chat_id=? AND status IN ('reserved','sending')").get(p.recipient)) return { ok: false, reason: 'occupied' }
        const at = lastOccupiedAt(p.recipient)
        if (!p.scheduled && at !== null && p.now - at < INITIATIVE_INTERVAL_MS) return { ok: false, reason: 'interval' }
        if (previous) db.query("DELETE FROM speech_pending WHERE lane='reservation' AND ref=?").run(p.ref)
        db.query(`INSERT INTO speech_pending(id,lane,chat_id,kind,body,ref,created_at,next_at,expires_at,status)
          VALUES(?,'reservation',?,?,?,?,?,?,?,'reserved')`).run(`reservation:${p.ref}`, p.recipient, p.kind, JSON.stringify(p.payload), p.ref, p.now, p.now, p.now + INITIATIVE_INTERVAL_MS)
        return { ok: true }
      })()
    },
    sending(ref: string): boolean {
      return db.query("UPDATE speech_pending SET status='sending' WHERE lane='reservation' AND ref=? AND status='reserved' RETURNING id").get(ref) != null
    },
    settle(ref: string, result: 'confirmed' | 'not_sent' | 'unknown') {
      if (result === 'not_sent') db.query("DELETE FROM speech_pending WHERE lane='reservation' AND ref=?").run(ref)
      else {
        // Policy logging is best-effort. A failed ledger write must not free
        // the interval after an externally confirmed delivery.
        const persisted = result === 'confirmed' && db.query('SELECT id FROM speech_log WHERE ref=? AND spoken_at IS NOT NULL').get(ref)
        db.query("UPDATE speech_pending SET status=? WHERE lane='reservation' AND ref=?").run(persisted ? 'done' : 'unknown', ref)
      }
    },
  }
}
export type SpeechReservations = ReturnType<typeof makeSpeechReservations>
