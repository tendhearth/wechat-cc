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
  // agy provider fields (Antigravity CLI — subscription Gemini via Google AI
  // Pro OAuth). Mirrors `geminiModel?`'s optional-string shape: kept
  // separate so switching providers doesn't clobber another provider's
  // pinned model. `agyBin?` is the resolved `agy` binary path (bootstrap
  // probes `--version` before registering) — not a model field, so it has
  // no modelForProvider/withModelForProvider counterpart.
  agyModel?: string
  agyBin?: string
  /** Resolved `cursor-agent` binary path override (tests opt in; production
   *  falls back to PATH lookup — see providers.ts's cursor CLI branch). */
  cursorAgentBin?: string
  /** 随身 CC 远程隧道开关(2026-08-26):true 则 daemon 拨中继,手机出门
   *  可访问。默认关。`remote_relay_url` 可覆盖默认 relay。 */
  remote_tunnel?: boolean
  remote_relay_url?: string
  /** cheapEval 显式指定(外部集成反馈 #2):设定后内部一次性评估只走
   *  该 provider,openai 注册不再静默劫持。 */
  cheapEvalProvider?: string
  /** openai delegate peer 开关(外部集成反馈 #3):默认 true(向后兼容,
   *  配齐即所有会话可 delegate_openai);false 则不构建该 peer —— 端点只
   *  服务特定会话的场景用它关掉这条"通往端点的路"。 */
  delegateOpenai?: boolean
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
  //
  // REACHABILITY (2026-08-31 audit — read this before deleting anything):
  // these two fields, `core/yi-hub.ts`, `daemon/yi-ws-{server,client}.ts` and
  // the `transport === 'ws'` branch in wiring/pipeline-deps.ts have NO CLI or
  // desktop entry point, and no pairing path ever writes `transport:'ws'`
  // (hand invite/join, /v1/a2a/install and /a2a/pair all write 'push';
  // the 6-digit pairing code writes 'mailbox'). So the ws limb is reachable
  // ONLY by hand-editing agent-config.json — which reads as dead code and has
  // already been proposed for deletion once.
  //
  // It is NOT dead, and deleting it removes a capability nothing else covers:
  // push delegation requires the hand to have a reachable url, so a hand
  // behind NAT can only be driven over a hand-dialled WebSocket. (The mailbox
  // transport solves the same NAT problem for the SOCIAL layer only — it does
  // not carry /a2a/exec.) The real gap is the missing entry point, not the
  // code. Wire one before assuming nobody wants it.
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
  // Sub-project C (中间人转发预算): per-upstream-sender token-bucket budget on
  // how many DISTINCT intents this daemon will forward as intermediary W.
  // Optional/additive, same posture as mailbox_relays?/a2a_listen? — absent
  // means "use resolveForwardBudget's default", not "budget disabled".
  forward_budget?: { per_sender: number; window_ms: number }
  // Stable-unique self slug (spec §2): this daemon's own a2a id, crossed on the
  // pairing card and used as the registry id peers file this daemon under.
  // Additive/optional, same posture as mailbox_relays?/forward_budget?. Resolved
  // (and persisted here on first need) by resolveSelfAgentId in core/self-agent-id.ts.
  self_agent_id?: string
  // Knowledge Kernel Phase 01 (T5) — gates the daemon-owned KnowledgeStore +
  // wxvault source-adapter ingestion off by default (opt-in during the
  // walking-skeleton slice). Mirrors `social_enabled?`'s optional-boolean
  // shape — absent/false → bootstrap skips wiring entirely and
  // /v1/knowledge/* stays 503 (see routes-knowledge.ts).
  knowledge_enabled?: boolean
  // Override for the wxvault-decrypted output dir the source adapter reads
  // from. Optional — defaults to `<stateDir>/plugin-data/wxvault/out/decrypted`
  // when absent. Mirrors `openaiBaseUrl?`'s optional-string shape.
  knowledge_source_dir?: string
  // Knowledge Kernel T7' — embedding model id passed to the in-process
  // indexer (src/core/knowledge/indexer.ts) and, via embed-runner.ts, to the
  // Python embed subprocess (`--model-id`) as the provenance tag every
  // semantic.db row is stamped with. Optional — defaults to
  // 'bge-small-zh-v1.5' (wxsearch's existing default embedding model, see
  // wechat-cc-plugins packages/wxsearch/wxsearch/embed.py's `_FE` map).
  knowledge_embed_model?: string
  // Override for the embed subprocess script path the indexer spawns
  // (normally resolved from the loaded wxsearch plugin's dir — see
  // bootstrap/index.ts's knowledge_enabled block). Optional escape hatch for
  // a non-standard wxsearch install location.
  knowledge_embed_script?: string
  // Which runtime computes embeddings. 'python' (default) spawns wxsearch's
  // embed_subprocess.py; 'js' runs transformers.js in-process, with no venv,
  // no subprocess, and a model that can be warmed directly (see
  // core/knowledge/js-embedder.ts).
  //
  // Still defaulting to 'python' on purpose: the two runtimes produce
  // equivalent vectors (cosine > 0.9999, so an existing semantic.db stays
  // valid either way), but 'js' cannot run inside the packaged desktop
  // sidecar — a `bun build --compile` binary cannot dlopen onnxruntime's
  // native binding. Selecting 'js' there falls back to 'python' rather than
  // failing. Flip the default only once that is solved and the equivalence
  // check runs in CI with a model cache.
  knowledge_embed_runtime?: 'python' | 'js'
  // Knowledge Graph inproc Task 4 — explicit override for "my own username"
  // fed into rebuildGraphFromSource's `detectOwner` call (graph-build.ts).
  // Optional — absent means "let detectOwner vote from 1:1 message senders"
  // (see graph.ts's `detectOwner` doc comment); bootstrap/index.ts falls
  // back further to the `WXGRAPH_OWNER` env var when this is also unset,
  // mirroring wxgraph's own env-var escape hatch for undetectable-owner
  // accounts.
  knowledge_owner?: string
  // 「连续 N 天」这类按天分桶功能用的时区偏移(相对 UTC 的分钟,东为正:
  // UTC+8 → 480,PDT → -420)。缺省/ null → 跟随运行机器的系统时区(自动,
  // 夏令时也对;daemon 在用户机器上,系统时区即用户此刻所在)。手动设值是
  // 「万一用户想自己钉一个时区」的口子。见 core/prompt-format.ts localDayKey。
  day_tz_offset_minutes?: number | null
}

// ── A2A sub-schemas ──────────────────────────────────────────────────────────

export const A2AAgentRecord = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'agent id must match ^[a-z0-9][a-z0-9-]{0,63}$ (lowercase slug)'),
  name: z.string().min(1).max(128),
  url: z.string().url().optional(),
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
  /**
   * 这个对端是不是**我授权可以派活给我**的大脑(brain)。
   *
   * WHY(2026-09-02):`/a2a/exec` 此前只验 bearer —— 任何在 registry 里、
   * bearer 对的对端都能在这台机器上跑一个本地 agent。而 registry 是一张
   * **平的**信任表,里面同时装着两种完全不同的东西:
   *   · 我自己的另一台机器(hand invite / hand join / hand accept —— 两端
   *     都要 CLI 访问权,等价于一次 SSH 密钥交换)
   *   · 朋友的 bot(六位配对码 / /a2a/pair / a2a install —— 社交层)
   * 而 hand 侧给 brain 写的记录 `capabilities: []`,跟社交对端**长得一模
   * 一样**,路由根本分不出来。
   *
   * 于是「非 claude 的 delegate 一律 guest」那道闸其实是在**用能力钳制补
   * 一个缺失的授权检查** —— 而且补错了地方:它卡死了合法用途(我自己的
   * 手连自己机器上的文件都读不了),却没挡住真正的口子(claude 那条路
   * 是 trusted,对任何已配对的对端开放)。
   *
   * 缺省 false ⇒ **fail closed**:现有的每一条记录(社交对端、以及本字段
   * 之前建立的手)都不能派活,要重新 `hand invite` / `hand join` 一次。
   * 这个功能上线至今零使用(零注册手、零 `让X执行`),所以不留兼容后门。
   */
  may_exec: z.boolean().default(false),
}).superRefine((rec, ctx) => {
  // url is optional ONLY for mailbox transport (pure-NAT peers have no public
  // url). push/ws still require a reachable url. spec §6.
  if (rec.transport !== 'mailbox' && !rec.url) {
    ctx.addIssue({ code: 'custom', path: ['url'], message: `url is required for transport '${rec.transport}'` })
  }
})

export const A2AListen = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).max(65535),
})

export const YiHubListen = z.object({ host: z.string(), port: z.number() })
export const YiBrain = z.object({ url: z.string(), handId: z.string(), authToken: z.string().min(16) })

export const ForwardBudgetConfig = z.object({
  per_sender: z.number().int().positive(),
  window_ms: z.number().int().positive(),
})

export type A2AAgentRecord = z.infer<typeof A2AAgentRecord>
export type A2AListen = z.infer<typeof A2AListen>
export type YiHubListen = z.infer<typeof YiHubListen>
export type YiBrain = z.infer<typeof YiBrain>
export type ForwardBudgetConfig = z.infer<typeof ForwardBudgetConfig>

const AgentConfigSchema = z.object({
  provider: z.enum(['claude', 'codex', 'cursor', 'openai', 'gemini']).default('claude'),
  model: z.string().optional(),
  cursorModel: z.string().optional(),
  openaiBaseUrl: z.string().optional(),
  openaiModel: z.string().optional(),
  geminiModel: z.string().optional(),
  agyModel: z.string().optional(),
  agyBin: z.string().optional(),
  cursorAgentBin: z.string().optional(),
  remote_tunnel: z.boolean().optional(),
  remote_relay_url: z.string().optional(),
  cheapEvalProvider: z.string().optional(),
  delegateOpenai: z.boolean().optional(),
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
  forward_budget: ForwardBudgetConfig.optional(),
  self_agent_id: z.string().optional(),
  knowledge_enabled: z.boolean().optional(),
  knowledge_source_dir: z.string().optional(),
  knowledge_embed_model: z.string().optional(),
  knowledge_embed_script: z.string().optional(),
  knowledge_embed_runtime: z.enum(['python', 'js']).optional(),
  knowledge_owner: z.string().optional(),
  day_tz_offset_minutes: z.number().int().min(-720).max(840).nullable().optional(),
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
    const forwardBudget = parsed.forward_budget != null
      ? ForwardBudgetConfig.safeParse(parsed.forward_budget).data
      : undefined

    return {
      provider,
      ...(typeof parsed.model === 'string' ? { model: parsed.model } : {}),
      ...(typeof parsed.cursorModel === 'string' ? { cursorModel: parsed.cursorModel } : {}),
      ...(typeof parsed.openaiBaseUrl === 'string' ? { openaiBaseUrl: parsed.openaiBaseUrl } : {}),
      ...(typeof parsed.openaiModel === 'string' ? { openaiModel: parsed.openaiModel } : {}),
      ...(typeof parsed.geminiModel === 'string' ? { geminiModel: parsed.geminiModel } : {}),
      ...(typeof parsed.agyModel === 'string' ? { agyModel: parsed.agyModel } : {}),
      ...(typeof parsed.agyBin === 'string' ? { agyBin: parsed.agyBin } : {}),
      ...(typeof parsed.cursorAgentBin === 'string' ? { cursorAgentBin: parsed.cursorAgentBin } : {}),
      ...(typeof parsed.remote_tunnel === 'boolean' ? { remote_tunnel: parsed.remote_tunnel } : {}),
      ...(typeof parsed.remote_relay_url === 'string' ? { remote_relay_url: parsed.remote_relay_url } : {}),
      ...(typeof parsed.cheapEvalProvider === 'string' ? { cheapEvalProvider: parsed.cheapEvalProvider } : {}),
      ...(typeof parsed.delegateOpenai === 'boolean' ? { delegateOpenai: parsed.delegateOpenai } : {}),
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
      ...(forwardBudget ? { forward_budget: forwardBudget } : {}),
      ...(typeof parsed.self_agent_id === 'string' ? { self_agent_id: parsed.self_agent_id } : {}),
      ...(typeof parsed.knowledge_enabled === 'boolean' ? { knowledge_enabled: parsed.knowledge_enabled } : {}),
      ...(typeof parsed.knowledge_source_dir === 'string' ? { knowledge_source_dir: parsed.knowledge_source_dir } : {}),
      ...(typeof parsed.knowledge_embed_model === 'string' ? { knowledge_embed_model: parsed.knowledge_embed_model } : {}),
      ...(typeof parsed.knowledge_embed_script === 'string' ? { knowledge_embed_script: parsed.knowledge_embed_script } : {}),
      ...(parsed.knowledge_embed_runtime === 'python' || parsed.knowledge_embed_runtime === 'js' ? { knowledge_embed_runtime: parsed.knowledge_embed_runtime } : {}),
      ...(typeof parsed.knowledge_owner === 'string' ? { knowledge_owner: parsed.knowledge_owner } : {}),
      ...(typeof parsed.day_tz_offset_minutes === 'number' ? { day_tz_offset_minutes: parsed.day_tz_offset_minutes } : {}),
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
  if (providerId === 'agy') return config.agyModel
  return config.provider === providerId ? config.model : undefined
}

/** A copy of `config` with `providerId`'s own model field set — regardless of the global default provider. */
export function withModelForProvider(config: AgentConfig, providerId: string, model: string): AgentConfig {
  if (providerId === 'openai') return { ...config, openaiModel: model }
  if (providerId === 'cursor') return { ...config, cursorModel: model }
  if (providerId === 'gemini') return { ...config, geminiModel: model }
  if (providerId === 'agy') return { ...config, agyModel: model }
  return { ...config, model }
}

/** Sub-project C default: 30 forwards/hour per upstream sender. Applied by
 *  resolveForwardBudget when the operator hasn't set config.forward_budget —
 *  the config field itself stays undefined (additive/optional), this is the
 *  one canonical place the default value lives. */
export const DEFAULT_FORWARD_BUDGET: { per_sender: number; window_ms: number } = { per_sender: 30, window_ms: 3_600_000 }

/** `config.forward_budget` if the operator set one, else {@link DEFAULT_FORWARD_BUDGET}. */
export function resolveForwardBudget(config: AgentConfig): { per_sender: number; window_ms: number } {
  return config.forward_budget ?? DEFAULT_FORWARD_BUDGET
}
