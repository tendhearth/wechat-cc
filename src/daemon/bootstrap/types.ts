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
import type { SeekOutcome } from '../../core/social-broker'
import type { Revealer } from '../../core/social-reveal'

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
    askUser: (chatId: string, prompt: string, hash: string, timeoutMs: number) => Promise<'allow'|'deny'|'timeout'>
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
   * Resolve a chat's local sticker library tags (image-stickers design §5).
   * Read per-spawn (like `careLevelFor`'s siblings) so a newly-saved sticker
   * shows up in the prompt without a daemon restart. Absent ⇒ the sticker
   * prompt section is NEVER included for any chat — tests and minimal
   * embeddings that don't wire this stay byte-identical to before the
   * sticker feature existed. Wiring the actual thunk (sticker store lookup)
   * happens in main.ts (later task).
   */
  stickerTagsFor?: (chatId: string) => string[]
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
   * configured (a2aServer is null in that case too).
   */
  a2aDeps: {
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
   * Agent-social M1 (T7b-core) — present only when `social_enabled` +
   * `social_disclosure_policy` are both configured (and at least one
   * registered provider offers a cheapEval). Undefined otherwise — the
   * feature stays fully inert (no /a2a/intent, no /v1/social/seek).
   *
   * `broker.seek()` is what POST /v1/social/seek calls — late-bound into
   * internal-api by main.ts (mirrors `a2aDeps`/`setA2A`).
   *
   * `revealer` drives the row-driven mutual reveal (both the outbound
   * revealEcho/revealPledge legs the internal-api calls and the inbound
   * onInboundReveal wired into the a2a-server's /a2a/reveal). `pledgeStore`
   * is exposed so the answer-side reveal surface can list/read pledges.
   */
  social?: {
    broker: { seek(topic: string, opts?: { city?: string }): Promise<SeekOutcome> }
    seekStore: import('../../core/social-seek-store').SeekStore
    echoStore: import('../../core/social-echo-store').EchoStore
    pledgeStore: import('../../core/social-pledge-store').PledgeStore
    revealer: Revealer
    penpal: { sendLetter(channel: string, text: string): Promise<{ ok: boolean; error?: string }> }
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
}
