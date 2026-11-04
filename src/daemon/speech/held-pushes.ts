/**
 * 被门压着的 App 推送(speech/push-gate.ts)落在主库 `speech_pending`(lane = 'push',v101;S2b)。
 * 以前只在内存里,daemon 一重启夜里压着的推送就没了(主人 11-04 拍板:重启不丢)。
 * ref = 同一件事的键(种类 + 任务 + 请求):同一件事只留最新那一条。
 */
import type { Db } from '../../lib/db'
import type { SpeechKind } from '../../domain/speech/kinds'
import type { PushPayload } from '../../features/phone'

export interface HeldPush { id: string; key: string; kind: SpeechKind; chatId: string; payload: PushPayload; until: number }

export interface HeldPushes {
  /** 压一条(同 key 的旧那条换掉);回现在压着的条数。 */
  hold(h: { key: string; kind: SpeechKind; chatId: string; payload: PushPayload; until: number; expiresAt: number; at: number }): number
  /** 到点的(按到点时刻、入队先后排),最多 limit 条。 */
  due(nowMs: number, limit: number): HeldPush[]
  /** 又被推后了:改到点时刻。 */
  reschedule(id: string, until: number): void
  remove(id: string): void
  /** 最早的到点时刻;没有 ⇒ null。 */
  nextDue(): number | null
  /** 过期的删掉,回给调用方记账。 */
  expire(nowMs: number): HeldPush[]
  /** 超过上限 ⇒ 删最老的那几条,回被删的 key。 */
  trim(max: number): string[]
}

interface Row { id: string; ref: string; kind: string; chat_id: string; body: string; next_at: number }

const toHeld = (r: Row): HeldPush => ({ id: r.id, key: r.ref, kind: r.kind as SpeechKind, chatId: r.chat_id, payload: JSON.parse(r.body) as PushPayload, until: r.next_at })
const COLS = 'id,ref,kind,chat_id,body,next_at'

export function makeHeldPushes(db: Db): HeldPushes {
  return {
    hold(h) {
      return db.transaction(() => {
        db.query("DELETE FROM speech_pending WHERE lane='push' AND ref=?").run(h.key)
        db.query(`INSERT INTO speech_pending(id,lane,chat_id,kind,body,attach,ref,created_at,next_at,attempts,first_failed_at,expires_at,status)
          VALUES(?,'push',?,?,?,NULL,?,?,?,0,NULL,?,'pending')`)
          .run(`push-${h.at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`, h.chatId, h.kind, JSON.stringify(h.payload), h.key, h.at, h.until, h.expiresAt)
        return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM speech_pending WHERE lane='push'").get()!.n
      })()
    },
    due(nowMs, limit) {
      return db.query<Row, [number, number]>(`SELECT ${COLS} FROM speech_pending WHERE lane='push' AND next_at <= ? ORDER BY next_at, created_at, rowid LIMIT ?`).all(nowMs, limit).map(toHeld)
    },
    reschedule(id, until) { db.query("UPDATE speech_pending SET next_at=? WHERE lane='push' AND id=?").run(until, id) },
    remove(id) { db.query("DELETE FROM speech_pending WHERE lane='push' AND id=?").run(id) },
    nextDue() {
      return db.query<{ t: number | null }, []>("SELECT MIN(next_at) AS t FROM speech_pending WHERE lane='push'").get()!.t
    },
    expire(nowMs) {
      return db.transaction(() => {
        const rows = db.query<Row, [number]>(`SELECT ${COLS} FROM speech_pending WHERE lane='push' AND expires_at <= ? ORDER BY created_at, rowid`).all(nowMs).map(toHeld)
        db.query("DELETE FROM speech_pending WHERE lane='push' AND expires_at <= ?").run(nowMs)
        return rows
      })()
    },
    trim(max) {
      return db.transaction(() => {
        const over = db.query<{ id: string; ref: string }, [number]>("SELECT id,ref FROM speech_pending WHERE lane='push' ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?").all(max)
        for (const r of over) db.query('DELETE FROM speech_pending WHERE id=?').run(r.id)
        return over.map(r => r.ref)
      })()
    },
  }
}
