/**
 * buildBootstrap — wires up the daemon's core dispatch graph.
 *
 * Composes:
 *   - Provider registry (Claude + Codex providers)
 *   - SessionManager (LRU-evicting cache of (provider, alias) → session)
 *   - ConversationStore (per-chat mode persistence)
 *   - ConversationCoordinator (mode-aware dispatch entry)
 *   - Bare delegate providers (RFC 03 P4 peer-as-tool)
 *
 * Helpers extracted for readability:
 *   - ./mcp-specs.ts   — wechat / delegate stdio MCP spec builders
 *   - ./session-paths.ts — per-provider jsonl path resolvers (canResume probes)
 *   - ./delegate.ts    — bare delegate providers + dispatchDelegate
 *
 * Imported only by:
 *   - src/daemon/main.ts (production entry)
 *   - src/daemon/bootstrap.test.ts (integration tests)
 */
import { SessionManager } from '../../core/session-manager'
import { createClaudeAgentProvider, tierProfileToClaudeSdkOpts } from '../../core/claude-agent-provider'
import { createCodexAgentProvider } from '../../core/codex-agent-provider'
import type { TierProfile } from '../../core/user-tier'
import { resolveTier, TIER_PROFILES } from '../../core/user-tier'
import { createProviderRegistry, type ProviderRegistry } from '../../core/provider-registry'
import { createConversationCoordinator, type ConversationCoordinator, type TurnRecord } from '../../core/conversation-coordinator'
import { makeConversationStore, type ConversationStore } from '../../core/conversation-store'
import { buildSystemPrompt } from '../../core/prompt-builder'
import type { ProviderId } from '../../core/conversation'
import { makeResolver } from '../../core/project-resolver'
import { makeCanUseTool } from '../../core/permission-relay'
import { assertMatrixComplete, capabilitiesFor, capabilityProviderIds, type PermissionMode } from '../../core/capability-matrix'
import { formatInbound } from '../../core/prompt-format'
import type { IlinkAdapter } from '../ilink-glue'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { findOnPath, probeBinaryVersion } from '../../lib/util'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { WechatProjectsDep, WechatVoiceDep, WechatCompanionDep } from '../wechat-tool-deps'
import { makeSessionStore } from '../../core/session-store'
import type { Db } from '../../lib/db'
import { homedir } from 'node:os'
import { loadAgentConfig, makeMtimeCachedConfigReader, modelForProvider } from '../../lib/agent-config'
import type { AgentConfig, AgentProviderKind } from '../../lib/agent-config'
import { loadAccess, setSessionInvalidator, type Access } from '../../lib/access'
import { loadCompanionConfig, type CompanionConfig } from '../companion/config'
import { wechatStdioMcpSpec, delegateStdioMcpSpec, buildOpenaiMcpSpecs, type McpStdioSpec } from './mcp-specs'
import { loadPlugins, pluginMcpSpecs } from '../plugins/registry'
import { bundledPluginsDir } from '../plugins/paths'
import { claudeSessionJsonlPath, codexSessionJsonlPaths } from './session-paths'
import { buildDelegateDispatch, type DelegateDispatch } from './delegate'
import { makeSendAssistantText } from './fallback-reply'
import { findCodexBinary } from '../../lib/find-codex-binary'
import { checkCodexVersion } from './codex-version-check'
import { attemptCodexAutofix } from '../../lib/codex-autofix'
import { assertNotAuthFailed, type CheapEval } from '../../core/agent-provider'
import { createA2ARegistry } from '../../core/a2a-registry'
import { createA2AClient } from '../../core/a2a-client'
import { createA2AServer, type NotifyEvent, type A2AServerOpts } from '../../core/a2a-server'
import { verifyAndConsumeInvite } from '../../lib/a2a-pairing'
import { makeA2AEventsStore, type AppendInput } from '../../core/a2a-events-store'
import { createYiHub, type YiHub } from '../../core/yi-hub'
import { createYiWsServer } from '../yi-ws-server'
// Agent-social M1 (T7b-core) — intent-brokering wiring. See
// docs/superpowers/specs/2026-07-12-agent-social-m1-intent-brokering-design.md
import { makeJudge } from '../../core/social-judge'
import { makeAnswerIntent } from '../../core/social-answer'
import { makeBroker, type SeekOutcome } from '../../core/social-broker'
import { makeSeekStore } from '../../core/social-seek-store'
import { makeEchoStore } from '../../core/social-echo-store'
import { createPendingConfirms, type PendingConfirms } from '../../core/pending-confirm'
import { intentUrl } from '../../core/a2a-delegate'
import { MatchReceiptSchema } from '../../core/a2a-intent'
// JSON import — version field is read at module init. resolveJsonModule is
// on in tsconfig, and `with { type: 'json' }` is the spec'd syntax.
import codexCliPkg from '@openai/codex/package.json' with { type: 'json' }
import selfPkg from '../../../package.json' with { type: 'json' }

/**
 * Locate a working Claude Code binary. The SDK's own native-binary detection
 * mis-picks the musl variant under bun on glibc Ubuntu (bug in libc probing);
 * passing pathToClaudeCodeExecutable bypasses that. Preference order:
 *   1. env var override
 *   2. system claude on PATH (works in any CC-installed env)
 *   3. bundled glibc variant shipped with the SDK itself
 */
function resolveClaudeBinary(): string | undefined {
  if (process.env.CLAUDE_CODE_EXECUTABLE && existsSync(process.env.CLAUDE_CODE_EXECUTABLE)) {
    return process.env.CLAUDE_CODE_EXECUTABLE
  }
  const fromPath = findOnPath('claude')
  if (fromPath && existsSync(fromPath)) return fromPath
  const here = dirname(fileURLToPath(import.meta.url))
  // src/daemon/bootstrap/index.ts → ../../../node_modules/...
  const bundled = join(here, '..', '..', '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-linux-x64', 'claude')
  if (existsSync(bundled)) return bundled
  return undefined
}

// Locate the wechat-cc source-mode install root (where package.json lives).
// Source mode: derived from this file's path. Compiled-binary mode (Bun's
// /$bunfs/...): existsSync(repoRoot/package.json) returns false → return null.
// Null → codex-autofix returns "unsafe" and the daemon falls back to bundled.
function wechatCcRepoRoot(): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url))     // .../src/daemon/bootstrap
    const root = join(here, '..', '..', '..')                // .../<repo>
    if (existsSync(join(root, 'package.json'))) return root
    return null
  } catch {
    return null
  }
}

// Get the user's PATH-installed codex binary + version (skips wechat-cc's
// own bundled probe — that would loop back to ourselves). Used by
// codex-autofix to decide whether the bundled SDK needs realignment.
function detectUserCodexOnPath(): { path: string | null; version: string | null } {
  const path = findOnPath('codex')
  if (!path) return { path: null, version: null }
  const raw = probeBinaryVersion(path)
  if (!raw) return { path, version: null }
  // probeBinaryVersion returns "codex-cli 0.133.0" or similar; extract semver.
  const m = /(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)/.exec(raw)
  return { path, version: m?.[1] ?? null }
}

const CLAUDE_AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
] as const

function hydrateClaudeAuthEnvFromUserSettings(log: BootstrapDeps['log']): void {
  const settingsPath = join(homedir(), '.claude', 'settings.json')
  if (!existsSync(settingsPath)) return

  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as { env?: Record<string, unknown> }
    const env = parsed.env
    if (!env || typeof env !== 'object') return

    const copied: string[] = []
    for (const key of CLAUDE_AUTH_ENV_KEYS) {
      if (process.env[key]) continue
      const value = env[key]
      if (typeof value !== 'string' || value.length === 0) continue
      process.env[key] = value
      copied.push(key)
    }
    if (copied.length > 0) {
      log('BOOT', `claude auth env loaded from ~/.claude/settings.json: ${copied.join(', ')}`)
    }
  } catch {
    log('BOOT', 'claude auth env not loaded: failed to parse ~/.claude/settings.json')
  }
}

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
   * Agent-social M1 (T7b-core) — present only when `social_enabled` +
   * `social_disclosure_policy` are both configured (and at least one
   * registered provider offers a cheapEval). Undefined otherwise — the
   * feature stays fully inert (no /a2a/intent, no /v1/social/seek).
   *
   * `broker.seek()` is what POST /v1/social/seek calls — late-bound into
   * internal-api by main.ts (mirrors `a2aDeps`/`setA2A`).
   *
   * `pendingConfirms` is exposed so a follow-up task (T7b-2) can resolve
   * the operator's WeChat yes/no reply via `pendingConfirms.resolve(key,
   * text)`. Until that lands, every `confirmWithOwner` ask times out to
   * `false` after 5 minutes (the ask is still sent to the operator's chat;
   * only the reply-capture leg is missing).
   */
  social?: {
    broker: { seek(topic: string, opts?: { city?: string }): Promise<SeekOutcome> }
    pendingConfirms: PendingConfirms
    seekStore: import('../../core/social-seek-store').SeekStore
    echoStore: import('../../core/social-echo-store').EchoStore
  }
}

// buildChannelSystemPrompt() moved to src/core/prompt-builder.ts in
// the RFC 03 review follow-up: the inline string here was v0.x and
// missed delegate_*, share_*, broadcast, set_user_name, send_file,
// edit_message — none of which were in the prompt despite being
// available tools. The prompt-builder also encodes mode-awareness so
// the agent doesn't get confused by chatroom envelopes.

/**
 * PR F — wrap a CheapEval so the auth-failed sentinel (Claude's "Not
 * logged in / Please run /login" emitted as assistant text; Codex's
 * "401 unauthorized" etc.) is converted into a thrown error instead of
 * leaking to downstream JSON parsers. The chatroom moderator's
 * existing `haiku eval threw` branch then falls back to forced
 * alternation, and the auth-failed log line surfaces in channel.log
 * alongside solo/parallel auth-failures (single vocabulary across paths).
 *
 * Returns undefined when the registry has no cheapEval — the coordinator
 * treats `haikuEval: undefined` as absent, skipping beat ②b and beat ③.
 */
function wrapCheapEvalWithAuthFailCheck(
  cheapEval: CheapEval | null,
  log: BootstrapDeps['log'],
): ((prompt: string) => Promise<string>) | undefined {
  if (!cheapEval) return undefined
  return async (prompt: string) => {
    const text = await cheapEval(prompt)
    assertNotAuthFailed(text, (tag, line) => log(tag, line), 'cheap-eval moderator')
    return text
  }
}

/**
 * Resolve which chat receives permission-relay prompts. Pre-Task-13 the
 * relay routed to `lastActiveChatId` — a security hole, since a guest who
 * could trigger a tool call could then approve their own request. The
 * relay target is now an admin chat, but we still prefer the INITIATING
 * chat when that chat itself is in `access.admins`:
 *
 *   1. If `initiatingChatId` is itself an admin, prompt that admin.
 *      Closes the multi-admin gap where admin[1+] never sees prompts for
 *      their own tool calls. Admin self-approval is fine — the original
 *      security hole was specifically guest self-approval.
 *   2. Else if companion.default_chat_id is set AND admin, use it
 *      (operator can explicitly direct prompts to their preferred chat).
 *   3. Otherwise fall back to `access.admins[0]` — first admin in config.
 *   4. If no admins exist at all, return null (relay denies the request).
 *
 * Called per-tool-call inside the makeCanUseTool closure, so changes to
 * either access.json or companion config take effect within one read TTL
 * (5s for access; instant for companion).
 */
export function resolveAdminChatId(
  access: Access,
  companion: CompanionConfig,
  initiatingChatId?: string | null,
): string | null {
  if (initiatingChatId && access.admins?.includes(initiatingChatId)) {
    return initiatingChatId
  }
  if (companion.default_chat_id && access.admins?.includes(companion.default_chat_id)) {
    return companion.default_chat_id
  }
  return access.admins?.[0] ?? null
}

/**
 * Cheap, deterministic string → key derivation for `confirmWithOwner`'s
 * pending-confirm key. The broker's `confirmWithOwner(summary)` seam takes
 * only a rendered summary string (no intent_id threaded through) — unlike
 * `onIntentConfirm` (the peer-driven confirm leg), which DOES carry
 * intent_id and keys on it directly. Hashing the summary is the documented
 * limitation from the M1 T7b-core plan: two concurrent seeks that happen to
 * render an IDENTICAL summary for the SAME operator chat would collide on
 * the same pending-confirm key. Acceptable in M1 (single-seek-at-a-time is
 * the common case); a real fix threads intent_id through confirmWithOwner
 * in a follow-up.
 */
function hashSummary(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

export async function buildBootstrap(deps: BootstrapDeps): Promise<Bootstrap> {
  hydrateClaudeAuthEnvFromUserSettings(deps.log)

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
    deps.db,
    { migrateFromFile: join(deps.stateDir, 'conversations.json') },
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
    adminChatId: () => resolveAdminChatId(loadAccess(), loadCompanionConfig(deps.stateDir), chatId),
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
    log: deps.log,
    // Per-dispatch mode lookup: read THIS session's current mode from
    // the conversation store at the moment the tool call arrives.
    // chatId is bound at spawn; only the mode kind is dynamic (operator
    // can flip /solo /cc /codex /both mid-session).
    mode: () => conversationStore.get(chatId)?.mode.kind ?? 'solo',
    provider: 'claude',
    permissionMode,
  })

  const claudeBin = resolveClaudeBinary()
  if (!claudeBin) {
    deps.log('BOOT', 'WARNING: no Claude Code binary found — install Claude Code (`claude`) or set CLAUDE_CODE_EXECUTABLE')
  } else {
    deps.log('BOOT', `claude binary: ${claudeBin}`)
  }

  // RFC 03 §5 — standalone wechat-mcp stdio server. When deps.internalApi is
  // wired, both providers receive a `wechat` MCP server spec that spawns
  // the wechat-mcp child with token-auth env vars.
  const wechatStdioForClaude: McpStdioSpec | null = deps.internalApi ? wechatStdioMcpSpec(deps.internalApi, 'claude') : null
  const wechatStdioForCodex: McpStdioSpec | null = deps.internalApi ? wechatStdioMcpSpec(deps.internalApi, 'codex') : null

  // RFC 03 P4 — delegate-mcp stdio server. Loaded alongside wechat-mcp so the
  // primary agent can call `delegate_<peer>(prompt)` to consult the OTHER
  // provider once. The peer is fixed per-spawn AND sourced from each provider's
  // ProviderCapabilities.defaultPeer — the single declaration site, so adding a
  // provider needs no edit here (its delegate spec is built iff it declares a
  // defaultPeer). Replaces the old per-provider literals + a 2-provider ternary.
  const delegateStdioByProvider: Partial<Record<ProviderId, McpStdioSpec>> = {}
  if (deps.internalApi) {
    for (const p of capabilityProviderIds()) {
      const peer = capabilitiesFor(p).defaultPeer
      if (peer) delegateStdioByProvider[p] = delegateStdioMcpSpec(deps.internalApi, peer)
    }
  }
  const delegateStdioForClaude: McpStdioSpec | null = delegateStdioByProvider.claude ?? null
  const delegateStdioForCodex: McpStdioSpec | null = delegateStdioByProvider.codex ?? null
  const delegateStdioForCursor: McpStdioSpec | null = delegateStdioByProvider.cursor ?? null
  const wechatStdioForCursor: McpStdioSpec | null = deps.internalApi ? wechatStdioMcpSpec(deps.internalApi, 'cursor') : null
  const delegateStdioForOpenai: McpStdioSpec | null = delegateStdioByProvider.openai ?? null
  const wechatStdioForOpenai: McpStdioSpec | null = deps.internalApi ? wechatStdioMcpSpec(deps.internalApi, 'openai') : null
  const wechatStdioForGemini: McpStdioSpec | null = deps.internalApi ? wechatStdioMcpSpec(deps.internalApi, 'gemini') : null

  // Decoupled plugin lane — third-party MCP tool providers
  // spawned as stdio children exactly like wechat/delegate, but discovered
  // from `{stateDir}/plugins/<name>/` (drop-in, survives upgrades) or the
  // bundled `plugins/` dir. wechat-cc never imports plugin code; the process
  // boundary + MCP wire protocol are the only coupling, so a plugin can be
  // any language. USER plugins default DISABLED (a manifest spawns a process
  // = arbitrary code; enable via dashboard / plugins.json); BUNDLED default
  // ENABLED. Unlike installUserMcp (which pollutes the human's global
  // ~/.claude.json), this injects only into the daemon-spawned providers.
  const loadedPlugins = loadPlugins({
    stateDir: deps.stateDir,
    bundledDir: bundledPluginsDir(),
    hostVersion: selfPkg.version,
    log: (m) => deps.log('BOOT', `plugin: ${m}`),
  })
  const pluginMcp = pluginMcpSpecs(loadedPlugins)
  // Names of ACTUALLY-registered plugins (enabled AND ready — same gate
  // pluginMcpSpecs applies above), daemon-global (computed once at boot, NOT
  // per-chat), threaded into buildSystemPrompt's `knowledgePlugins` arg
  // (knowledge-orchestration design Task 2). Deliberately == Object.keys(
  // pluginMcp) rather than a looser `enabled`-only filter: a bundled
  // knowledge plugin (e.g. wxsearch) defaults ENABLED but is commonly NOT
  // READY (its healthcheck requires wxvault's decrypted output, which a
  // fresh install/dev box won't have yet) — mentioning it in the prompt
  // before its tools actually exist would send the agent at tools that
  // don't exist. Unknown plugin names are harmless — buildSystemPrompt
  // silently ignores anything outside KNOWN_KNOWLEDGE_PLUGINS.
  const knowledgePluginNames = Object.keys(pluginMcp)
  // Claude's SDK wants each server tagged `type: 'stdio'`; codex/cursor take
  // the bare {command,args,env} shape (structurally identical to McpStdioSpec).
  const pluginMcpForClaude = Object.fromEntries(
    Object.entries(pluginMcp).map(([k, s]) => [k, { type: 'stdio' as const, ...s }]),
  )

  // Pin a Claude model from agent-config.json (or fall back to a stable
  // full ID). Without this, the spawned Claude Code subprocess inherits
  // whatever `~/.claude/.claude.json` says — which breaks the daemon
  // whenever the user's interactive CLI uses an alias the SDK subprocess
  // can't resolve. 2026-05-08 incident: user had fast-mode `opus[1m]`
  // configured for interactive sessions; CLI 2.1.133 mis-parsed that
  // under SDK mode and sent literal `"opus"` to the API → 404 on every
  // inbound. The codex side already pinned model from config; Claude
  // didn't, so this closes that asymmetry. `configuredAgent` is the boot
  // snapshot used for codex/cursor construction + startup logging.
  const configuredAgent = loadAgentConfig(deps.stateDir)

  // The model is re-read per spawn via an mtime-cached reader (one stat, parse
  // only on change) instead of being captured once. An operator's `/model`
  // switch rewrites agent-config.json, so the next session spawned in each chat
  // picks up the new model with NO daemon restart (an in-flight session keeps
  // its model until released). Claude reads `currentClaudeModel()` in its
  // Options builder; codex/cursor read `currentModelFor()` per spawn via
  // SpawnContext.model (session-manager forwards it) — all three hot-reload.
  const readAgentConfig = makeMtimeCachedConfigReader(deps.stateDir)
  const currentClaudeModel = (): string => {
    const c = readAgentConfig()
    return c.provider === 'claude' && c.model ? c.model : 'claude-opus-4-8'
  }
  // Per-spawn pinned model, resolved PER provider id (not the global default).
  // `modelForProvider` owns the field rule: openai→openaiModel and
  // cursor→cursorModel resolve unconditionally (own field), while claude/codex
  // share `model` so it only applies when the global provider matches. This is
  // what lets `/api <model>` (which switches ONE chat to openai while the
  // global default may stay claude) hot-reload the openai model on the next
  // spawn with no restart. Read via the mtime-cached reader.
  const currentModelFor = (providerId: ProviderId): string | undefined =>
    modelForProvider(readAgentConfig(), providerId)

  const sdkOptionsForProject = (_alias: string, path: string, tierProfile: TierProfile, chatId: string, mcpEnv?: Record<string, string>, appendInstructions?: string): Options => {
    // The per-session system prompt is assembled by the daemon's
    // `buildInstructions` thunk (see SessionManager wiring below) and arrives
    // here via SpawnContext — this builder no longer calls buildSystemPrompt,
    // so claude/codex share one provider-agnostic source.
    const systemPrompt = appendInstructions ?? ''
    // Per-session internal-api auth: merge the daemon-computed env overlay
    // (WECHAT_SESSION_TOKEN — the bearer the MCP children send — plus the
    // non-secret WECHAT_SESSION_TIER the wechat child gates admin tools on)
    // into the wechat + delegate children. session-manager builds this once;
    // every provider merges the same overlay, so the route layer enforces a
    // consistent tier across claude/codex/cursor.
    const sessionEnv = mcpEnv ?? {}
    const wechatEnv = wechatStdioForClaude ? { ...wechatStdioForClaude.env, ...sessionEnv } : undefined
    const delegateEnv = delegateStdioForClaude ? { ...delegateStdioForClaude.env, ...sessionEnv } : undefined
    const common: Options = {
      cwd: path,
      model: currentClaudeModel(),
      mcpServers: {
        ...(wechatStdioForClaude ? { wechat: { type: 'stdio' as const, ...wechatStdioForClaude, env: wechatEnv! } } : {}),
        ...(delegateStdioForClaude ? { delegate: { type: 'stdio' as const, ...delegateStdioForClaude, env: delegateEnv! } } : {}),
        ...pluginMcpForClaude,
      },
      // Using preset+append (instead of raw string) keeps MCP tools inline in
      // the system prompt — otherwise they're deferred behind ToolSearch,
      // which adds a round-trip every time Claude wants to call `reply`
      // (~10-15s per inbound). Extra ~2-4k tokens per turn is a fair trade.
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt },
      // Drop 'user' from settingSources (2026-05-08): user-global
      // ~/.claude/settings.json is meant for the human's interactive CLI
      // — its `effortLevel`, `alwaysThinkingEnabled`, custom mcpServers,
      // model alias preferences (cf. opus[1m] / 404 incident driving
      // commit e6f40f5) shouldn't bleed into a long-running headless
      // daemon. project + local still load so a per-project .claude/
      // setup the user wires in CWD continues to work.
      settingSources: ['project', 'local'],
      ...(claudeBin ? { pathToClaudeCodeExecutable: claudeBin } : {}),
    }
    // Task 13 — SDK permission knobs derived from the spawn-time tierProfile
    // via the provider's pure translation helper. Pre-Task-13 this branched
    // on `deps.dangerouslySkipPermissions`; post-Task-13 that flag only
    // influences which tier is resolved (see the resolveTier closure in
    // makeCanUseTool above), and the SDK options follow the tier.
    //
    // canUseTool is always wired — even at admin tier the relay may need
    // to surface destructive-Bash or memory_delete prompts that the
    // matrix's per-tool askUser flag asks for. Under bypassPermissions the
    // SDK won't fire canUseTool; under default mode canUseTool is what
    // gates everything not statically excluded via disallowedTools.
    const tierOpts = tierProfileToClaudeSdkOpts(tierProfile, permissionMode)
    // Build canUseTool with this session's chatId baked in. Done per-call
    // (not once at bootstrap) so concurrent sessions on different chats
    // each get a closure resolving tier/mode for their OWN chatId.
    const canUseTool = buildCanUseTool(chatId)
    return {
      ...common,
      permissionMode: tierOpts.permissionMode,
      ...(tierOpts.disallowedTools ? { disallowedTools: tierOpts.disallowedTools } : {}),
      canUseTool,
    }
  }

  // Persistent session_id map — enables `resume` after daemon restart.
  // Each provider stores its session/thread jsonl in a different place; we
  // probe the right one before trying to resume (avoids hard error if the
  // SDK rotated or user cleared history). See ./session-paths.ts.
  const sessionStore = makeSessionStore(deps.db, { migrateFromFile: join(deps.stateDir, 'sessions.json') })
  const HOME = homedir()

  const defaultProviderId: ProviderId = deps.agentProviderKind
    ?? (process.env.WECHAT_AGENT_PROVIDER === 'codex' ? 'codex' : configuredAgent.provider)

  // RFC 03 P2 — register BOTH providers up front, regardless of which one
  // is the current default. Per-chat /cc and /codex slash commands flip
  // chats independently; the registry is the source of truth for what's
  // dispatchable. Construction is cheap (no subprocess until first
  // acquire), so we don't gate codex behind any "is the binary installed"
  // check — that's reported by `wechat-cc doctor` separately.
  // RFC 03 §3.6 / C7 — auth-agnostic. We do NOT pass `apiKey` to the codex
  // provider; the user's `codex login` or OPENAI_API_KEY env are honored
  // transparently by the SDK.
  const registry = createProviderRegistry()
  registry.register(
    'claude',
    createClaudeAgentProvider({
      sdkOptionsForProject,
      // Threaded into cheapEval's query() call so the bun-compile
      // findClaudePath() trap doesn't bite the chatroom moderator path
      // (same protection the legacy haiku-eval helper provided).
      ...(claudeBin ? { claudeBin } : {}),
      // strongEval (the /chat verdict) runs on the live default model, not
      // haiku — synthesis quality matters more than cost there.
      strongModel: currentClaudeModel,
    }),
    {
      displayName: 'Claude',
      canResume: (cwd, sid) => existsSync(claudeSessionJsonlPath(HOME, cwd, sid)),
    },
  )
  // Auto-fix codex SDK to match the user's PATH codex CLI version when
  // they diverge. This lets a user-driven `npm i -g @openai/codex@X`
  // propagate into wechat-cc's bundled SDK without waiting for a
  // wechat-cc release. See src/lib/codex-autofix.ts for safety constraints.
  //
  // Fire-and-forget: we DO NOT await. A `bun add` against a slow npm
  // registry can take many seconds (and was observed to hang outright);
  // blocking daemon boot on it produces a daemon that appears dead. By
  // detaching the promise, boot continues with the bundled SDK in
  // memory and the on-disk node_modules realigns in the background. The
  // SDK swap takes effect on the NEXT daemon restart (the in-memory
  // SDK was already required() before this function ran, so even an
  // awaited fix wouldn't swap it within this process).
  //
  // Inner timeout (default 90s) + spawn-hard-kill (100s) protect against
  // a permanently hung `bun add` zombie.
  void attemptCodexAutofix({
    installDir: wechatCcRepoRoot(),
    bundledSdkVersion: codexCliPkg.version,
    detectUserCodex: () => detectUserCodexOnPath(),
    envDisabled: process.env.WECHAT_CC_DISABLE_CODEX_AUTOFIX === '1',
    log: (line) => deps.log('CODEX_AUTOFIX', line),
  }).then((outcome) => {
    switch (outcome.status) {
      case 'fixed':
        deps.log('CODEX_AUTOFIX',
          `done: ${outcome.from} → ${outcome.to}. Restart daemon to use the new SDK.`)
        break
      case 'failed':
        deps.log('CODEX_AUTOFIX',
          `failed (${outcome.from} → ${outcome.to}): ${outcome.reason}. ` +
          `Continuing with bundled v${outcome.from}.`)
        break
      case 'timed_out':
        deps.log('CODEX_AUTOFIX',
          `timed out after ${Math.floor(outcome.timeoutMs / 1000)}s (${outcome.from} → ${outcome.to}). ` +
          `Bun add killed. Continuing with bundled v${outcome.from}; investigate npm/network.`)
        break
      case 'unsafe':
        deps.log('CODEX_AUTOFIX', `skipped: ${outcome.reason}. Bundled SDK in use.`)
        break
      case 'disabled':
      case 'matched':
      case 'no_user_codex':
        // Silent — these are the common "nothing to do" outcomes.
        break
    }
  }).catch((err) => {
    deps.log('CODEX_AUTOFIX', `unexpected error in background auto-fix: ${err}`)
  })

  // Conditional codex registration (v0.5.6) — find a real codex CLI on disk.
  // The Codex SDK's internal `findCodexPath()` uses moduleRequire.resolve()
  // which can't see real node_modules from inside the bun-compiled bundle
  // (its `import.meta.url` is `/$bunfs/...`), so we MUST pass `codexPathOverride`.
  // When no codex is on disk we just don't register the provider — setMode
  // codex then 4xx's at validateMode (visible in dashboard as a red dropdown
  // border + revert) instead of silently swallowing dispatch errors per turn.
  const codexBinary = findCodexBinary()
  // Boot-time SDK ↔ CLI version match. The codex wire protocol is version-
  // locked: a mismatched CLI (e.g. globally-installed `codex` 0.125 paired
  // with our bundled SDK 0.128) silently emits events the SDK can't decode
  // and every dispatch returns empty assistantText (no reply, no error —
  // see src/lib/find-codex-binary.ts:81-86). Better to refuse registration
  // loudly than ship a provider that will silently never reply.
  const codexVersionCheck = codexBinary
    ? checkCodexVersion({
        binary: codexBinary,
        probe: probeBinaryVersion,
        expectedVersion: codexCliPkg.version,
      })
    : null
  if (codexBinary && codexVersionCheck?.ok) {
    deps.log('BOOT', `codex binary: ${codexBinary} (v${codexVersionCheck.actualSemver})`)
    registry.register(
      'codex',
      createCodexAgentProvider({
        codexPathOverride: codexBinary,
        // Construction-time model default ONLY from CODEX_MODEL. Do NOT fall back
        // to configuredAgent.model — that is the CONFIGURED provider's model, so
        // on a claude-default install it's a claude id (e.g. claude-opus-4-8),
        // which codex rejects ("model not supported") → every codex turn exits 1
        // (breaks /codex, /both, /chat). When the configured provider IS codex,
        // the pinned model is supplied per-spawn via currentModelFor('codex')
        // (SpawnContext.model); otherwise codex uses its own SDK default.
        ...(process.env.CODEX_MODEL ? { model: process.env.CODEX_MODEL } : {}),
        // Task 6: sandboxMode + approvalPolicy moved out of CodexAgentProviderOptions —
        // they're now derived per-spawn from spawnOpts.tierProfile inside the provider.
        // admin tier maps to danger-full-access + never (matches the old --dangerously
        // posture); trusted → workspace-write + never; guest → read-only + untrusted.
        // The dangerouslyBypassApprovalsAndSandbox flag stays here because it's a
        // provider-construction-time codex CLI config knob (not a per-thread option).
        // v0.5.7 — when daemon runs --dangerously, bypass MCP approval (else codex 0.128
        // cancels every mcp__wechat__reply with "user cancelled MCP tool call").
        dangerouslyBypassApprovalsAndSandbox: permissionMode === 'dangerously',
        // Codex SDK has no system-prompt slot; the per-spawn instructions are
        // injected into the first user message by the provider from
        // SpawnContext.appendInstructions (assembled by buildInstructions
        // below), so nothing is baked at construction here.
        mcpServers: {
          ...(wechatStdioForCodex ? { wechat: wechatStdioForCodex } : {}),
          ...(delegateStdioForCodex ? { delegate: delegateStdioForCodex } : {}),
          ...pluginMcp,
        },
      }),
      {
        displayName: 'Codex',
        canResume: (_cwd, sid) => codexSessionJsonlPaths(HOME, sid).some(p => existsSync(p)),
      },
    )
  } else if (codexBinary && codexVersionCheck && !codexVersionCheck.ok) {
    // VERSION MISMATCH: user has codex installed, but its protocol version
    // doesn't match our bundled SDK. Three resolution paths:
    //   - Wait for codex-autofix (running in background since boot start;
    //     it'll `bun add @openai/codex-sdk@<userVer>` to realign).
    //     Restart daemon after autofix completes.
    //   - Manually downgrade global: `npm i -g @openai/codex@<expected>`.
    //   - Manually upgrade wechat-cc: `bun add @openai/codex-sdk@<userVer>
    //     @openai/codex@<userVer>` in the wechat-cc install dir.
    deps.log('BOOT',
      `codex provider NOT registered — version mismatch. ` +
      `Your codex CLI at ${codexBinary} is ` +
      `v${codexVersionCheck.actualSemver ?? codexVersionCheck.rawVersion ?? '(unreadable)'}, ` +
      `but wechat-cc's bundled SDK expects v${codexVersionCheck.expectedVersion}. ` +
      `The codex SDK ↔ CLI protocol is version-locked (silent fail otherwise). ` +
      `Resolution: (a) wait for the background auto-fix to realign SDK to your CLI version, then restart daemon; ` +
      `or (b) downgrade global codex: \`npm i -g @openai/codex@${codexVersionCheck.expectedVersion}\`.`,
    )
  } else {
    // NOT INSTALLED: no codex on PATH or in ~/.nvm. Tell the user the
    // exact one-time setup. We deliberately don't bundle codex (post
    // Task #18) — `codex login` is required for auth anyway, and bundling
    // hid which version was actually in use.
    deps.log('BOOT',
      `codex provider NOT registered — codex CLI not installed. ` +
      `To enable codex / /both / /chat modes:\n` +
      `  1. \`npm i -g @openai/codex@${codexCliPkg.version}\`\n` +
      `  2. \`codex login\`  (one-time OAuth or API-key setup; auth lives in ~/.codex/)\n` +
      `  3. Restart daemon.`,
    )
  }

  // ──────────────────────────────────────────────────────────────
  // Cursor SDK provider — third registered provider.
  //
  // CURSOR_API_KEY is env-only — not stored in agent-config.json.
  // (Secret-on-disk in plaintext is a worse posture than an env var
  // in the operator's shell rc / systemd unit.) The SDK is loaded via
  // dynamic import so wechat-cc remains installable without
  // @cursor/sdk — operators who don't want Cursor can `bun remove
  // @cursor/sdk` and the registration silently skips.
  //
  // See docs/superpowers/specs/2026-05-23-cursor-sdk-provider-design.md.
  const cursorKey = process.env.CURSOR_API_KEY
  if (cursorKey && !configuredAgent.cursorModel) {
    // Cursor SDK's @cursor/sdk/dist/esm/options.d.ts says model is "required
    // for local agents" — local is the only mode wechat-cc uses today.
    // Fail-fast at boot with an actionable message rather than crash on
    // first dispatch when Agent.create rejects without a model.
    deps.log('BOOT',
      'cursor: CURSOR_API_KEY is set but cursorModel is not configured. ' +
      'Cursor SDK requires a model id for local agents. ' +
      'Run `wechat-cc provider set cursor --model composer-2` (or another id from `Cursor.models.list()`). ' +
      'Provider not registered.',
    )
  } else if (cursorKey) {
    try {
      const cursorMod = await import('@cursor/sdk') as unknown as import('../../core/cursor-agent-provider').CursorSdkNamespace
      const { createCursorAgentProvider } = await import('../../core/cursor-agent-provider')
      registry.register(
        'cursor',
        createCursorAgentProvider({
          sdk: cursorMod,
          apiKey: cursorKey,
          model: configuredAgent.cursorModel!,
          mcpServers: {
            ...(wechatStdioForCursor ? { wechat: wechatStdioForCursor } : {}),
            ...(delegateStdioForCursor ? { delegate: delegateStdioForCursor } : {}),
            ...pluginMcp,
          },
        }),
        {
          displayName: 'Cursor',
          // P1 ships with resume disabled — Agent.resume(agentId) is documented
          // but unverified in the spike beyond static types. Enable in a P1.1
          // follow-up after dogfooding.
          canResume: () => false,
        },
      )
      deps.log('BOOT', 'cursor: SDK + API key present — provider registered')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      deps.log('BOOT', `cursor: SDK not available (${msg}) — run \`bun add @cursor/sdk\` to enable; provider not registered`)
    }
  } else {
    deps.log('BOOT', 'cursor: CURSOR_API_KEY not set — provider not registered')
  }

  // ──────────────────────────────────────────────────────────────
  // OpenAI-compatible provider — fourth registered provider. Targets any
  // OpenAI-Chat-Completions-shaped endpoint (DeepSeek/Kimi/Qwen/OpenRouter/
  // Ollama, …) via the AI SDK. WECHAT_OPENAI_API_KEY is env-only (same
  // rationale as CURSOR_API_KEY above); base_url + model live in
  // agent-config.json (openaiBaseUrl/openaiModel) since they're not secret
  // and vary per backend. All three must be present or the provider is
  // skipped with a BOOT log line. The SDK modules are dynamic-imported so a
  // registration failure (missing dep, bad config) degrades to a log line
  // instead of crashing boot.
  const openaiKey = process.env.WECHAT_OPENAI_API_KEY
  if (openaiKey && configuredAgent.openaiBaseUrl && configuredAgent.openaiModel) {
    // Narrowed into locals: property access on `configuredAgent` doesn't
    // stay narrowed inside the `makeChatModel` closure below (TS only
    // preserves narrowing for local const bindings, not object properties).
    const openaiBaseUrl = configuredAgent.openaiBaseUrl
    const defaultOpenaiModel = configuredAgent.openaiModel
    try {
      const { createOpenAiAgentProvider } = await import('../../core/openai-agent-provider')
      const { createAiSdkChatModel } = await import('../../core/openai-chat-model')
      const { createMcpToolBridge } = await import('../../core/openai-mcp-bridge')
      registry.register(
        'openai',
        createOpenAiAgentProvider({
          // Built per-spawn (not once at construction) so an operator's
          // `/api <model>` pin — re-read via the mtime-cached config reader
          // through currentModelFor → SpawnContext.model — takes effect on
          // the NEXT session without a daemon restart. `model` is undefined
          // for background evals (cheapEval/strongEval) and for spawns before
          // any pin exists; both fall back to the boot-time configured model.
          // createAiSdkChatModel is cheap (just SDK client wiring, no
          // network), so constructing one per spawn is fine.
          makeChatModel: (model) => createAiSdkChatModel({
            baseURL: openaiBaseUrl,
            apiKey: openaiKey,
            model: model ?? defaultOpenaiModel,
          }),
          // Gated via buildOpenaiMcpSpecs so only wechat/delegate ever see
          // sessionEnv (WECHAT_SESSION_TOKEN) — third-party plugin MCP specs
          // must never receive the daemon's loopback bearer token. See
          // mcp-specs.ts buildOpenaiMcpSpecs doc comment.
          makeMcpBridge: async (sessionEnv) => createMcpToolBridge(
            buildOpenaiMcpSpecs(
              { wechat: wechatStdioForOpenai, delegate: delegateStdioForOpenai, pluginMcp },
              sessionEnv,
            ),
          ),
          log: deps.log,
        }),
        {
          displayName: 'OpenAI-compatible',
          // No resume support in v1 — same posture as cursor above.
          canResume: () => false,
        },
      )
      deps.log('BOOT', 'openai: base_url + model + WECHAT_OPENAI_API_KEY present — provider registered')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      deps.log('BOOT', `openai: registration failed (${msg}) — provider not registered`)
    }
  } else {
    deps.log('BOOT', 'openai: not configured (need WECHAT_OPENAI_API_KEY + openaiBaseUrl + openaiModel) — provider not registered')
  }

  // ──────────────────────────────────────────────────────────────
  // Gemini provider — fifth registered provider.
  //
  // GEMINI_API_KEY (or GOOGLE_API_KEY) is env-only — not stored in
  // agent-config.json. The @google/genai SDK is loaded via dynamic
  // import so wechat-cc remains installable without it — operators
  // who don't want Gemini can `bun remove @google/genai` and the
  // registration silently skips.
  //
  // geminiModel must be set via `wechat-cc provider set gemini
  // --model gemini-flash-latest` before the key is useful.
  const geminiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY
  if (geminiKey && !configuredAgent.geminiModel) {
    deps.log('BOOT',
      'gemini: GEMINI_API_KEY is set but geminiModel is not configured. ' +
      'Run `wechat-cc provider set gemini --model gemini-flash-latest`. Provider not registered.',
    )
  } else if (geminiKey) {
    try {
      const { GoogleGenAI } = await import('@google/genai')
      const { createGeminiAgentProvider, makeGeminiToolGate, connectWechatMcp } = await import('../../core/gemini-agent-provider')
      const { lookup } = await import('../../core/capability-matrix')
      const genaiClient = new GoogleGenAI({ apiKey: geminiKey }) as unknown as import('../../core/gemini-agent-provider').GenaiClient
      const buildGate = makeGeminiToolGate({
        askUser: deps.ilink.askUser,
        adminFor: (chatId) => resolveAdminChatId(loadAccess(), loadCompanionConfig(deps.stateDir), chatId),
        modeFor: (chatId) => conversationStore.get(chatId)?.mode.kind ?? 'solo',
        lookupBase: (mode, perm) => lookup(mode as never, 'gemini', perm),
      })
      registry.register(
        'gemini',
        createGeminiAgentProvider({
          genai: genaiClient,
          model: configuredAgent.geminiModel!,
          systemInstruction: buildSystemPrompt({
            providerId: 'gemini',
            peerProviderId: 'claude',
            companionEnabled: deps.ilink.companion.status().enabled,
            delegateAvailable: false,
          }),
          mcpConnect: () => {
            if (!wechatStdioForGemini) throw new Error('gemini: internalApi unavailable — cannot connect wechat MCP')
            return connectWechatMcp(wechatStdioForGemini)
          },
          buildGate,
          cheapModel: process.env.WECHAT_GEMINI_CHEAP_MODEL ?? 'gemini-flash-latest',
        }),
        { displayName: 'Gemini', canResume: () => false },
      )
      deps.log('BOOT', 'gemini: SDK + API key present — provider registered')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      deps.log('BOOT', `gemini: SDK not available (${msg}) — run \`bun add @google/genai\` to enable; provider not registered`)
    }
  } else {
    deps.log('BOOT', 'gemini: GEMINI_API_KEY not set — provider not registered')
  }

  // Fail-fast at boot if any registered provider is missing matrix rows.
  // Was previously a module-load self-call in capability-matrix with a
  // hardcoded ['claude', 'codex'] — added providers (gemini, cursor, …)
  // would silently slip past and only throw at first use in production.
  assertMatrixComplete(registry.list())

  // The single, provider-agnostic source of every session's system prompt.
  // SessionManager calls this once per spawn (like mcpEnv) and forwards the
  // result via SpawnContext; each provider injects it through its own
  // transport. peerProviderId + delegateAvailable derive from the provider's
  // ProviderCapabilities.defaultPeer + whether its delegate spec was actually
  // wired (no per-provider ternary — adding a provider needs no edit here).
  // daemonOpsAvailable mirrors the admin predicate the wechat MCP server gates
  // its daemon-control tools on, so the self-heal section appears iff those
  // tools are actually registered for this spawn. careEnabled mirrors
  // `deps.careLevelFor` the same way — absent thunk ⇒ 'off' ⇒ section never
  // included (proactive-care design §7). It also requires memory_write:
  // guests can't author agenda.md entries or call set_chat_pref (both
  // memory_write), so showing the care section would just burn turns on
  // denied tool calls — gap check-ins (guest-allowed `reply`) work fine
  // without it. stickerTags mirrors `deps.stickerTagsFor`
  // the same way — absent thunk ⇒ [] ⇒ section never included. persona /
  // personaCultivate mirror `deps.personaFor` the same way — absent thunk
  // ⇒ both persona sections never included (persona design §2).
  // newRelationship mirrors `deps.newRelationshipFor` the same way — absent
  // thunk ⇒ section never included (onboarding-curiosity design §2). Like
  // careEnabled it's also memory_write-gated: the section nudges the agent
  // to jot notes/observations into memory, so a guest-tier owner chat must
  // not get that instruction either. personaEmpty is passed through
  // unconditionally — buildSystemPrompt only surfaces it nested inside the
  // (already tier-gated) persona-cultivation section, so no extra gating
  // is needed here. coreMemory mirrors `deps.coreMemoryFor` the same way —
  // absent thunk ⇒ section never included (core-memory-injection design
  // §2). Unlike personaFor (owner chat via default_chat_id), coreMemoryFor
  // is called with THIS chat's own chatId, so each chat gets its own
  // profile.md excerpt.
  const buildInstructions = (providerId: ProviderId, tierProfile: TierProfile, chatId: string): string => {
    const p = deps.personaFor?.(chatId)
    return buildSystemPrompt({
      providerId,
      // Unused when delegateAvailable is false; fall back to the daemon default.
      peerProviderId: capabilitiesFor(providerId).defaultPeer ?? defaultProviderId,
      companionEnabled: deps.ilink.companion.status().enabled,
      delegateAvailable: !!delegateStdioByProvider[providerId],
      daemonOpsAvailable: tierProfile.allow.has('daemon_introspect'),
      fileLocateAvailable: tierProfile.allow.has('file_locate'),
      careEnabled: (deps.careLevelFor?.(chatId) ?? 'off') !== 'off' && tierProfile.allow.has('memory_write'),
      stickerTags: deps.stickerTagsFor?.(chatId) ?? [],
      persona: p?.content,
      // Like careEnabled: cultivation guidance tells the agent to WRITE
      // persona.md via memory_write, so it must also be tier-gated — a
      // guest-tier owner chat would otherwise be prompted to make writes
      // its tier profile denies (burned turns on denied tool calls, and a
      // standing invitation to probe the memory surface).
      personaCultivate: p?.cultivate === true && tierProfile.allow.has('memory_write'),
      newRelationship: (deps.newRelationshipFor?.(chatId) ?? false) && tierProfile.allow.has('memory_write'),
      personaEmpty: !(p?.content && p.content.trim().length > 0),
      // core-memory-injection design §2 — this chat's OWN profile.md
      // excerpt (not the owner's). No tier gate: it's a read-only context
      // block, unlike personaCultivate/newRelationship which nudge writes.
      coreMemory: deps.coreMemoryFor?.(chatId),
      knowledgeMemory: deps.knowledgeMemoryFor?.(chatId),
      // bubbleReplies mirrors `deps.bubbleRepliesFor` the same way — absent
      // thunk ⇒ section never included. Deliberately NO tier gate here
      // (unlike careEnabled/newRelationship/personaCultivate): `reply` is
      // guest-allowed, not memory_write-gated, so there's no denied-tool-call
      // risk in giving a guest chat the same bubbling guidance.
      bubbleReplies: deps.bubbleRepliesFor?.(chatId) ?? false,
      // knowledge-orchestration design Task 2 — daemon-global (loaded once at
      // boot, not per-chat), so this is the captured const, not a `*For`
      // thunk. buildSystemPrompt only surfaces the section when at least one
      // name is a KNOWN_KNOWLEDGE_PLUGINS entry, so this is inert when no
      // knowledge plugin is loaded/enabled.
      knowledgePlugins: knowledgePluginNames,
    })
  }

  const sessionManager = new SessionManager({
    maxConcurrent: 6,
    idleEvictMs: 30 * 60_000,
    registry,
    sessionStore,
    resumeTTLMs: 7 * 24 * 60 * 60_000,
    // Per-session auth token lifecycle — minted once per spawn, revoked on
    // every release/eviction. Both keyed by provider/alias/chatId so they pair.
    mintSessionToken: deps.mintSessionToken,
    invalidateSessionToken: deps.invalidateSession,
    buildInstructions,
    currentModelFor,
  })

  // Task 14 — when admins / trusted / allowFrom set membership changes in
  // access.json, shut down all live sessions so the next acquire respawns
  // under the new tier. Single-step rule: edit access.json → next inbound
  // runs under new tier. Up to 5s lag while the in-process cache holds the
  // old snapshot. Errors during shutdown are logged but swallowed (the
  // access reader must never crash the caller).
  setSessionInvalidator(() => {
    deps.log('ACCESS', 'tier membership changed — invalidating all live sessions')
    void sessionManager.shutdown().catch(err => {
      deps.log('ACCESS', `invalidate shutdown error: ${err instanceof Error ? err.message : String(err)}`)
    })
  })

  // Periodic idle sweep — without this, idleEvictMs is dead config (the
  // method exists but was never called from production paths). 30 min of
  // inactivity is the limit before a session is dropped; the next dispatch
  // spawns a fresh subprocess that re-reads keychain credentials. Required
  // to avoid the long-running-daemon OAuth-staleness path that surfaces as
  // the claude binary streaming "Not logged in · Please run /login" as
  // assistant text. unref() so the timer never keeps the event loop alive
  // (matters for tests that build a real bootstrap and then exit).
  const idleSweepTimer = setInterval(() => {
    sessionManager.sweepIdle().catch(err => {
      deps.log('IDLE_SWEEP', `error: ${err instanceof Error ? err.message : String(err)}`)
    })
  }, 60_000)
  idleSweepTimer.unref()

  // Per-chat conversation mode (RFC 03 P2). Default for new chats =
  // `conversationStore` is created earlier in this function (hoisted so
  // the canUseTool closure has a live reference). `/cc` `/codex` `/solo`
  // commands flip individual chats; persisted in `wechat-cc.db`'s
  // `conversations` table (migrated from the legacy conversations.json
  // in PR7). Caller may inject a shared instance so internal-api
  // (which needs to look up modes for reply-prefixing in P3 parallel
  // mode) sees the same flips. When absent, we own one rooted at <stateDir>.

  // Extracted as a named variable so routeA2ANotify can also call it.
  // v0.5.3 — extracted to fallback-reply.ts so the failure paths log
  // [FALLBACK_REPLY_FAIL] / success path logs [FALLBACK_REPLY_SENT].
  const sendAssistantText = makeSendAssistantText({ sendMessage: deps.ilink.sendMessage, log: deps.log, capture: deps.replySinks?.capture })

  // Per-turn watchdog: the daemon-level bound that guarantees a silently-
  // stalled SDK subprocess (idle timeout, wedge, hung MCP tool) can never
  // wedge the pipeline forever. Defaults to 10 min — generous enough for a
  // legit long turn (memory reads, MCP tools, deep thinking) yet finite, so
  // the coordinator always reclaims the session and the next message is
  // served. Override via WECHAT_TURN_TIMEOUT_MS (0 disables — not advised).
  const turnTimeoutMs = (() => {
    const raw = process.env['WECHAT_TURN_TIMEOUT_MS']
    if (raw == null || raw === '') return 10 * 60_000
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? n : 10 * 60_000
  })()

  // recordTurn — emit the structured TurnRecord as a fields-bearing log line
  // AND persist it via the optional onTurnRecord sink. deps.log routes the
  // third arg into channel.log.jsonl, so every turn's outcome (completed /
  // timeout / auth_failed / error) is greppable there; onTurnRecord (wired in
  // main.ts to the SQLite turn_records store) makes it *queryable* on
  // internal-api and survives the restart a hang/crash triggers — the
  // AI-legible answer to "why did this chat stop replying", post-mortem-safe.
  const recordTurn = (record: TurnRecord): void => {
    deps.log('TURN', `chat=${record.chatId} provider=${record.provider} outcome=${record.outcome} dur=${record.durationMs}ms reply=${record.replyToolCalled} chunks=${record.textChunks}${record.error ? ` error=${JSON.stringify(record.error.slice(0, 160))}` : ''}`, {
      event: 'turn_record',
      ...record,
    })
    // Persistence is best-effort: a store write must never break dispatch.
    try { deps.onTurnRecord?.(record) } catch (err) {
      deps.log('TURN', `onTurnRecord sink threw: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const coordinator = createConversationCoordinator({
    resolveProject: resolve,
    manager: sessionManager,
    conversationStore,
    registry,
    defaultProviderId,
    format: formatInbound,
    permissionMode,
    turnTimeoutMs,
    recordTurn,
    // sendAssistantText fallback path: same fall-through the legacy
    // routeInbound used to take when the agent didn't call a reply tool.
    // main.ts injects a real ilink.sendMessage closure; bootstrap.ts only
    // wires the structural piece.
    sendAssistantText,
    // Task 10 — coordinator resolves per-chat tier on every dispatch.
    // loadAccess() reads access.json with a 5s in-process TTL cache, so
    // this is cheap to call per inbound. Admin/trusted/guest classification
    // determines which TierProfile the session is spawned under.
    loadAccess,
    log: deps.log,
    // PR F — chatroom moderator now resolves a provider-agnostic cheap
    // eval via ProviderRegistry.getCheapEval(). Each registered provider
    // implements its own cheapest one-shot LLM call (claude → haiku via
    // SDK query(); codex → ephemeral Thread.run with minimal reasoning).
    // The auth-failed sentinel detection that lived in the prior
    // ./haiku-eval helper moves to a shared agent-provider helper
    // applied at the callsite — so stale creds throw a structured
    // error and the moderator's existing catch branch falls back to
    // forced alternation. Codex-only users no longer hard-fail here.
    haikuEval: wrapCheapEvalWithAuthFailCheck(registry.getCheapEval(), deps.log),
    // /chat beat ③ verdict — the DEFAULT provider's STRONG model (not haiku).
    // Falls back to the cheap eval if that provider has no strongEval, so
    // codex-default deployments still get a verdict.
    verdictEval: wrapCheapEvalWithAuthFailCheck(
      registry.getStrongEval(defaultProviderId) ?? registry.getCheapEval(),
      deps.log,
    ),
  })

  // RFC 03 P4 — bare delegate providers + one-shot dispatcher.
  // See ./delegate.ts for why these are constructed separately from the
  // registry's main providers (no mcpServers — recursion prevention).
  const dispatchDelegate = buildDelegateDispatch({
    stateDir: deps.stateDir,
    ...(claudeBin ? { claudeBin } : {}),
  })

  // ── A2A wiring ────────────────────────────────────────────────────────
  // Instantiate registry, client, events store. These are cheap objects
  // that don't require a2a_listen to be configured — they're also used
  // by POST /v1/a2a/send (outbound calls from the MCP tool).
  const a2aRegistry = createA2ARegistry({ stateDir: deps.stateDir })
  const a2aClient = createA2AClient()
  const a2aEventsStore = makeA2AEventsStore(deps.db)

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
    const row = deps.db.query<{ chat_id: string }, []>(
      'SELECT chat_id FROM conversations ORDER BY updated_at ASC LIMIT 1',
    ).get()
    if (row?.chat_id) cachedOperatorChatId = row.chat_id
    return cachedOperatorChatId
  }

  // ── Agent-social M1 wiring (T7b-core) ───────────────────────────────────
  // Gated on BOTH social_enabled and social_disclosure_policy — absent
  // either, the feature stays fully inert: no onIntent/onIntentConfirm
  // wired into the a2a server below, no broker constructed, no
  // /v1/social/seek functionality (the route 503s). This wires everything
  // EXCEPT capturing the operator's WeChat yes/no reply (a separate task,
  // T7b-2) — every confirmWithOwner ask still gets SENT to the operator's
  // chat; it just times out to `false` after 5 minutes until 7b-2 lands.
  let socialOnIntent: A2AServerOpts['onIntent']
  let socialOnIntentConfirm: A2AServerOpts['onIntentConfirm']
  let socialBroker: { seek(topic: string, opts?: { city?: string }): Promise<SeekOutcome> } | undefined
  let socialPendingConfirms: PendingConfirms | undefined
  let socialSeekStore: import('../../core/social-seek-store').SeekStore | undefined
  let socialEchoStore: import('../../core/social-echo-store').EchoStore | undefined

  if (configuredAgent.social_enabled && configuredAgent.social_disclosure_policy) {
    const socialPolicy = configuredAgent.social_disclosure_policy
    const socialCheapEval = registry.getCheapEval()
    if (!socialCheapEval) {
      // Same degrade pattern as the openai provider block above: log and
      // skip rather than throw. No registered provider implements cheapEval
      // is exotic in practice (claude always registers one), but the seam
      // must degrade gracefully like every other optional wiring here.
      deps.log('BOOT', 'social: no cheapEval available from any registered provider — social_enabled is on but wiring is skipped (inert)')
    } else {
      const SOCIAL_SELF_ID = process.env.WECHAT_A2A_SELF_ID || 'wechat-cc'
      const socialOpenaiKey = process.env.WECHAT_OPENAI_API_KEY

      // The judge's runTurn seam (daemon/social/grounded-judge.ts). Provider-
      // specific adapters spawn a one-shot session carrying ONLY the plugin
      // MCP tools — the answerer must never get wechat tools (could
      // send-as-owner) or delegate-mcp (could recurse). Falls back to the
      // registry's cheapEval (no tools at all) when the default provider has
      // no grounded adapter yet — judging still works, just without
      // plugin-grounded facts.
      const { makeGroundedJudgeRunTurn } = await import('../social/grounded-judge')
      const groundedRunTurn = makeGroundedJudgeRunTurn({
        providerId: defaultProviderId,
        pluginMcp,
        stateDir: deps.stateDir,
        log: deps.log,
        openai: (socialOpenaiKey && configuredAgent.openaiBaseUrl && configuredAgent.openaiModel)
          ? { apiKey: socialOpenaiKey, baseUrl: configuredAgent.openaiBaseUrl, model: configuredAgent.openaiModel }
          : undefined,
        claude: { model: () => currentClaudeModel(), ...(claudeBin ? { claudeBin } : {}) },
      })
      const socialRunTurn: (systemPrompt: string, userPrompt: string) => Promise<string> =
        groundedRunTurn ?? (async (systemPrompt, userPrompt) => socialCheapEval(`${systemPrompt}\n\n${userPrompt}`))
      deps.log('BOOT', groundedRunTurn
        ? `social: plugin-grounded judge via ${defaultProviderId} (pluginMcp only, no wechat/delegate)`
        : `social: grounded judging unavailable for provider=${defaultProviderId} — judge falls back to cheapEval (no tools)`)

      const socialJudge = makeJudge({ runTurn: socialRunTurn, policy: socialPolicy })
      socialOnIntent = makeAnswerIntent({ judge: socialJudge, policy: socialPolicy, cheapEval: socialCheapEval })

      socialPendingConfirms = createPendingConfirms()
      const pendingConfirmsRef = socialPendingConfirms

      // The peer-driven confirm leg (second half of the dual-confirm
      // handshake): a matched peer's broker asks THIS owner to confirm.
      // Keyed on intent_id (threaded through the wire body), unlike
      // confirmWithOwner below.
      socialOnIntentConfirm = async ({ intent_id }) => {
        const op = resolveOperatorChatId()
        if (!op) return { ok: false }
        if (sendAssistantText) await sendAssistantText(op, '🤝 有人想和你牵线,回复 是/否')
        return { ok: await pendingConfirmsRef.ask(`${op}:${intent_id}`, 5 * 60_000) }
      }

      // Persisted state layer (觅食台 P1) — every seek gets a `social_seek`
      // row and every match a `social_echo` row, wrapped around the raw
      // broker below so `broker.seek`'s return value stays byte-for-byte
      // identical. P1 records the SYNCHRONOUS outcome only; async/
      // background foraging (trickling echoes in over time) is a later
      // rework. Stores are constructed here so a follow-up (P2's internal-
      // api read surface) can reach them via the social sub-object.
      const seekStore = makeSeekStore(deps.db)
      const echoStore = makeEchoStore(deps.db)
      socialSeekStore = seekStore
      socialEchoStore = echoStore

      const rawBroker = makeBroker({
        policy: socialPolicy,
        cheapEval: socialCheapEval,
        // TODO(v1+): rank candidates via wxgraph closeness/topical relevance
        // instead of "every paired peer, capped" — see design doc's
        // Discovery section. Minimal-but-safe for M1: targeted (bounded to
        // paired peers only), never a broadcast to strangers.
        discover: async (_topic) => a2aRegistry.list().filter(a => !a.paused).slice(0, 5),
        send: async (hand, card) => {
          const r = await a2aClient.send({ url: intentUrl(hand.url), bearer: hand.outbound_api_key, body: { agent_id: SOCIAL_SELF_ID, card } })
          return r.ok ? MatchReceiptSchema.parse(r.response) : null
        },
        confirmPeer: async (hand, card) => {
          const r = await a2aClient.send({
            url: intentUrl(hand.url) + '/confirm',
            bearer: hand.outbound_api_key,
            body: { agent_id: SOCIAL_SELF_ID, intent_id: card.intent_id },
          })
          return r.ok && (r.response as { ok?: unknown } | undefined)?.ok === true
        },
        confirmWithOwner: async (summary) => {
          const op = resolveOperatorChatId()
          if (!op) return false
          if (sendAssistantText) await sendAssistantText(op, '🤝 ' + summary + '(回复 是/否)')
          // See hashSummary's doc comment: the broker's confirmWithOwner
          // seam only takes a rendered summary, not the intent_id, so we
          // key on a hash of the summary rather than the real intent_id.
          return pendingConfirmsRef.ask(`${op}:${hashSummary(summary)}`, 5 * 60_000)
        },
      })
      socialBroker = {
        async seek(topic, opts) {
          const outcome = await rawBroker.seek(topic, opts)
          // Record the wish + whatever came back. P1 records the synchronous
          // outcome; async/background foraging is a later rework. The raw
          // broker never throws (fail-closed), but these store writes can
          // (locked db, disk full, duplicate PK) — guard them so a
          // persistence error can't turn a successful seek (possibly one
          // that already made live introductions) into a caller-visible
          // failure. Recording wraps the outcome; it must never alter it.
          try {
            seekStore.create({ id: outcome.intent_id, kind: 'seek', topic })
            const status = outcome.lit.length ? 'connected' : outcome.matched.length ? 'echoed' : 'closed'
            seekStore.update(outcome.intent_id, { status, peersAsked: outcome.matched.length })
            for (const m of outcome.matched) {
              const echoId = `${outcome.intent_id}:${m.hand}`
              echoStore.create({ id: echoId, seekId: outcome.intent_id, peerMasked: '第 1 度的某人', degree: 1, content: m.blurb ?? '' })
              if (outcome.lit.includes(m.hand)) echoStore.setStatus(echoId, 'revealed')
            }
          } catch (err) {
            deps.log('SOCIAL_REC', `failed to record seek outcome intent_id=${outcome.intent_id}: ${err instanceof Error ? err.message : String(err)}`)
          }
          return outcome
        },
      }
    }
  }

  // onNotify: route inbound A2A notification → operator chat via sendAssistantText.
  // Formats the message as `[A2A:<agentId>] <text>` so the operator can
  // visually distinguish A2A pushes from regular assistant replies.
  async function routeA2ANotify(event: NotifyEvent): Promise<void> {
    const operatorChatId = resolveOperatorChatId()
    if (!operatorChatId) {
      deps.log('A2A_NOTIFY_IN', `dropping notify from ${event.agent.id}: no operator chat bound yet`)
      // Record the drop so operator sees it in the activity drawer instead
      // of wondering "the test said delivered, why didn't I get anything?"
      a2aEventsStore.append({
        direction: 'in', agent_id: event.agent.id, text: event.text,
        urgency: event.urgency, status: 'dropped_no_operator_chat',
      })
      return
    }
    const formatted = `[A2A:${event.agent.id}] ${event.text}`
    if (sendAssistantText) {
      await sendAssistantText(operatorChatId, formatted)
    }
    a2aEventsStore.append({
      direction: 'in', agent_id: event.agent.id, text: event.text,
      urgency: event.urgency, status: 'ok',
    })
  }

  // Server only starts if a2a_listen is configured. When absent, the
  // a2aServer handle is null and POST /v1/a2a/send still works (outbound
  // only — the daemon won't receive inbound pushes without a listener).
  let a2aServer: ReturnType<typeof createA2AServer> | null = null
  if (configuredAgent.a2a_listen) {
    a2aServer = createA2AServer({
      host: configuredAgent.a2a_listen.host,
      port: configuredAgent.a2a_listen.port,
      registry: a2aRegistry,
      onNotify: routeA2ANotify,
      // "Hand" capability (one-brain-many-hands): a registered peer can POST
      // /a2a/exec to run THIS machine's local agent on a task and get the
      // result, via the same one-shot delegate dispatcher used by /v1/delegate.
      onExec: (event) => dispatchDelegate(event.peer, event.prompt, event.cwd),
      // Smooth pairing (一条命令配对): a brain that holds a fresh invite secret
      // (from `hand invite` on this machine) POSTs /a2a/pair to auto-register
      // itself as an allowed delegator. Verify+consume the one-time secret,
      // then register the brain with the exec key it minted (re-pair refreshes
      // the key). Same record shape as `hand accept`, just no manual token copy.
      onPair: async ({ secret, brainId, execKey }) => {
        if (!verifyAndConsumeInvite(deps.stateDir, secret, Date.now())) {
          return { ok: false, error: 'invalid_or_expired_invite' }
        }
        const existing = a2aRegistry.get(brainId)
        if (existing) {
          a2aRegistry.update(brainId, { inbound_api_key: execKey })
        } else {
          a2aRegistry.add({
            id: brainId,
            name: brainId,
            url: 'http://brain.local/a2a',   // placeholder; exec replies inline, no callback needed
            inbound_api_key: execKey,        // brain presents this → hand verifies
            outbound_api_key: 'unused',      // hand → brain unused for exec; schema needs ≥1
            capabilities: [],
            paused: false,
            transport: 'push',
          })
        }
        a2aEventsStore.append({
          direction: 'in',
          agent_id: brainId,
          text: '<paired via invite code>',
          status: 'ok',
        })
        deps.log('A2A', `paired with brain "${brainId}" via invite code`)
        return { ok: true }
      },
      // Observability: 401/403 failures with an identifiable agent_id_claimed
      // get a `status='auth_failed'` row so the operator sees auth attempts
      // in the dashboard activity drawer + `wechat-cc agent activity <id>`.
      onAuthFailed: (event) => {
        a2aEventsStore.append({
          direction: 'in',
          agent_id: event.agent_id_claimed,
          text: `<auth_failed: ${event.reason}>`,
          status: 'auth_failed',
        })
      },
      // Agent-social M1 (T7b-core) — only wired when social_enabled +
      // social_disclosure_policy are configured (see wiring block above).
      // Undefined ⇒ /a2a/intent and /a2a/intent/confirm both 501, exactly
      // like every other optional A2A capability.
      ...(socialOnIntent ? { onIntent: socialOnIntent } : {}),
      ...(socialOnIntentConfirm ? { onIntentConfirm: socialOnIntentConfirm } : {}),
      daemonInfo: { name: 'wechat-cc', version: selfPkg.version },
    })
    await a2aServer.start()
    deps.log('A2A', `server listening on http://${configuredAgent.a2a_listen.host}:${a2aServer.port()}`)
  }

  // Discovery file — non-sensitive (no token), tells CLI + dashboard the
  // daemon's A2A server status. Operator runs `wechat-cc agent info`,
  // which reads this file directly (no internal-api round-trip needed).
  // Mode 0644 because there's no secret here, just an HTTP base URL.
  const a2aInfoPath = join(deps.stateDir, 'a2a-info.json')
  try {
    writeFileSync(
      a2aInfoPath,
      JSON.stringify({
        enabled: !!a2aServer,
        base_url: a2aServer ? a2aServer.baseUrl() : null,
        host: a2aServer ? configuredAgent.a2a_listen!.host : null,
        port: a2aServer ? a2aServer.port() : null,
        pid: process.pid,
        ts: Date.now(),
      }, null, 2),
      { mode: 0o644 },
    )
  } catch { /* non-fatal: CLI falls back to internal-api lookup */ }

  const a2aDeps = {
    registry: a2aRegistry,
    client: a2aClient,
    eventsStore: a2aEventsStore,
    recordEvent: (event: AppendInput) => a2aEventsStore.append(event),
    serverEnabled: !!configuredAgent.a2a_listen,
    baseUrl: a2aServer ? a2aServer.baseUrl() : null,
  }

  // ── 乙 v2 wiring (guarded — no-op when config absent) ────────────────────
  // BRAIN side: start a WebSocket rendezvous that hands connect to.
  let yiHub: YiHub | undefined
  if ((configuredAgent as { yi_hub_listen?: { host: string; port: number } }).yi_hub_listen) {
    const cfg = (configuredAgent as { yi_hub_listen: { host: string; port: number } }).yi_hub_listen
    yiHub = createYiHub()
    const yiServer = createYiWsServer({
      host: cfg.host,
      port: cfg.port,
      hub: yiHub,
      verify: (id, tok) => !!a2aRegistry.verifyBearer(id, tok),
    })
    await yiServer.start()
    deps.log('YI', `hub listening on ws://${cfg.host}:${yiServer.port()}`)
  }

  // HAND side: connect outbound to a brain's rendezvous.
  if ((configuredAgent as { yi_brain?: { url: string; handId: string; authToken: string } }).yi_brain) {
    const cfg = (configuredAgent as { yi_brain: { url: string; handId: string; authToken: string } }).yi_brain
    const { createYiWsClient } = await import('../yi-ws-client')
    const yiClient = createYiWsClient({
      brainUrl: cfg.url,
      handId: cfg.handId,
      authToken: cfg.authToken,
      capabilities: ['exec'],
      onExec: (t) => dispatchDelegate(t.peer, t.prompt, t.cwd),
      log: (m) => deps.log('YI', m),
    })
    yiClient.start()
    deps.log('YI', `hand connecting to brain at ${cfg.url}`)
  }

  return {
    sessionManager,
    sessionStore,
    conversationStore,
    registry,
    coordinator,
    resolve,
    formatInbound,
    sdkOptionsForProject,
    buildInstructions,
    defaultProviderId,
    agentProviderKind: defaultProviderId,
    /**
     * RFC 03 P4 — late-bound into internal-api by main.ts after
     * buildBootstrap returns. The route is 503 until that wiring lands.
     */
    dispatchDelegate,
    a2aDeps,
    a2aServer,
    yiHub,
    agentConfig: configuredAgent,
    /**
     * Agent-social M1 (T7b-core) — late-bound into internal-api by main.ts
     * (mirrors a2aDeps/setA2A). Undefined when social_enabled +
     * social_disclosure_policy aren't both configured — POST
     * /v1/social/seek then 503s.
     */
    ...(socialBroker ? { social: { broker: socialBroker, pendingConfirms: socialPendingConfirms!, seekStore: socialSeekStore!, echoStore: socialEchoStore! } } : {}),
  }
}
