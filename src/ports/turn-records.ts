import type { TurnRecord } from '../domain/turn-record'

/**
 * 回合记录的读口(GET /v1/turns、随身 CC 首屏的聊天日摘要)。M3b 起从这件对话的轮读(adapters/store/chat-turn-records.ts);
 * M3c(v99)起 turn_records 这张表删了,这里只剩形状。
 */
/** A persisted TurnRecord — the coordinator's TurnRecord plus the row id. */
export interface StoredTurnRecord extends TurnRecord {
  /** 这一轮调过的工具名(去重)。v35 之前的老行恒为空数组 —— 那表示
   *  「不知道」,不是「没调工具」。 */
  toolCalls: string[]
  id: string
}

export interface TurnRecordStore {
  append(record: TurnRecord): void
  /** Newest-first, capped at `limit`, for one chat. */
  recentForChat(chatId: string, limit: number): readonly StoredTurnRecord[]
  /** Newest-first across all chats, capped at `limit`. */
  recent(limit: number): readonly StoredTurnRecord[]
}
