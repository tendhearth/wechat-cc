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
import { tierProfileToClaudeSdkOpts } from '../../core/claude-agent-provider'
import type { TierProfile } from '../../core/user-tier'
import { resolveTier, TIER_PROFILES } from '../../core/user-tier'
import { createConversationCoordinator, type ConversationCoordinator, type TurnRecord } from '../../core/conversation-coordinator'
import { makeConversationStore, type ConversationStore } from '../../core/conversation-store'
import { buildSystemPrompt } from '../../core/prompt-builder'
import type { ProviderId } from '../../core/conversation'
import { makeResolver } from '../../core/project-resolver'
import { makeCanUseTool } from '../../core/permission-relay'
import { capabilitiesFor, capabilityProviderIds, type PermissionMode } from '../../core/capability-matrix'
import { formatInbound } from '../../core/prompt-format'
import type { IlinkAdapter } from '../ilink-glue'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { findOnPath } from '../../lib/util'
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
import { makeSendAssistantText, type SendAssistantText } from './fallback-reply'
import { registerProviders } from './providers'
import { wireSocial } from './wire-social'
import { assertNotAuthFailed, type CheapEval } from '../../core/agent-provider'
import { createA2ARegistry } from '../../core/a2a-registry'
import { createA2AClient } from '../../core/a2a-client'
import { createA2AServer, type NotifyEvent } from '../../core/a2a-server'
import { verifyAndConsumeInvite } from '../../lib/a2a-pairing'
import { makeA2AEventsStore, type AppendInput } from '../../core/a2a-events-store'
import { createYiHub, type YiHub } from '../../core/yi-hub'
import { createYiWsServer } from '../yi-ws-server'
// JSON import — version field is read at module init. resolveJsonModule is
// on in tsconfig, and `with { type: 'json' }` is the spec'd syntax.
import selfPkg from '../../../package.json' with { type: 'json' }
import type { BootstrapDeps, Bootstrap } from './types'
export type { BootstrapDeps, Bootstrap } from './types'

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
  const { registry, defaultProviderId, codexBinary, codexVersionCheck } = await registerProviders({
    log: deps.log,
    stateDir: deps.stateDir,
    ilink: deps.ilink,
    agentProviderKind: deps.agentProviderKind,
    configuredAgent,
    permissionMode,
    conversationStore,
    sdkOptionsForProject,
    claudeBin,
    currentClaudeModel,
    resolveAdminChatId,
    pluginMcp,
    wechatStdioForCodex,
    delegateStdioForCodex,
    wechatStdioForCursor,
    delegateStdioForCursor,
    wechatStdioForOpenai,
    delegateStdioForOpenai,
    wechatStdioForGemini,
  })

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
    ...(codexBinary && codexVersionCheck?.ok ? { codexPathOverride: codexBinary } : {}),
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

  const socialWiring = await wireSocial({
    log: deps.log,
    stateDir: deps.stateDir,
    db: deps.db,
    configuredAgent,
    registry,
    defaultProviderId,
    pluginMcp,
    currentClaudeModel,
    claudeBin,
    resolveOperatorChatId,
    sendAssistantText,
    a2aRegistry,
    a2aClient,
    getServerBaseUrl: () => a2aServer ? a2aServer.baseUrl() : null,
  })

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
      // Undefined ⇒ /a2a/intent and /a2a/reveal both 501, exactly like
      // every other optional A2A capability.
      ...(socialWiring.onIntent ? { onIntent: socialWiring.onIntent } : {}),
      ...(socialWiring.onReveal ? { onReveal: socialWiring.onReveal } : {}),
      daemonInfo: { name: 'wechat-cc', version: selfPkg.version },
    })
    await a2aServer.start()
    deps.log('A2A', `server listening on http://${configuredAgent.a2a_listen.host}:${a2aServer.port()}`)
  }

  // Restart-resume: a seek still in `foraging` means its background leg never
  // finished (a completed leg moves the row to echoed/closed). Re-forage them.
  // Idempotent via the echo PK (intent_id:peer_agent_id): a duplicate send does
  // not double-insert. Fire-and-forget; one bad row never blocks boot.
  socialWiring.resumeForaging()

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
    sendAssistantText,
    /**
     * Agent-social M1 (T7b-core) — late-bound into internal-api by main.ts
     * (mirrors a2aDeps/setA2A). Undefined when social_enabled +
     * social_disclosure_policy aren't both configured — POST
     * /v1/social/seek then 503s.
     */
    ...(socialWiring.social ? { social: socialWiring.social } : {}),
  }
}
