import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
// zod v4: `import { z } from 'zod'` resolves to undefined under vitest's
// bundler; use the default export instead (both forms are equivalent at
// runtime — this is a build-tool interop quirk, not a zod API difference).
import z from 'zod'

export type AgentProviderKind = 'claude' | 'codex' | 'cursor' | 'openai' | 'gemini'

export interface AgentConfig {
  provider: AgentProviderKind
  model?: string
  // Cursor-specific model id (e.g. 'composer-2'). Mirrors `model?`'s
  // optional-string shape so an operator can persist a Cursor model
  // alongside the Claude one without overloading a single field.
  cursorModel?: string
  // OpenAI-compatible provider fields (also covers OpenAI-compatible
  // endpoints like DeepSeek). Mirrors `cursorModel?`'s shape: kept separate
  // from `model?` so switching providers doesn't clobber another
  // provider's pinned model/endpoint.
  openaiBaseUrl?: string
  openaiModel?: string
  geminiModel?: string
  // When true, the daemon spawned by `service install` runs with
  // `cli.ts run --dangerously` (Claude SDK permissionMode=bypassPermissions).
  // Wizard-installed daemons need this on by default — there is no human
  // to answer permission prompts triggered by inbound WeChat messages.
  dangerouslySkipPermissions: boolean
  // When true, `service install` registers the unit for auto-start at
  // login/boot (macOS RunAtLoad, systemd `enable`, schtasks ONLOGON).
  // v0.6 default: true — first-time GUI users expect the daemon to
  // survive reboot without an extra step.
  autoStart: boolean
  // When true, closing the desktop window terminates the daemon. Default
  // false (advanced setting): the GUI is the daemon's launcher, not its
  // host — closing the window should not stop inbound message handling.
  closeStopsDaemon: boolean
  // Admin-chosen self-name. Null/undefined → fall back to botNameFromModeFallback(mode).
  // Constrained to NICKNAME_RE (1-24 chars, CJK/Latin/digits/space/_/-).
  // Set via the daemon's onboarding flow (first admin scan) or `/name` command.
  bot_name?: string | null
  // A2A: optional listener and registered peer agent records.
  a2a_listen?: A2AListen
  a2a_agents?: A2AAgentRecord[]
  // Mailbox transport (sub-project B): this daemon's OWN relay list — where
  // it advertises its mailbox reachability to peers and polls for inbound
  // envelopes. Mirrors `a2a_agents?`'s optional-array shape.
  mailbox_relays?: string[]
  // Dialogue private-thread lock. Stores a scrypt-derived passphrase hash
  // as `salt:hexhash` (both hex). Absent → no lock configured (the desktop
  // dialogue page hides its unlock affordance). Set/verified via the
  // `dialogue lock set` / `dialogue unlock` CLI commands.
  dialogue_lock_hash?: string
  // 乙 v2 — BRAIN side: listen for hand WebSocket connections on this host:port.
  yi_hub_listen?: { host: string; port: number }
  // 乙 v2 — HAND side: connect outbound to this brain WebSocket URL.
  yi_brain?: { url: string; handId: string; authToken: string }
  // Agent-social M1: gates the intent-brokering feature (initiating broker +
  // answering judge) off by default. Mirrors `openaiBaseUrl?`'s optional-field
  // shape — absent/false → the feature stays inert even if a2a peers exist.
  social_enabled?: boolean
  // Free-text disclosure policy the operator writes (e.g. "兴趣可说;住址不可"),
  // consulted by gateOutbound when brokering/answering intents. Required
  // alongside social_enabled for bootstrap to wire the real judge/broker seams.
  social_disclosure_policy?: string
}

// ── A2A sub-schemas ──────────────────────────────────────────────────────────

export const A2AAgentRecord = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'agent id must match ^[a-z0-9][a-z0-9-]{0,63}$ (lowercase slug)'),
  name: z.string().min(1).max(128),
  url: z.string().url(),
  inbound_api_key: z.string().min(16),
  outbound_api_key: z.string().min(1),
  capabilities: z.array(z.string()),
  paused: z.boolean().default(false),
  transport: z.enum(['push', 'ws', 'mailbox']).default('push'),
  /** Mailbox transport (sub-project B): the peer's Ed25519 mailbox address (drop `to` + sig key). */
  mailbox_addr: z.string().optional(),
  /** The peer's X25519 encryption pubkey — the sealed-box target for envelopes. */
  mailbox_enc_pub: z.string().optional(),
  /** Relay URLs the peer's mailbox is reachable through. */
  relays: z.array(z.string().url()).optional(),
  /** Peer's A2A proto_version captured at install time; unset = unknown (treat as 1). */
  proto_version: z.number().int().optional(),
})

export const A2AListen = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).max(65535),
})

export const YiHubListen = z.object({ host: z.string(), port: z.number() })
export const YiBrain = z.object({ url: z.string(), handId: z.string(), authToken: z.string().min(16) })

export type A2AAgentRecord = z.infer<typeof A2AAgentRecord>
export type A2AListen = z.infer<typeof A2AListen>
export type YiHubListen = z.infer<typeof YiHubListen>
export type YiBrain = z.infer<typeof YiBrain>

const AgentConfigSchema = z.object({
  provider: z.enum(['claude', 'codex', 'cursor', 'openai', 'gemini']).default('claude'),
  model: z.string().optional(),
  cursorModel: z.string().optional(),
  openaiBaseUrl: z.string().optional(),
  openaiModel: z.string().optional(),
  geminiModel: z.string().optional(),
  dangerouslySkipPermissions: z.boolean().default(true),
  autoStart: z.boolean().default(true),
  closeStopsDaemon: z.boolean().default(false),
  a2a_listen: A2AListen.optional(),
  yi_hub_listen: YiHubListen.optional(),
  yi_brain: YiBrain.optional(),
  a2a_agents: z.array(A2AAgentRecord).optional()
    .superRefine((arr, ctx) => {
      const ids = new Set<string>()
      for (const a of arr ?? []) {
        if (ids.has(a.id)) ctx.addIssue({ code: 'custom', message: `duplicate a2a agent id: ${a.id}` })
        ids.add(a.id)
      }
    }),
  bot_name: z.string().nullable().optional(),
  dialogue_lock_hash: z.string().optional(),
  social_enabled: z.boolean().optional(),
  social_disclosure_policy: z.string().optional(),
  mailbox_relays: z.array(z.string().url()).optional(),
})

/**
 * Parse and validate an agent config object using the Zod schema.
 * Throws a ZodError (with descriptive messages) on invalid input.
 * Use this when you have a raw/untrusted object (e.g. loaded from disk
 * by a caller that wants strict validation).
 */
export function parseAgentConfig(raw: unknown): AgentConfig {
  return AgentConfigSchema.parse(raw) as AgentConfig
}

const CONFIG_FILE = 'agent-config.json'

export function loadAgentConfig(stateDir: string): AgentConfig {
  try {
    const raw = readFileSync(join(stateDir, CONFIG_FILE), 'utf8')
    const parsed = JSON.parse(raw) as Partial<AgentConfig> & { keepAlive?: boolean }
    const dangerouslySkipPermissions = parsed.dangerouslySkipPermissions ?? true
    const autoStart = parsed.autoStart ?? true
    const closeStopsDaemon = parsed.closeStopsDaemon ?? false
    const provider: AgentProviderKind =
      parsed.provider === 'codex' ? 'codex'
      : parsed.provider === 'cursor' ? 'cursor'
      : parsed.provider === 'openai' ? 'openai'
      : parsed.provider === 'gemini' ? 'gemini'
      : 'claude'
    // Preserve `model` for both providers. Pre-2026-05-08 only codex
    // honored it; claude inherited the spawned CLI's default which read
    // `~/.claude/.claude.json` and broke daemons whenever the user's
    // interactive alias was something the SDK subprocess couldn't resolve
    // (e.g. fast-mode `opus[1m]` returning 404 from 2.1.133).
    // Parse a2a fields through the sub-schemas so we get validated types.
    // safeParse: if the sub-field is malformed we silently drop it rather
    // than crashing the entire config load (same lenient posture as the
    // rest of this function).
    const a2aListen = parsed.a2a_listen != null
      ? A2AListen.safeParse(parsed.a2a_listen).data
      : undefined
    const yiHubListen = parsed.yi_hub_listen != null ? YiHubListen.safeParse(parsed.yi_hub_listen).data : undefined
    const yiBrain = parsed.yi_brain != null ? YiBrain.safeParse(parsed.yi_brain).data : undefined
    const a2aAgentsRaw = Array.isArray(parsed.a2a_agents) ? parsed.a2a_agents : undefined
    const a2aAgents = a2aAgentsRaw != null
      ? a2aAgentsRaw.flatMap(r => {
          const result = A2AAgentRecord.safeParse(r)
          return result.success ? [result.data] : []
        })
      : undefined

    return {
      provider,
      ...(typeof parsed.model === 'string' ? { model: parsed.model } : {}),
      ...(typeof parsed.cursorModel === 'string' ? { cursorModel: parsed.cursorModel } : {}),
      ...(typeof parsed.openaiBaseUrl === 'string' ? { openaiBaseUrl: parsed.openaiBaseUrl } : {}),
      ...(typeof parsed.openaiModel === 'string' ? { openaiModel: parsed.openaiModel } : {}),
      ...(typeof parsed.geminiModel === 'string' ? { geminiModel: parsed.geminiModel } : {}),
      dangerouslySkipPermissions,
      autoStart,
      closeStopsDaemon,
      ...(a2aListen ? { a2a_listen: a2aListen } : {}),
      ...(yiHubListen ? { yi_hub_listen: yiHubListen } : {}),
      ...(yiBrain ? { yi_brain: yiBrain } : {}),
      ...(a2aAgents && a2aAgents.length > 0 ? { a2a_agents: a2aAgents } : {}),
      ...(parsed.bot_name === null ? { bot_name: null } : {}),
      ...(typeof parsed.bot_name === 'string' ? { bot_name: parsed.bot_name } : {}),
      ...(typeof parsed.dialogue_lock_hash === 'string' ? { dialogue_lock_hash: parsed.dialogue_lock_hash } : {}),
      ...(typeof parsed.social_enabled === 'boolean' ? { social_enabled: parsed.social_enabled } : {}),
      ...(typeof parsed.social_disclosure_policy === 'string' ? { social_disclosure_policy: parsed.social_disclosure_policy } : {}),
      ...(Array.isArray(parsed.mailbox_relays) ? { mailbox_relays: parsed.mailbox_relays } : {}),
    }
  } catch {
    return { provider: 'claude', dangerouslySkipPermissions: true, autoStart: true, closeStopsDaemon: false }
  }
}

/** Injection seam for {@link makeMtimeCachedConfigReader} — real impls hit
 *  the filesystem; tests stub both to drive cache behaviour deterministically
 *  (no reliance on millisecond-granular mtime between two writes). */
export interface CachedConfigReaderDeps {
  /** Cache signature of the config file — `${mtimeMs}:${size}`, or `"absent"`
   *  if it can't be stat'd (missing / unreadable). Including size as well as
   *  mtime closes the same-millisecond / coarse-mtime collision: a `/model`
   *  switch changes the serialized length, so the signature changes even when
   *  two writes share an mtime. A stable `"absent"` keeps the cache warm while
   *  the file legitimately doesn't exist yet. */
  statSig: (path: string) => string
  load: (stateDir: string) => AgentConfig
}

/**
 * Build a config reader that re-parses `agent-config.json` only when its
 * mtime changes — otherwise it returns the cached object. This is what lets
 * an operator's `/model` switch (which rewrites the file) take effect on the
 * next agent spawn WITHOUT a daemon restart: the daemon captured the model
 * once at boot and baked it into a closure, so a change went unseen until
 * restart (the reported P4). The daemon wires this into the per-spawn
 * `sdkOptionsForProject` closure; the new model applies to the next session
 * spawned per chat (an in-flight session keeps its model until released).
 *
 * The mtime check is one `stat` per spawn (cheap) instead of a full read +
 * JSON parse; a cache hit skips both.
 */
export function makeMtimeCachedConfigReader(
  stateDir: string,
  deps?: Partial<CachedConfigReaderDeps>,
): () => AgentConfig {
  const statSig = deps?.statSig ?? ((p: string) => {
    try { const st = statSync(p); return `${st.mtimeMs}:${st.size}` } catch { return 'absent' }
  })
  const load = deps?.load ?? loadAgentConfig
  const path = join(stateDir, CONFIG_FILE)
  let cached: { sig: string; config: AgentConfig } | null = null
  return () => {
    const sig = statSig(path)
    if (cached && cached.sig === sig) return cached.config
    const config = load(stateDir)
    cached = { sig, config }
    return config
  }
}

export function saveAgentConfig(stateDir: string, config: AgentConfig): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const file = join(stateDir, CONFIG_FILE)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

// The pinned model lives in a provider-specific field: cursor reads
// `cursorModel`, openai reads `openaiModel`, claude/codex read `model`. These
// two accessors are the single home for that rule so callers (e.g. the
// /v1/model routes) don't re-encode `provider === 'cursor' ? cursorModel :
// model` at each read/write — writing the wrong field is a silent no-op with
// a falsely-confirming read-back.

/** The model id the configured provider actually reads (undefined if unset). */
export function activeModel(config: AgentConfig): string | undefined {
  if (config.provider === 'cursor') return config.cursorModel
  if (config.provider === 'openai') return config.openaiModel
  if (config.provider === 'gemini') return config.geminiModel
  return config.model
}

/** A copy of `config` with the provider's active model field set to `model`. */
export function withActiveModel(config: AgentConfig, model: string): AgentConfig {
  if (config.provider === 'cursor') return { ...config, cursorModel: model }
  if (config.provider === 'openai') return { ...config, openaiModel: model }
  if (config.provider === 'gemini') return { ...config, geminiModel: model }
  return { ...config, model }
}

// activeModel/withActiveModel above answer "the GLOBAL default provider's
// model" (keyed on config.provider) — correct for /v1/model, boot, desktop.
// The pair below answers "a SPECIFIC provider's model" (keyed on the given
// providerId) — needed when a chat runs a NON-default provider (e.g. `/api`
// switches one chat to openai while the global default stays claude) and by
// `currentModelFor(providerId)` on every spawn. openai/cursor have their OWN
// field so they resolve per-id unconditionally; claude & codex SHARE the
// generic `model` field, so it's only meaningful when the global provider is
// that same one (can't tell a claude pin from a codex pin otherwise).

/** The model id `providerId` should use, resolved per-provider (undefined if unset). */
export function modelForProvider(config: AgentConfig, providerId: string): string | undefined {
  if (providerId === 'openai') return config.openaiModel
  if (providerId === 'cursor') return config.cursorModel
  if (providerId === 'gemini') return config.geminiModel
  return config.provider === providerId ? config.model : undefined
}

/** A copy of `config` with `providerId`'s own model field set — regardless of the global default provider. */
export function withModelForProvider(config: AgentConfig, providerId: string, model: string): AgentConfig {
  if (providerId === 'openai') return { ...config, openaiModel: model }
  if (providerId === 'cursor') return { ...config, cursorModel: model }
  if (providerId === 'gemini') return { ...config, geminiModel: model }
  return { ...config, model }
}
