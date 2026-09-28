/**
 * wire-a2a.ts — A2A registry / client / events store + resolveOperatorChatId。
 * 从 bootstrap/index.ts 逐字搬出(2026-09-27 bootstrap 拆分,spec
 * 2026-09-27-bootstrap-split-design);块内逻辑与注释不变,只参数化:
 * deps.stateDir/db → ctx.*。`cachedOperatorChatId` 那个 `let` 是缓存不是晚绑定,
 * 随函数留在这里(不改 Ref)。wireA2aServer 仍在 index 里(它本来就是 wire-*)。
 */
import { createA2ARegistry, type A2ARegistry } from '../../core/a2a-registry'
import { createA2AClient, type A2AClient } from '../../core/a2a-client'
import { makeA2AEventsStore, type A2AEventsStore } from '../../core/a2a-events-store'
import type { BootstrapCtx } from './types'

export interface A2aSlice {
  a2aRegistry: A2ARegistry
  a2aClient: A2AClient
  a2aEventsStore: A2AEventsStore
  resolveOperatorChatId: () => string | null
}

export function wireA2a(ctx: Pick<BootstrapCtx, 'stateDir' | 'db'>): A2aSlice {
  // ── A2A wiring ────────────────────────────────────────────────────────
  // Instantiate registry, client, events store. These are cheap objects
  // that don't require a2a_listen to be configured — they're also used
  // by POST /v1/a2a/send (outbound calls from the MCP tool).
  const a2aRegistry = createA2ARegistry({ stateDir: ctx.stateDir })
  const a2aClient = createA2AClient()
  const a2aEventsStore = makeA2AEventsStore(ctx.db)

  // Helper: resolve operator chat. v1 = earliest-updated_at conversation
  // row (first chat the operator ever used; most stable identity).
  //
  // Cache only POSITIVE hits: on a fresh install the conversations table
  // is empty until the operator sends their first WeChat message. If we
  // also cached `null`, every A2A notify that arrived before that first
  // message would be permanently dropped as `dropped_no_operator_chat`
  // — even after the operator binds — until daemon restart.
  let cachedOperatorChatId: string | null = null
  function resolveOperatorChatId(): string | null {
    if (cachedOperatorChatId) return cachedOperatorChatId
    const row = ctx.db.query<{ chat_id: string }, []>(
      'SELECT chat_id FROM conversations ORDER BY updated_at ASC LIMIT 1',
    ).get()
    if (row?.chat_id) cachedOperatorChatId = row.chat_id
    return cachedOperatorChatId
  }

  return { a2aRegistry, a2aClient, a2aEventsStore, resolveOperatorChatId }
}
