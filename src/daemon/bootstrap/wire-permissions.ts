/**
 * wire-permissions.ts — busy-registry / project resolver / permissionMode /
 * conversationStore / per-session canUseTool builder. 从 bootstrap/index.ts
 * 逐字搬出(2026-09-27 bootstrap 拆分,spec 2026-09-27-bootstrap-split-design);
 * 块内逻辑与注释不变,只参数化:deps.db/stateDir/log → ctx.*。
 */
import { join } from 'node:path'
import { makeBusyRegistry } from '../busy-registry'
import { makeResolver } from '../../domain/project-resolver'
import { makeCanUseTool } from '../../adapters/executors/claude/permission-relay'
import type { PermissionMode } from '../../domain/capability-matrix'
import { makeConversationStore } from '../../adapters/store/conversation-store'
import type { ConversationStore } from '../../ports/conversation-store'
import { resolveEffectiveTier } from '../../domain/user-tier'
import { loadAccess } from '../../lib/access'
import { loadCompanionConfig } from '../../lib/companion-config'
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
  deps: Pick<BootstrapDeps, 'loadProjects' | 'fallbackProject' | 'dangerouslySkipPermissions' | 'conversationStore' | 'ilink' | 'chatOwnerRules'>,
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
    // Task 13 — tier resolution: access.json-derived tier for THIS session's
    // chatId (admin/trusted/guest), captured at spawn so concurrent inbound on
    // other chats can't flip it. --dangerously lifts admin/trusted to admin but
    // 访客永不提权(2026-10-10):以前这里对谁都回 admin,访客会话 SDK 是 strict、canUseTool 照样触发,
    // 却按 admin 放行插件 MCP(wxvault = 主人的微信记录)—— 和别处一样走 resolveEffectiveTier。
    resolveTier: () => resolveEffectiveTier(chatId, loadAccess(), permissionMode),
    log: ctx.log,
    // Per-dispatch mode lookup: read THIS session's current mode from
    // the conversation store at the moment the tool call arrives.
    // chatId is bound at spawn; only the mode kind is dynamic (operator
    // can flip /solo /cc /codex /both mid-session).
    mode: () => conversationStore.get(chatId)?.mode.kind ?? 'solo',
    provider: 'claude',
    permissionMode,
    // 主人自己的对话走放行规则(2026-10-25)。主人与否不看上面的 resolveTier(--dangerously 下 trusted 也是 admin),
    // 由 chatOwnerRules.isOwnerChat 按 access.json 的 admins 现算。
    ...(deps.chatOwnerRules ? { ownerRules: deps.chatOwnerRules } : {}),
  })

  return { busyRegistry, resolve, permissionMode, conversationStore, buildCanUseTool }
}
