import type { Db } from '../../lib/db'
import type { TurnRecord } from '../../domain/turn-record'
import type { StoredTurnRecord, TurnRecordStore } from './turn-record-store'

/**
 * chat-turn-records.ts —— 对话的回合记录从这件对话的轮读(M3b,设计稿 2026-11-02-m3-chat-turns-design.md)。
 * 出口(`GET /v1/turns`、手机首页的「聊天日」)形状和以前读 turn_records 时一字不差:
 * 那一行的各项在收轮时记在这一轮的 policy 上(adapters/store/chat-turns.ts);chatId 是这件对话的微信绑定。
 * 写在协调器的 runner 里(经 MatterLog),这里的 append 什么都不做 —— turn_records 不再写(表留着给回滚,M3c 删)。
 */
interface Row { id: string; chat_id: string; executor: string; status: string; error_code: string | null; policy_json: string | null; started_at: number; ended_at: number }

const SELECT = `SELECT t.id, b.surface_key AS chat_id, t.executor, t.status, t.error_code, t.policy_json, t.started_at, t.ended_at
  FROM matter_turns t JOIN matters m ON m.id = t.matter_id AND m.kind = 'chat'
  JOIN matter_bindings b ON b.matter_id = m.id AND b.surface = 'wechat'
  WHERE t.status <> 'running' AND t.ended_at IS NOT NULL`

/** 没记结局的轮(M3a 部署后、M3b 之前写的那几轮)按状态和错误码推回去。 */
const outcomeOf = (r: Row, p: Record<string, unknown>): TurnRecord['outcome'] => {
  if (p.outcome === 'completed' || p.outcome === 'timeout' || p.outcome === 'auth_failed' || p.outcome === 'error') return p.outcome
  if (r.status === 'completed') return 'completed'
  return r.error_code === 'timeout' ? 'timeout' : r.error_code === 'auth_failed' ? 'auth_failed' : 'error'
}
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

function toRecord(r: Row): StoredTurnRecord {
  const p = (r.policy_json ? JSON.parse(r.policy_json) : {}) as Record<string, unknown>
  const toolCalls = Array.isArray(p.toolCalls) ? p.toolCalls.filter((x): x is string => typeof x === 'string') : []
  return {
    id: r.id,
    chatId: r.chat_id,
    provider: r.executor as TurnRecord['provider'],
    alias: typeof p.alias === 'string' ? p.alias : '_default',
    mode: (typeof p.mode === 'string' ? p.mode : 'solo') as TurnRecord['mode'],
    startedAt: r.started_at,
    endedAt: r.ended_at,
    durationMs: r.ended_at - r.started_at,
    outcome: outcomeOf(r, p),
    replyToolCalled: p.replyToolCalled === true,
    textChunks: num(p.textChunks) ?? 0,
    ...(typeof p.error === 'string' ? { error: p.error } : {}),
    toolCalls,
    ...(typeof p.delivery === 'string' ? { delivery: p.delivery as NonNullable<TurnRecord['delivery']> } : {}),
    ...(num(p.bubbles) !== undefined ? { bubbles: num(p.bubbles)! } : {}),
    ...(num(p.attachments) !== undefined ? { attachments: num(p.attachments)! } : {}),
    ...(num(p.narrationSegments) !== undefined ? { narrationSegments: num(p.narrationSegments)! } : {}),
  }
}

export function makeChatTurnRecords(db: Db): TurnRecordStore {
  return {
    append() { /* 写在 runner 里(chat-turns.ts 经 MatterLog);turn_records 不再写 */ },
    recentForChat(chatId, limit) {
      return db.query<Row, [string, number]>(`${SELECT} AND b.surface_key = ? ORDER BY t.ended_at DESC, t.cursor DESC LIMIT ?`).all(chatId, limit).map(toRecord)
    },
    recent(limit) {
      return db.query<Row, [number]>(`${SELECT} ORDER BY t.ended_at DESC, t.cursor DESC LIMIT ?`).all(limit).map(toRecord)
    },
  }
}
