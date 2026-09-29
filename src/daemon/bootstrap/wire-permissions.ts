/**
 * wire-permissions.ts — busy-registry / project resolver / permissionMode /
 * conversationStore / per-session canUseTool builder. 从 bootstrap/index.ts
 * 逐字搬出(2026-09-27 bootstrap 拆分,spec 2026-09-27-bootstrap-split-design);
 * 块内逻辑与注释不变,只参数化:deps.db/stateDir/log → ctx.*。
 */
import { join } from 'node:path'
import { makeBusyRegistry } from '../../core/busy-registry'
import { makeResolver } from '../../core/project-resolver'
import { makeCanUseTool } from '../../core/permission-relay'
import type { PermissionMode } from '../../core/capability-matrix'
import { makeConversationStore, type ConversationStore } from '../../core/conversation-store'
import { resolveTier } from '../../core/user-tier'
import { loadAccess } from '../../lib/access'
import { loadCompanionConfig } from '../companion/config'
import { resolveAdminChatId } from '../companion/resolve-admin'
import type { Bootstrap, BootstrapDeps, BootstrapCtx } from './types'

export interface PermissionsSlice {
  busyRegistry: ReturnType<typeof makeBusyRegistry>
  resolve: Bootstrap['resolve']
  permissionMode: PermissionMode
  conversationStore: ConversationStore
  buildCanUseTool: (chatId: string) => ReturnType<typeof makeCanUseTool>
}

export function wirePermissions(
  deps: Pick<BootstrapDeps, 'loadProjects' | 'fallbackProject' | 'dangerouslySkipPermissions' | 'conversationStore' | 'ilink'>,
  ctx: Pick<BootstrapCtx, 'db' | 'stateDir' | 'log'>,
): PermissionsSlice {
  // busy-registry (spec 2026-08-11 §1) — the "work is happening" complement
  // to SessionManager's anyInFlight(): long tasks that never go through
  // SessionManager (A2A delegate, customer-review, social forage/respond,
  // internal-api non-GET requests, companion ticks) each hold a token here
  // for their duration. Constructed unconditionally (same posture as
  // `health` above) so every hold point below has something real to call —
  // `holdBusy` is exposed on Bootstrap regardless of whether self-restart
  // itself is enabled (deps.requestRestart may be absent), since the other
  // consumers (internal-api, customer-review, delegate, wireSocial,
  // companion schedulers) don't depend on self-restart being wired.
  const busyRegistry = makeBusyRegistry()

  const resolve = makeResolver({
    loadProjects: deps.loadProjects,
    fallback: deps.fallbackProject,
  })

  const permissionMode: PermissionMode = deps.dangerouslySkipPermissions ? 'dangerously' : 'strict'

  // Hoisted from below: canUseTool's per-dispatch mode lookup reads
  // from this store. Bootstrap's later code uses the SAME instance —
  // assigning it here just brings the creation up so the closure has a
  // live reference instead of one needing a forward declaration.
  const conversationStore = deps.conversationStore ?? makeConversationStore(
    ctx.db,
    { migrateFromFile: join(ctx.stateDir, 'conversations.json') },
  )

  // Per-session canUseTool builder — closes over the boot-time deps
  // (askUser, adminChatId resolver, log, provider, permissionMode,
  // conversationStore) and bakes the session's OWN `chatId` into the
  // tier/mode closures. Previously canUseTool was built once at bootstrap
  // and read `deps.lastActiveChatId()` per call — a process-wide ref.
  // Under concurrent dispatch (chat A mid-turn while chat B sends an
  // inbound) the lastActiveChatId could flip to B's id between when A
  // initiated a tool call and when canUseTool fired, cross-resolving
  // A's tier as B's and either auto-allowing A's destructive Bash (if B
  // is admin) or denying B's MCP call (if A is guest).
  //
  // Binding chatId at spawn time eliminates that race: each session's
  // canUseTool closure resolves tier/mode for its OWN chatId, regardless
  // of what arrived after.
  const buildCanUseTool = (chatId: string) => makeCanUseTool({
    askUser: deps.ilink.askUser,
    // initiatingChatId is the session's own chatId, baked in at spawn.
    // (The relay only uses this for log correlation; prompts always route
    // to adminChatId.)
    initiatingChatId: () => chatId,
    // Task 13 — permission prompts route to a configured admin chat, NOT
    // the chat that initiated the dispatch. Closes a self-approval hole
    // where a guest who could trigger a tool call could also click 'allow'
    // on their own request.
    adminChatId: () => resolveAdminChatId(loadAccess(), loadCompanionConfig(ctx.stateDir), chatId),
    // Task 13 — tier resolution rules:
    //   - dangerouslySkipPermissions=true  → every chat is admin tier
    //     (global override; old default-allow path's new spelling).
    //   - otherwise → access.json-derived tier for THIS session's chatId
    //     (admin/trusted/guest). chatId is captured at spawn time so the
    //     resolution stays stable regardless of any concurrent inbound
    //     activity on other chats.
    resolveTier: () => {
      if (deps.dangerouslySkipPermissions) return 'admin'
      return resolveTier(chatId, loadAccess())
    },
    log: ctx.log,
    // Per-dispatch mode lookup: read THIS session's current mode from
    // the conversation store at the moment the tool call arrives.
    // chatId is bound at spawn; only the mode kind is dynamic (operator
    // can flip /solo /cc /codex /both mid-session).
    mode: () => conversationStore.get(chatId)?.mode.kind ?? 'solo',
    provider: 'claude',
    permissionMode,
  })

  return { busyRegistry, resolve, permissionMode, conversationStore, buildCanUseTool }
}
