/**
 * 对话模式表的口(架构终态 E5):每个 chat 的模式(solo / 并行 / 群聊 …)与微信身份。实现在
 * src/adapters/store/conversation-store.ts(SQLite);app 的协调器只经这里认它的形状。只有类型,没有逻辑。
 */
import type { Mode, PersistedConversation, ProviderId } from '../domain/conversation'

export interface ConversationIdentity {
  user_id: string | null
  account_id: string | null
  last_user_name: string | null
}

export interface ConversationStore {
  /** Get the persisted mode for a chat, or null if none set. */
  get(chatId: string): PersistedConversation | null
  /** Set the mode for a chat. */
  set(chatId: string, mode: Mode): void
  /** Remove a chat's mode (revert to daemon default). */
  delete(chatId: string): void
  /** Snapshot of all persisted conversations. */
  all(): Record<string, PersistedConversation>
  /** No-op for SQLite-backed stores; retained so callers using the JSON-era API still compile. */
  flush(): Promise<void>

  /**
   * Upsert WeChat identity for a chat. Merge semantics: undefined fields
   * preserve the existing value; null fields explicitly clear it.
   * If the chat has no row yet, inserts with default mode `solo+claude`
   * (the daemon default for the vast majority of installations).
   */
  upsertIdentity(chatId: string, ids: { userId?: string; accountId?: string; userName?: string }): void

  /** Read identity columns for a chat. Null if no row exists. */
  getIdentity(chatId: string): ConversationIdentity | null

  /** All chat IDs whose row carries this account_id. Used to fan out
   *  account-expired notifications without an in-memory side index. */
  chatsForAccount(accountId: string): readonly string[]

  /**
   * Backfill or update the participants list for a parallel/chatroom row.
   * No-op if the row doesn't exist. Throws on solo/primary_tool rows.
   * Used by the coordinator's resolveParticipants helper to persist the
   * legacy 2-way backfill on first dispatch under the new code.
   */
  setParticipants(chatId: string, participants: ProviderId[] | null): void
}
