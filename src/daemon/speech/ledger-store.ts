/**
 * CC 主动开口的外发账(speech_log,迁移 v84;第三批 3a)。policy.say 每次判定写一行,回答「CC 为什么说了 / 没说」。
 * **不记正文**:说过的话在 messages 里,这里只有种类、类别、结果、原因、通道。
 * 90 天前的行在写入时顺手删(一小时最多删一次),不另起定时器。
 * **账回答「为什么」,不回答「有几条」**:连着被推后的同一句话一小时只记一次(policy.ts),同一条对话里压着三条回报
 * 也只记一行。要数「有几条在等」,从各自的持久层读(回报读 matter_report_outbox、提醒读 reminders),别从这里数(整合者评审 #522)。
 */
import type { Db } from '../../lib/db'
import type { SpeechKind, SpeechOrigin } from '../../domain/speech/kinds'
import type { ProactiveChannel } from '../companion/proactive-channel'
import type { SpeechLedgerEntry } from './policy'

export const SPEECH_LOG_RETENTION_MS = 90 * 24 * 60 * 60_000
const PRUNE_EVERY_MS = 60 * 60_000

export interface SpeechLedgerStore {
  append(e: SpeechLedgerEntry): void
  /** 这条对话 sinceMs 之后的账,新的在前。 */
  recent(chatId: string, sinceMs: number, limit?: number): SpeechLedgerEntry[]
}

interface Row { at: number; kind: string; origin: string; chat_id: string; outcome: string; reason: string | null; channel: string | null }

export function makeSpeechLedgerStore(db: Db, opts: { now?: () => number } = {}): SpeechLedgerStore {
  const now = opts.now ?? Date.now
  let lastPrune = Number.NEGATIVE_INFINITY
  return {
    append(e) {
      db.query('INSERT INTO speech_log(at,kind,origin,chat_id,outcome,reason,channel) VALUES(?,?,?,?,?,?,?)')
        .run(Date.parse(e.ts), e.kind, e.origin, e.chatId, e.outcome, e.reason, e.channel)
      const t = now()
      if (t - lastPrune >= PRUNE_EVERY_MS) {
        lastPrune = t
        db.query('DELETE FROM speech_log WHERE at < ?').run(t - SPEECH_LOG_RETENTION_MS)
      }
    },
    recent(chatId, sinceMs, limit = 200) {
      const rows = db.query('SELECT at,kind,origin,chat_id,outcome,reason,channel FROM speech_log WHERE chat_id = ? AND at >= ? ORDER BY at DESC, id DESC LIMIT ?')
        .all(chatId, sinceMs, limit) as Row[]
      return rows.map(r => ({
        kind: r.kind as SpeechKind, origin: r.origin as SpeechOrigin, chatId: r.chat_id,
        outcome: r.outcome as SpeechLedgerEntry['outcome'], reason: r.reason, channel: r.channel as ProactiveChannel | null,
        ts: new Date(r.at).toISOString(),
      }))
    },
  }
}
