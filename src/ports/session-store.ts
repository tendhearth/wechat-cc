/**
 * 会话续接表的口(架构终态 E5):(alias, provider, chat_id) → SDK session_id。实现在
 * src/adapters/store/session-store.ts(SQLite);app 的会话管理只经这里认它的形状。只有类型,没有逻辑。
 */
import type { ProviderId } from '../domain/conversation'

export interface SessionRecord {
  /**
   * Echo of the row's PK alias column. New in v0.6 (Task 8) — callers
   * iterating `all()` need this because `all()` is now keyed by the
   * composite `${alias}|${provider}|${chatId}` string, not by alias
   * alone. Always present on records read out of the store.
   */
  alias: string
  session_id: string
  last_used_at: string  // ISO
  /**
   * Which agent provider produced this session_id. Always present —
   * the SQLite schema's PK is (alias, provider, chat_id) NOT NULL. Legacy
   * v0.x JSON records that lacked the field are defaulted to 'claude' at
   * migration time (see LEGACY_PROVIDER below).
   */
  provider: ProviderId
  /**
   * Per-chat scope for the resume key. v0.6 Task 7 added this so a
   * single project alias can power N chats with independent tiers /
   * resume points. Pre-tier rows migrated from v0.5 land here as
   * '_legacy'; new writes always carry the real chatId.
   */
  chat_id: string
  summary?: string      // 1-line LLM summary, cached
  summary_updated_at?: string  // when summary was last refreshed
}

/**
 * Composite key required by every read/write on the store. The triple
 * (alias, provider, chatId) maps 1:1 to the SQLite PRIMARY KEY — there's
 * no "most-recently-used row across providers" lookup any more because
 * chat scopes mean that query was ambiguous in the multi-chat world.
 */
export interface SessionStoreKey {
  alias: string
  provider: ProviderId
  chatId: string
}

export interface SessionStore {
  /**
   * Returns the stored record for the (alias, provider, chatId) triple,
   * or null if no row exists. Unlike pre-v0.6, there is no fallback to
   * "latest across providers" — callers know which chat + provider they
   * are resuming.
   */
  get(key: SessionStoreKey): SessionRecord | null
  set(key: SessionStoreKey & { sessionId: string }): void
  setSummary(key: SessionStoreKey, summary: string): void
  /**
   * Forget every provider row for an (alias, chatId) — e.g. /reset on a
   * single chat. The other chats bound to the same alias keep their
   * resume points.
   */
  delete(key: { alias: string; chatId: string }): void
  /**
   * Forget just one (alias, provider, chatId) row — used when a single
   * provider's resume point is stale (jsonl gone, TTL exceeded) while
   * the sibling provider's row is still valid. Calling delete() here
   * instead would also wipe the still-valid sibling.
   */
  deleteOne(key: SessionStoreKey): void
  /**
   * Forget EVERY row of one provider, across aliases and chats. Used when the
   * provider's pinned model changes: releasing the live sessions is not enough
   * because the next spawn would resume from a stored session id, and a resumed
   * session keeps the model it was opened with (ACP `session/load` carries no
   * model, Claude/Codex resume the same thread) — "改了但没生效" all over again.
   * Returns how many rows were dropped, so the caller can report it honestly.
   */
  deleteProvider(provider: ProviderId): number
  /**
   * Per-chat twin of `deleteProvider` — forget EVERY row for one (provider,
   * chatId), across aliases. Used when a single chat's pinned model changes
   * (`/cursor <model>`, `/api <model>`, …): releasing the live sessions for
   * that pair is not enough because the next spawn would resume from a
   * stored session id, and a resumed session keeps the model it was opened
   * with — the same 「改了但没生效」 the provider-wide fix addresses, just
   * scoped to one chat instead of every chat on that provider.
   * Returns how many rows were dropped, so the caller can report it honestly.
   */
  deleteProviderChat(provider: ProviderId, chatId: string): number
  /**
   * Returns every row keyed by `${alias}|${provider}|${chatId}`. Callers
   * that previously assumed alias-keyed snapshot must now read
   * `rec.alias` (and rec.chat_id) from the value.
   */
  all(): Record<string, SessionRecord>
  flush(): Promise<void>
}
