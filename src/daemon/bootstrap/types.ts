import type { SessionManager } from '../../core/session-manager'
import type { TierProfile } from '../../core/user-tier'
import type { ProviderRegistry } from '../../core/provider-registry'
import type { ConversationCoordinator, TurnRecord } from '../../core/conversation-coordinator'
import type { ConversationStore } from '../../core/conversation-store'
import { formatInbound } from '../../core/prompt-format'
import type { ProviderId } from '../../core/conversation'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { WechatProjectsDep, WechatVoiceDep, WechatCompanionDep } from '../wechat-tool-deps'
import type { Db } from '../../lib/db'
import type { AgentConfig, AgentProviderKind } from '../../lib/agent-config'
import type { AppendInput } from '../../core/a2a-events-store'
import type { YiHub } from '../../core/yi-hub'
import type { DelegateDispatch } from './delegate'
import type { SendAssistantText } from './fallback-reply'
import type { HealthRuntime } from '../health'

export interface BootstrapDeps {
  stateDir: string
  ilink: {
    sendMessage: (chatId: string, text: string) => Promise<{ msgId: string }>
    sendFile: (chatId: string, path: string) => Promise<void>
    editMessage: (chatId: string, msgId: string, text: string) => Promise<void>
    broadcast: (text: string, accountId?: string) => Promise<{ ok: number; failed: number }>
    sharePage: (title: string, content: string, opts?: { needs_approval?: boolean; chat_id?: string; account_id?: string }) => Promise<{ url: string; slug: string }>
    resurfacePage: (q: { slug?: string; title_fragment?: string }) => Promise<{ url: string; slug: string } | null>
    setUserName: (chatId: string, name: string) => Promise<void>
    projects: WechatProjectsDep
    voice: WechatVoiceDep
    companion: WechatCompanionDep
    askUser: (chatId: string, prompt: string, hash: string, timeoutMs: number) => Promise<'allow'|'deny'|'timeout'|'undelivered'>
  }
  loadProjects: () => { projects: Record<string, { path: string; last_active: number }>; current: string | null }
  lastActiveChatId: () => string | null
  /** Third `fields` arg lands in the JSONL sidecar (channel.log.jsonl) for
   *  programmatic/AI consumers — the real daemon log impl accepts it; the
   *  coordinator already relies on it for auth_failed + turn records. */
  log: (tag: string, line: string, fields?: Record<string, unknown>) => void
  /**
   * Optional persistence sink for the coordinator's per-turn TurnRecord.
   * main.ts wires this to the SQLite turn_records store so internal-api's
   * GET /v1/turns can serve them and they survive a daemon restart. Omitted
   * in tests / minimal embeddings — the JSONL log line still happens.
   */
  onTurnRecord?: (record: TurnRecord) => void
  /** Mint/invalidate per-session internal-api tokens — main.ts wires these to
   *  the internal-api token registry so each session's MCP children carry the
   *  caller's tier. Omitted in tests / minimal embeddings. */
  mintSessionToken?: (tier: import('../../core/user-tier').UserTier, sessionKey: string) => string
  invalidateSession?: (sessionKey: string) => void
  /**
   * Test/harness override for agy's tier-C global MCP config target dir
   * (ProviderDeps['agyGeminiConfigDir'], threaded straight through to
   * `setupAgyGlobalMcp`). Always undefined in production — never wire this
   * from main.ts. Exists so a test that wants to exercise the real
   * ~/.gemini/config write path can point it at a mkdtemp'd dir instead;
   * omitted under a test runner, that write is skipped entirely rather
   * than defaulting to the operator's real home dir.
   */
  agyGeminiConfigDir?: string
  /**
   * Used when projects.current is unset. Prevents silent message drops on
   * fresh installs — matches v0.x UX where messages routed to the daemon's
   * launch cwd by default.
   */
  fallbackProject?: () => { alias: string; path: string } | null
  dangerouslySkipPermissions?: boolean
  agentProviderKind?: AgentProviderKind
  /**
   * When provided, the standalone wechat-mcp stdio MCP server (RFC 03 §5)
   * is registered with both providers as `wechat`. The MCP child
   * process gets these env vars on spawn:
   *    WECHAT_INTERNAL_API        = baseUrl
   *    WECHAT_INTERNAL_TOKEN_FILE = tokenFilePath
   * Without this field, providers run with only the legacy in-process
   * `wechat` MCP — the stdio path is purely additive in P1.A. (P1.B
   * migrates the in-process tools and removes the legacy server.)
   */
  internalApi?: {
    baseUrl: string
    tokenFilePath: string
  }
  /**
   * Caller may inject a pre-built ConversationStore so the same instance
   * is shared with internal-api's reply-prefix lookup (RFC 03 P3). When
   * omitted, buildBootstrap creates its own — preserves test-time isolation
   * but means main.ts's internal-api can't see mode flips.
   */
  conversationStore?: ConversationStore
  /**
   * Daemon-owned SQLite connection (PR7). buildBootstrap doesn't open
   * its own — main.ts does and threads it in so all stores share one
   * file + one process-wide writer.
   */
  db: Db
  /**
   * Resolve a chat's effective proactive-care level (proactive-care design
   * §5/§7): chat-prefs override ∪ default_chat_id fallback. Read per-spawn
   * (like `careLevelFor`'s siblings `currentModelFor` / `buildInstructions`
   * itself) so a `/set care` flip applies without a daemon restart. Absent
   * ⇒ the care prompt section is NEVER included for any chat — tests and
   * minimal embeddings that don't wire this stay byte-identical to before
   * the care feature existed. Wiring the actual thunk (chat-prefs +
   * companion default_chat_id) happens in main.ts (Task 7).
   */
  careLevelFor?: (chatId: string) => 'off' | 'low' | 'high'
  /**
   * Resolve a chat's local sticker library tags (image-stickers design §5),
   * tri-state (owner-onboarding design §C2 — see
   * `BuildSystemPromptArgs.stickerTags` for the full contract): `null` means
   * sticker prefs are OFF for this chat (no section at all); `[]` means
   * prefs are ON but the library is empty (cold-start unlock variant); a
   * non-empty array means prefs are ON and the library has tags (normal
   * section). Read per-spawn (like `careLevelFor`'s siblings) so a
   * newly-saved sticker (or a `/set stickers` flip) shows up in the prompt
   * without a daemon restart. Absent thunk ⇒ `index.ts` defaults to `null`
   * ⇒ NEITHER sticker section is ever included for any chat — tests and
   * minimal embeddings that don't wire this stay byte-identical to before
   * the sticker feature existed. Wiring the actual thunk (sticker store
   * lookup, disambiguating pref-off from empty-library) happens in main.ts.
   */
  stickerTagsFor?: (chatId: string) => string[] | null
  /**
   * Resolve a chat's persona content + whether it may cultivate persona.md
   * (persona design §2). Read per-spawn (like `careLevelFor`'s siblings) so
   * a hand-edited persona.md shows up in the prompt without a daemon
   * restart. Absent ⇒ BOTH the persona identity section and the
   * persona-cultivation section are NEVER included for any chat — tests and
   * minimal embeddings that don't wire this stay byte-identical to before
   * the persona feature existed. Wiring the actual thunk (owner-chat
   * memory/persona.md read via `default_chat_id`) happens in main.ts.
   */
  personaFor?: (chatId: string) => { content?: string; cultivate?: boolean }
  /**
   * Resolve a chat's core-memory block — a small, always-loaded excerpt of
   * THIS chat's own profile.md (core-memory-injection design §2). Read
   * per-spawn (like `careLevelFor`'s siblings) so a memory_write update to
   * profile.md shows up on the very next turn without a daemon restart.
   * Unlike `personaFor` (which reads the OWNER chat's persona.md via
   * `default_chat_id`), this reads the CALLING chat's OWN dir — each chat
   * gets its own core memory, not the owner's. Absent ⇒ the core-memory
   * section is NEVER included for any chat — tests and minimal embeddings
   * that don't wire this stay byte-identical to before this feature
   * existed. Wiring the actual thunk (per-chat memory/profile.md read,
   * capped to CORE_MEMORY_MAX_CHARS) happens in main.ts.
   */
  coreMemoryFor?: (chatId: string) => string
  /**
   * Daemon-distilled objective plugin knowledge for this chat (knowledge.md),
   * read fresh per spawn + capped. Injected right after core memory. Absent
   * thunk / empty ⇒ section omitted (knowledge-distillation design, D1).
   */
  knowledgeMemoryFor?: (chatId: string) => string
  /**
   * Resolve whether a chat is still in the "刚认识" (just-met) phase
   * (onboarding-curiosity design §2). Read per-spawn (like `careLevelFor`'s
   * siblings) so the section drops off mid-conversation once the message
   * count crosses the threshold, with no daemon restart. Absent ⇒ the
   * new-relationship prompt section is NEVER included for any chat — tests
   * and minimal embeddings that don't wire this stay byte-identical to
   * before this feature existed. Wiring the actual thunk (sync message
   * count vs. NEW_RELATIONSHIP_MSG_COUNT) happens in main.ts.
   */
  newRelationshipFor?: (chatId: string) => boolean
  /**
   * Resolve whether the companion-offer prompt section (owner-onboarding
   * design §C1) should be added for this chat: owner chat AND companion
   * proactive-tick is off AND this chat's inbound message count has
   * crossed `NEW_RELATIONSHIP_MSG_COUNT` — i.e. exactly the chats where
   * `newRelationshipFor` has ALREADY flipped to false (same threshold,
   * opposite side), so the two sections are naturally mutually exclusive.
   * "Owner chat" here is `resolveAdminChatId`'s admins-membership-based
   * resolution (NOT `default_chat_id` compared directly — that field is
   * ONLY ever set inside `companion_enable`, so on a fresh install it's
   * null, and a direct compare would deadlock: the offer could never fire
   * until companion had already been enabled once and later disabled). See
   * `companion/offer-eligibility.ts`'s `companionOfferEligible` (fix round
   * 1) for the actual predicate main.ts's thunk delegates to — that's what
   * makes this admins-membership-based, hence guest-safe by construction
   * even though the section carries no separate tier gate. Read per-spawn
   * (like `careLevelFor`'s siblings) so an `/companion_enable` call or
   * crossing the threshold mid-conversation applies without a daemon
   * restart. Absent ⇒ the companion-offer prompt section is NEVER included
   * for any chat — tests and minimal embeddings that don't wire this stay
   * byte-identical to before this feature existed.
   */
  companionOfferFor?: (chatId: string) => boolean
  /**
   * Resolve whether the bubble-replies prompt section (行为流式气泡回复
   * design) should be added for this chat. Read per-spawn (like
   * `careLevelFor`'s siblings) so a `/set split off` flip applies without a
   * daemon restart. Absent ⇒ the bubble-replies section is NEVER included
   * for any chat — tests and minimal embeddings that don't wire this stay
   * byte-identical to before this feature existed. Unlike `careLevelFor`,
   * there is deliberately NO tier gate here: `reply` is guest-allowed (it's
   * not a memory_write-gated capability), so a guest chat gets the same
   * bubble guidance as an owner chat. Wiring the actual thunk (chatPrefs
   * `split` — same pref that gates route-level mechanical splitting)
   * happens in main.ts.
   */
  bubbleRepliesFor?: (chatId: string) => boolean
  /**
   * App-conversation-channel reply-sink registry (session-serialization
   * design, Task 2 Part B) — the SAME shared instance main.ts passes to
   * internal-api (its `POST /v1/wechat/reply` route) and to
   * wireMain/pipeline-deps (companionConverse's open/close). Only
   * `capture` is used here, threaded into the coordinator's
   * sendAssistantText fallback so plain-text app-turn replies (no `reply`
   * tool call) land in the open sink instead of leaking to WeChat. Absent
   * ⇒ fallback text always ilink-sends (tests / minimal embeddings stay
   * byte-identical to before this feature existed).
   */
  replySinks?: { capture: (chatId: string, text: string) => boolean }
  /** 旁听(不改道)—— 让 sendAssistantText 的 fallback 路径也进战利品清单。 */
  outboundTaps?: { observe: (chatId: string, text: string) => void }
  /**
   * 桌宠信号(spec 2026-09-05-cc-desktop-pet §5.1)—— main.ts 里造的**同一个**
   * 实例,也传给 wireMain/pipeline-deps(读的那一头在 GET /v1/companion/pet)。
   * bootstrap 只写两笔:coordinator 的 onTurnEvent 里的 tool_call,和 recordTurn
   * 末尾的回合结束。可选:不接就整套不写不读,老 fixture 逐字节不变。
   */
  petSignals?: import('../pet-signals').PetSignals
  /**
   * self-restart (spec 2026-08-03-daemon-self-restart-on-stale-code) —
   * graceful-shutdown-then-exit(0) so launchd's KeepAlive respawns a fresh
   * process with fresh code. main.ts wires this to the SAME closure it
   * passes to internal-api's requestRestart (POST /v1/daemon/restart).
   * Optional and deliberately so: when omitted, buildBootstrap skips the
   * self-restart mechanism entirely — no HEAD read, no activity marker, no
   * check added to the idle-sweep tick. Tests / minimal embeddings that
   * don't wire this stay byte-identical to before this feature existed.
   */
  requestRestart?: () => void
  /**
   * Subsystem degraded-boot (spec 2026-08-17) — 可选 wire 块(knowledge/
   * social/a2a-server/pairing/self-restart)经它拉起;失败 ⇒ 对应产物
   * undefined,类型上等同"未配置"。核心块不经它。
   */
  supervisor: import('../subsystems').SubsystemSupervisor
}

export interface Bootstrap {
  sessionManager: SessionManager
  sessionStore: import('../../core/session-store').SessionStore
  conversationStore: ConversationStore
  registry: ProviderRegistry
  coordinator: ConversationCoordinator
  resolve: (chatId: string) => { alias: string; path: string } | null
  formatInbound: typeof formatInbound
  sdkOptionsForProject: (alias: string, path: string, tierProfile: TierProfile, chatId: string, mcpEnv?: Record<string, string>, appendInstructions?: string) => Options
  /**
   * The single provider-agnostic system-prompt assembler. SessionManager calls
   * it once per spawn and forwards the result via SpawnContext.appendInstructions;
   * each provider injects it through its own transport. `chatId` gates the
   * per-chat sections (currently: the care section, via `deps.careLevelFor`).
   * Exposed for tests.
   */
  buildInstructions: (providerId: ProviderId, tierProfile: TierProfile, chatId: string) => string
  /** Daemon-default provider id — what new chats get until user runs `/cc` or `/codex`. */
  defaultProviderId: ProviderId
  /** Backward-compat alias for defaultProviderId. Pre-P2 callers expected this name. */
  agentProviderKind: ProviderId
  /**
   * RFC 03 P4 — one-shot delegate dispatcher. main.ts wires this into
   * internal-api via setDelegate() right after buildBootstrap returns.
   * Optional `cwd` per RFC 03 review #10.
   */
  dispatchDelegate: DelegateDispatch
  /**
   * A2A deps — instantiated by bootstrap so main.ts can late-bind them
   * into internal-api via setA2A(). Undefined when a2a_listen is not
   * configured (a2aServer is null in that case too). Also undefined ⇔
   * a2a-server 子系统降级(wireA2aServer 抛错,spec 2026-08-17).
   */
  a2aDeps?: {
    registry: import('../../core/a2a-registry').A2ARegistry
    client: import('../../core/a2a-client').A2AClient
    eventsStore: import('../../core/a2a-events-store').A2AEventsStore
    recordEvent: (event: AppendInput) => void
    serverEnabled: boolean
    baseUrl: string | null
  }
  /**
   * Running A2A HTTP server — null when a2a_listen is not configured.
   * main.ts calls a2aServer?.stop() in shutdown.
   */
  a2aServer: import('../../core/a2a-server').A2AServer | null
  /**
   * 乙 v2 BRAIN hub — present only when yi_hub_listen is configured.
   * pipeline-deps reads this to route ws-transport hands via the hub.
   */
  yiHub?: YiHub
  /**
   * Loaded agent config — the same in-memory reference used by wiring closures.
   * Mutations (e.g. setBotName) are visible to all closures that hold this ref.
   */
  agentConfig: AgentConfig
  /**
   * Fallback-reply sender — same closure the coordinator's fallback path
   * uses (see `sendAssistantText` local in `buildBootstrap`). Exposed here
   * so wiring seams OUTSIDE the coordinator turn loop (e.g. pipeline-deps'
   * "揭晓 <id>" reveal dispatch) can push a one-off operator-facing message
   * without a full agent turn. `undefined` only when no ilink.sendMessage
   * was wired (rare test/embedding harnesses) — see makeSendAssistantText.
   */
  sendAssistantText?: SendAssistantText
  /**
   * 社交(spec 2026-09-04-wish-postcard 之后的形状)— present only when
   * `social_enabled` + `social_disclosure_policy` are both configured (and at
   * least one registered provider offers a cheapEval). Undefined otherwise —
   * the feature stays fully inert (no /a2a/letter handler, no /v1/social/*).
   *
   * 两块,一块信道一块心愿:`penpal` 是笔友信道本身(写信 / 串门),`wish`
   * 是派心愿 / 收明信片,late-bound 进 internal-api by main.ts(mirrors
   * `a2aDeps`/`setA2A`)。
   */
  social?: {
    penpal: {
      sendLetter(channel: string, text: string): Promise<{ ok: boolean; error?: string; letter_id?: string }>
      resendLetter(letterId: string): Promise<{ ok: boolean; error?: string; letter_id?: string }>
      channelStore: import('../../core/penpal-channel-store').ChannelStore
      letterStore: import('../../core/penpal-letter-store').LetterStore
      startVisit(channelRowId?: string): Promise<{ ok: true; id: string; channel: string } | { ok: false; reason: string }>
      /** 进行中的串门(spec 2026-09-03-companion-presence)。 */
      activeVisit(): import('../../core/companion-presence').ActiveVisit | null
      /** 可自动串门的真信道(spec 2026-09-05-companion-plan)。 */
      provenChannels(): Array<{ id: string; label: string }>
    }
    /** 派心愿 / 收明信片(spec 2026-09-04-wish-postcard)。onInbound 留在
     *  wire-social 内部 —— 信封只从 correspondent 一个口进来。 */
    wish: Omit<import('./wire-wish').WishService, 'onInbound'>
    /** 介绍(spec 2026-09-04-introduction)。onInbound 留在 wire-social 内部 ——
     *  信封只从 correspondent 一个口进来。 */
    intro: Omit<import('./wire-intro').IntroService, 'onInbound'>
  }
  /**
   * Anonymous pen-pal channel (Task 8/10/11) — present only once a channel
   * has been opened via the reveal flow. Undefined otherwise, so the "回信
   * <channel> <text>" dispatch seam in pipeline-deps.ts stays a clean no-op
   * (falls through to a normal turn) until Task 11 wires the real
   * correspondent in.
   */
  penpal?: {
    sendLetter(channel: string, text: string): Promise<{ ok: boolean; error?: string }>
  }
  /**
   * Content-blind mailbox transport (sub-project B, Task 8) — deps for
   * `registerMailboxPoller` (src/daemon/bootstrap/wire-mailbox.ts). Present
   * only when `social_enabled` AND at least one `mailbox_relays` entry are
   * configured AND social wiring produced an `onMailboxLetter` (I1's
   * own-channel-only handler). main.ts registers the poller lifecycle iff
   * this is set; otherwise the feature is fully inert (no poll timer).
   */
  mailboxPollerDeps?: import('./wire-mailbox').MailboxPollerDeps
  /**
   * This daemon's stable-unique self slug (pairing-code design §2), resolved
   * exactly ONCE at boot via `resolveSelfAgentId` and shared by every wiring
   * seam that self-reports an agent_id to a peer — wireSocial's outbound
   * a2a_id, wirePairing's own-card `self_id`, and pipeline-deps'
   * exec/hands delegate path (`delegateToHand`). A single shared value is
   * what stops a slug-minting daemon from broadcasting two different
   * identities to its peers.
   */
  selfId: string
  /**
   * 配对码 (spec §7) — the daemon-side pairing engine. Present only when
   * mailbox_relays is configured (the rendezvous relay is the daemon's own
   * `mailbox_relays[0]`). The WeChat 「配对」 dispatch seam (pipeline-deps)
   * and internal-api /v1/pair/* routes read this; undefined ⇒ inert (no-op /
   * 503), same posture as `boot.social`/`boot.penpal`.
   */
  pairing?: import('../../core/pairing').PairingEngine
  /**
   * Knowledge Kernel (Phase 01, T5) — the daemon-owned KnowledgeStore + the
   * Query-face `semanticSearch` function, present only when
   * `knowledge_enabled` is configured (default off — opt-in during the
   * walking-skeleton slice; see docs/superpowers/plans/2026-07-12-knowledge-
   * kernel-phase01.md Task 5). Unlike `social`/`a2aDeps`, this needs no
   * main.ts late-bind: `openKnowledge` only needs `stateDir`, which is
   * available before `buildBootstrap` runs, so main.ts can pass this same
   * shape straight into `registerInternalApi`'s `knowledge` dep (T3).
   * Exposed here so bootstrap tests can assert the config gate and so the
   * store can be closed in test teardown (mirrors `boot.a2aServer`'s
   * teardown posture — `store.close()` is the caller's job, same as
   * `a2aServer?.stop()`).
   *
   * Agent-facing Search (Task 2) — `embedder` is the ONE shared, long-lived
   * embed-subprocess service (../../core/knowledge/embedder-service.ts)
   * used by both the indexer (this file's knowledge cycle) and the query
   * path (internal-api's `embedQuery`); it is NOT closed between cycles,
   * only on daemon shutdown (main.ts). Exposed here (mirrors `store` above)
   * so main.ts can close it. `embedQuery` mirrors
   * InternalApiDeps['knowledge']['embedQuery'] — see that doc comment.
   * Both undefined when `knowledge_enabled` is on but no embed script
   * resolved (store/search are still present in that case).
   */
  knowledge?: {
    store: import('../../core/knowledge/store').KnowledgeStore
    search: typeof import('../../core/knowledge/search').semanticSearch
    embedder?: import('../../core/knowledge/embedder-service').EmbedderService
    embedQuery?: (t: string) => Promise<number[]>
    /**
     * Graph Query (Knowledge Graph inproc, Task 5) — the store-backed
     * accessor over graph.db, built by `core/knowledge/graph-query.ts`'s
     * `makeGraphQueryApi`. Unlike `embedder`/`embedQuery`, present
     * unconditionally whenever `knowledge_enabled` is on (graph rebuild
     * needs no embed script) — see the field's doc comment on
     * `InternalApiDeps['knowledge']` for the full rationale, which this
     * mirrors.
     */
    graph?: import('../../core/knowledge/graph-query').GraphQueryApi
    /**
     * Facts + Person (Knowledge Facts/Person inproc, Task 5) — mirrors
     * `InternalApiDeps['knowledge'].facts`/`.person` (internal-api/types.ts):
     * the candidate-feed/record/query API over facts.db built by
     * `core/knowledge/facts.ts`'s `makeFactsApi`, and the unified
     * per-contact brief composite built by `core/knowledge/person.ts`'s
     * `makePersonApi`. Same posture as `graph` above: present whenever
     * `knowledge_enabled` is configured.
     */
    facts?: import('../../core/knowledge/facts').FactsApi
    person?: import('../../core/knowledge/person').PersonApi
  }
  /**
   * Connection-health runtime (connection-health design, Task 7) — wraps the
   * two-state health machine + failure classifier + incident store + notify
   * policy behind two entry points, `onFailure`/`onSuccess`. Constructed
   * unconditionally via `./wire-health.ts` so it exists BEFORE
   * `registerPolling` starts the long-poll loops (main.ts wires
   * `health.onSuccess`/`onFailure` into `startLongPollLoops`'s `health` dep,
   * and `health.health.shouldSuspend` into `buildTickBodies`'s `health` dep).
   */
  health: HealthRuntime
  /**
   * busy-registry hold (spec 2026-08-11 §1/§2) — "work is happening" signal
   * for long tasks that don't go through SessionManager (A2A delegate,
   * customer-review, social forage/respond, internal-api non-GET requests,
   * companion push/ingest/introspect ticks). Each caller wraps its run with
   * `const release = boot.holdBusy(label); try { ... } finally { release() }`
   * (or the fire-and-forget `.finally(release)` shape used by the
   * background coroutines). Always present — the underlying registry
   * (src/core/busy-registry.ts) is constructed unconditionally in
   * buildBootstrap, independent of whether self-restart itself is enabled
   * via `deps.requestRestart`. The self-restart idle check reads
   * `busyRegistry.busy()` directly (see ./wire-self-restart.ts), so a held
   * token here is exactly what stops the idle self-restart from killing a
   * long task mid-flight.
   */
  holdBusy: (label: string) => () => void
  /** busy-registry label 快照(spec 2026-09-03-companion-presence)。 */
  busyLabels: () => string[]
  /**
   * self-restart (spec 2026-08-03-daemon-self-restart-on-stale-code) — mark
   * "inbound activity happened now". Wired by main.ts's wireMain (via
   * pipeline-deps' `messages` dep) into mw-messages' `markInboundActivity`,
   * so the self-restart check's `quietFor()` signal reflects real traffic
   * instead of staying at Infinity forever. Present only when
   * `deps.requestRestart` was provided to buildBootstrap (self-restart
   * enabled); undefined otherwise — mw-messages already treats
   * `markInboundActivity` as optional, so this stays a clean no-op.
   */
  markInboundActivity?: () => void
}
