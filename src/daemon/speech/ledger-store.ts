/**
 * CC 主动开口的外发账(speech_log,迁移 v84;第三批 3a)。policy.say 每次判定写一行,回答「CC 为什么说了 / 没说」。
 * **不记正文**:说过的话在 messages 里,这里只有种类、类别、结果、原因、通道。
 * 90 天前的行在写入时顺手删(一小时最多删一次),不另起定时器。
 * **账回答「为什么」,不回答「有几条」**:连着被推后的同一句话一小时只记一次(policy.ts),同一条对话里压着三条回报
 * 也只记一行。要数「有几条在等」,从各自的持久层读(回报读 matter_report_outbox、提醒读 reminders),别从这里数(整合者评审 #522)。
 *
 * **带 ref 的(同一个事件的键,v103;S3a)同一个 ref 只有一行**:没有就插;有了就改那一行 —— 结果 / 原因 / 时刻换成这一次的,
 * 通道追加(`app+wechat`)。例外:那一行已经是 allowed,这一次不是(另一条路被推后 / 失败)⇒ 不改(这件事已经说到了,
 * 日志里照样有那一次)。不带 ref 的照旧一判一行。
 */
import type { Db } from '../../lib/db'
import type { SpeechKind, SpeechOrigin } from '../../domain/speech/kinds'
import type { SpeechLedgerEntry } from './policy'

export const SPEECH_LOG_RETENTION_MS = 90 * 24 * 60 * 60_000
const PRUNE_EVERY_MS = 60 * 60_000

export interface SpeechLedgerStore {
  append(e: SpeechLedgerEntry): void
  lastInitiativeAt(chatId: string): number | null
  /** 这条对话 sinceMs 之后的账,新的在前。带 ref 的那一行通道可能是追加过的(`app+wechat`)。 */
  recent(chatId: string, sinceMs: number, limit?: number): SpeechLedgerRow[]
}

interface Row { at: number; kind: string; origin: string; chat_id: string; outcome: string; reason: string | null; channel: string | null; ref: string | null }

/** 通道追加:`app` + `wechat` ⇒ `app+wechat`;已有的不重复。 */
export function mergeChannels(a: string | null, b: string | null): string | null {
  const parts = [...(a ? a.split('+') : []), ...(b ? b.split('+') : [])].filter(Boolean)
  return parts.length ? [...new Set(parts)].join('+') : null
}

/** 读回来的一行:通道是存下的原样(带 ref 的可能是 `app+wechat`)。 */
export type SpeechLedgerRow = Omit<SpeechLedgerEntry, 'channel'> & { channel: string | null }

export function makeSpeechLedgerStore(db: Db, opts: { now?: () => number } = {}): SpeechLedgerStore {
  const now = opts.now ?? Date.now
  let lastPrune = Number.NEGATIVE_INFINITY
  return {
    lastInitiativeAt(chatId) {
      return db.query<{ at: number | null }, [string]>("SELECT MAX(spoken_at) AS at FROM speech_log WHERE chat_id=? AND origin='initiative'").get(chatId)?.at ?? null
    },
    append(e) {
      const ref = e.ref ?? null
      const prev = ref === null ? null : db.query<{ id: number; outcome: string; channel: string | null }, [string]>('SELECT id,outcome,channel FROM speech_log WHERE ref = ? ORDER BY id LIMIT 1').get(ref)
      if (prev) {
        if (e.spokenAt !== undefined) db.query("UPDATE speech_log SET kind=CASE WHEN spoken_at IS NULL THEN ? ELSE kind END,origin=CASE WHEN spoken_at IS NULL THEN ? ELSE origin END,spoken_at=COALESCE(spoken_at,?),delivery_state='confirmed' WHERE id=?").run(e.kind, e.origin, e.spokenAt, prev.id)
        if (prev.outcome === 'allowed' && e.outcome !== 'allowed') return
        db.query('UPDATE speech_log SET at=?,outcome=?,reason=?,channel=? WHERE id=?')
          .run(Date.parse(e.ts), e.outcome, e.reason, mergeChannels(prev.channel, e.channel), prev.id)
        return
      }
      db.query('INSERT INTO speech_log(at,kind,origin,chat_id,outcome,reason,channel,ref,spoken_at,delivery_state) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(Date.parse(e.ts), e.kind, e.origin, e.chatId, e.outcome, e.reason, e.channel, ref, e.spokenAt ?? null, e.spokenAt === undefined ? 'unconfirmed' : 'confirmed')
      const t = now()
      if (t - lastPrune >= PRUNE_EVERY_MS) {
        lastPrune = t
        db.query('DELETE FROM speech_log WHERE at < ?').run(t - SPEECH_LOG_RETENTION_MS)
      }
    },
    recent(chatId, sinceMs, limit = 200) {
      const rows = db.query('SELECT at,kind,origin,chat_id,outcome,reason,channel,ref FROM speech_log WHERE chat_id = ? AND at >= ? ORDER BY at DESC, id DESC LIMIT ?')
        .all(chatId, sinceMs, limit) as Row[]
      return rows.map(r => ({
        kind: r.kind as SpeechKind, origin: r.origin as SpeechOrigin, chatId: r.chat_id,
        outcome: r.outcome as SpeechLedgerEntry['outcome'], reason: r.reason, channel: r.channel,
        ts: new Date(r.at).toISOString(),
        ...(r.ref !== null ? { ref: r.ref } : {}),
      }))
    },
  }
}
