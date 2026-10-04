/**
 * buildBootstrap — 把 daemon 的核心分发图拼起来。**这里只组装**:每一块的构造都在
 * ./wire-*.ts(或同目录的小模块)里,index 按 boot 顺序调用、用解构 / 展开把各块的
 * 产物拼回 `Bootstrap`(./types.ts,键集合与类型是对外契约,别在这里改)。
 *
 * Boot 顺序(即代码顺序;有副作用的几步位置不能动 —— resolveSelfAgentId 会持久化,
 * turnTimeoutMs 要在 registerProviders 之前,socialWired 在 social 之后 set):
 *   wireHealth(无条件、最先)→ wirePlugins(MCP specs + 插件)→ wirePermissions
 *   (busy / resolver / permissionMode / conversationStore / canUseTool)→ claudeBin →
 *   configuredAgent / selfId → wireKnowledge[sup] → wireModelOptions → sessionStore /
 *   turnTimeoutMs → registerProviders(./providers.ts)→ wireInstructions → SessionManager
 *   → access-change 失效 → wireSelfRestart[sup] → idle sweep → wireCoordinator
 *   (fallback 回复 / recordTurn / coordinator)→ buildDelegateDispatch(./delegate.ts)
 *   → wireA2a(registry / client / events / resolveOperatorChatId)→ wireSocial[sup]
 *   → wireA2aServer[sup] → wirePairing[sup] → wireMailboxDeps → wireYi[sup] → return。
 *   [sup] = 经 deps.supervisor.start(name) 拉起:抛错降级、未配置记 off,
 *   /v1/health.subsystems 能看见;同名二次 start 直接 throw。名字序列由
 *   ./boot-order.test.ts 钉住。
 *
 * 三条规矩(spec 2026-09-27-bootstrap-split §3;守卫 scripts/bootstrap-ratchet.guard.test.ts):
 *   1. 新接线进 wire-<x>.ts,index 只加一次调用 + return 里一行;行数只降不升。
 *   2. 晚绑定只用 src/lib/lifecycle.ts 的 Ref(没 wire 就读会抛),不写 `let x | null = null`。
 *   3. 可能失败 / 可能未配置的块一律经 supervisor.start。
 *
 * Imported only by:
 *   - src/daemon/main.ts (production entry)
 *   - src/daemon/bootstrap.test.ts / bootstrap.a2a.test.ts / bootstrap/boot-order.test.ts
 */
import { SessionManager } from '../../core/session-manager'
import type { TierProfile } from '../../core/user-tier'
import type { ProviderId } from '../../core/conversation'
import { formatInbound } from '../../core/prompt-format'
import { findOnPath } from '../../lib/util'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeSessionStore } from '../../core/session-store'
import { loadAgentConfig } from '../../lib/agent-config'
import { setSessionInvalidator } from '../../lib/access'
import { resolveAdminChatId } from '../companion/resolve-admin'
import { buildDelegateDispatch } from './delegate'
import { registerProviders } from './providers'
import { wirePlugins } from './wire-plugins'
import { wireKnowledge } from './wire-knowledge'
import { wirePermissions } from './wire-permissions'
import { wireModelOptions } from './wire-model-options'
import { wireInstructions } from './wire-instructions'
import { wireCoordinator } from './wire-coordinator'
import { wireA2a } from './wire-a2a'
import { wireYi } from './wire-yi'
import { wireMailboxDeps } from './wire-mailbox-deps'
import { Ref } from '../../lib/lifecycle'
import { resolveClaudeBinary, hydrateClaudeAuthEnvFromUserSettings } from './claude-env'
import { wireSocial } from './wire-social'
import { wireA2aServer } from './wire-a2a-server'
import { wirePairing } from './wire-pairing'
import { wireHealth } from './wire-health'
import { wireSelfRestart } from './wire-self-restart'
import { resolveSelfAgentId } from '../../core/self-agent-id'
import type { BootstrapDeps, Bootstrap } from './types'
export type { BootstrapDeps, Bootstrap } from './types'

// buildChannelSystemPrompt() moved to src/core/prompt-builder.ts in
// the RFC 03 review follow-up: the inline string here was v0.x and
// missed delegate_*, share_*, broadcast, set_user_name, send_file,
// edit_message — none of which were in the prompt despite being
// available tools. The prompt-builder also encodes mode-awareness so
// the agent doesn't get confused by chatroom envelopes.

// resolveAdminChatId moved to ../companion/resolve-admin.ts (fix round 1,
// owner-onboarding design §C1 review) so companion/offer-eligibility.ts can
// reuse the SAME owner-resolution rule without importing this whole
// composition-root file. Re-exported here so existing callers (main.ts,
// bootstrap.test.ts) that do `import { resolveAdminChatId } from './bootstrap'`
// keep working unchanged.
export { resolveAdminChatId } from '../companion/resolve-admin'
// wrapCheapEvalWithAuthFailCheck 搬到了 ./wire-coordinator.ts;这里 re-export 给还从 './bootstrap' 导入它的调用方。
export { wrapCheapEvalWithAuthFailCheck } from './wire-coordinator'

export async function buildBootstrap(deps: BootstrapDeps): Promise<Bootstrap> {
  hydrateClaudeAuthEnvFromUserSettings(deps.log)

  // Subsystem degraded-boot (spec 2026-08-17) — the five optional wire
  // blocks below (knowledge/social/a2a-server/pairing/self-restart) start
  // through this supervisor so a startup failure degrades that block to
  // "not configured" instead of aborting the whole daemon boot.
  const sup = deps.supervisor
  // 各 wire-* 共用的上下文(BootstrapCtx);configuredAgent 在下面第 5 步才有,
  // 之前的 wire 用 ctxBase,之后的用 ctx。
  const ctxBase = { sup, log: deps.log, stateDir: deps.stateDir, db: deps.db }

  // Connection-health runtime (Task 7) — constructed FIRST and unconditionally,
  // no config gate, so it exists before anything that could report a failure:
  // main.ts's registerPolling(wired.pollingDeps) starts the long-poll loops
  // strictly after buildBootstrap() resolves, and buildTickBodies' companion
  // ticks are wired the same way. Depends only on stateDir + log, both
  // present from the very first line of BootstrapDeps.
  const health = wireHealth({ stateDir: deps.stateDir, log: deps.log })

  // busy / resolver / permissionMode / conversationStore / canUseTool — ./wire-permissions.ts(2026-09-27 拆分)。
  const { busyRegistry, resolve, permissionMode, conversationStore, buildCanUseTool } = wirePermissions(deps, ctxBase)

  const claudeBin = resolveClaudeBinary()
  if (!claudeBin) {
    deps.log('BOOT', 'WARNING: no Claude Code binary found — install Claude Code (`claude`) or set CLAUDE_CODE_EXECUTABLE')
  } else {
    deps.log('BOOT', `claude binary: ${claudeBin}`)
  }

  // MCP specs + plugin lane — ./wire-plugins.ts(2026-09-27 拆分)。
  const {
    wechatStdioForClaude, wechatStdioForCodex, wechatStdioForCursor, wechatStdioForOpenai, wechatStdioForGemini, wechatStdioForAgy,
    delegateStdioByProvider, delegateStdioForClaude, delegateStdioForCodex, delegateStdioForCursor, delegateStdioForOpenai,
    loadedPlugins, pluginMcp, knowledgePluginNames, pluginMcpForClaude, pluginsHealth,
  } = wirePlugins(deps, ctxBase)

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

  // spec §2 (pairing-code design) — one stable-unique slug per daemon,
  // resolved EXACTLY ONCE here and threaded into every wiring seam that
  // self-reports an agent_id to a peer: wireSocial (outbound a2a_id),
  // wirePairing (own-card self_id), and pipeline-deps' exec/hands delegate
  // path (delegateToHand). resolveSelfAgentId persists on its
  // generate/grandfather branch (read-modify-write of agent-config.json) —
  // calling it more than once per boot (let alone lazily, per request) would
  // re-enter that persistence for no benefit and risks two wiring seams
  // momentarily disagreeing on this daemon's own identity.
  const selfId = resolveSelfAgentId(configuredAgent, deps.stateDir)

  // Knowledge Kernel — ./wire-knowledge.ts(2026-09-27 拆分);经 sup.start('knowledge')。
  const ctx = { ...ctxBase, configuredAgent }
  const knowledge: Bootstrap['knowledge'] = await wireKnowledge(ctx, loadedPlugins)

  // 模型热读 + Claude SDK Options — ./wire-model-options.ts(2026-09-27 拆分)。
  const { readAgentConfig, currentClaudeModel, currentModelFor, sdkOptionsForProject } = wireModelOptions(ctxBase, { plugins: { wechatStdioForClaude, delegateStdioForClaude, pluginMcpForClaude }, permissionMode, buildCanUseTool, claudeBin })

  // Persistent session_id map — enables `resume` after daemon restart.
  // Each provider stores its session/thread jsonl in a different place; we
  // probe the right one before trying to resume (avoids hard error if the
  // SDK rotated or user cleared history). See ./session-paths.ts.
  const sessionStore = makeSessionStore(deps.db, { migrateFromFile: join(deps.stateDir, 'sessions.json') })

  // Per-turn watchdog: the daemon-level bound that guarantees a silently-
  // stalled SDK subprocess (idle timeout, wedge, hung MCP tool) can never
  // wedge the pipeline forever. Defaults to 10 min — generous enough for a
  // legit long turn (memory reads, MCP tools, deep thinking) yet finite, so
  // the coordinator always reclaims the session and the next message is
  // served. Override via WECHAT_TURN_TIMEOUT_MS (0 disables — not advised).
  // Resolved here (moved ahead of registerProviders in the agy-provider
  // task) so the agy provider's `--print-timeout` can share this exact
  // value at registration time, same as the coordinator does below.
  const turnTimeoutMs = (() => {
    const raw = process.env['WECHAT_TURN_TIMEOUT_MS']
    if (raw == null || raw === '') return 10 * 60_000
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? n : 10 * 60_000
  })()

  const { registry, defaultProviderId, codexBinary, codexVersionCheck, providerNotes: baseProviderNotes, providerProbes, stopProviderProbes } = await registerProviders({
    log: deps.log, networkGate: deps.networkGate,
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
    wechatStdioForAgy,
    turnTimeoutMs,
    mintSessionToken: deps.mintSessionToken,
    agyGeminiConfigDir: deps.agyGeminiConfigDir,
  })

  // 系统提示组装 — ./wire-instructions.ts(2026-09-27 拆分)。socialWired 在下面 social 接线完成后 set。
  const socialWired = new Ref<boolean>('socialWired')
  const buildInstructions = wireInstructions(deps, { plugins: { delegateStdioByProvider, knowledgePluginNames }, defaultProviderId, knowledge, socialWired })

  const sessionManager = new SessionManager({
    maxConcurrent: 6,
    idleEvictMs: 30 * 60_000,
    registry, networkGate: deps.networkGate,
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

  // self-restart (spec 2026-08-03-daemon-self-restart-on-stale-code) —
  // assembly extracted to ./wire-self-restart.ts (Task 6). Entirely inert
  // when deps.requestRestart is omitted: wireSelfRestart returns null, so
  // no HEAD read, no activity marker built, no check added to the
  // idle-sweep tick below — tests and minimal embeddings that don't wire
  // requestRestart stay byte-identical to before this feature existed.
  //
  // lastPollSuccessAgoMs (spec 2026-08-11 §4) — real signal, sourced from
  // the SAME health runtime constructed above (poll-loop.ts's
  // health.onSuccess('wechat') call is what stamps lastSuccessAt). health
  // can't get() fail in practice (makeConnectionHealth lazily seeds any
  // never-seen dependency), but the try/catch + null-on-failure keeps this
  // on the "can't prove it's fresh ⇒ don't restart" side the rest of the
  // mechanism commits to everywhere else.
  const wiredSelfRestart = (await sup.start('self-restart', () => wireSelfRestart({
    requestRestart: deps.requestRestart,
    anyInFlight: () => sessionManager.anyInFlight(),
    busy: () => busyRegistry.busy(),
    lastPollSuccessAgoMs: (nowMs) => {
      try {
        const at = health?.health.get('wechat').lastSuccessAt ?? null
        return at === null ? null : nowMs - at
      } catch { return null }
    },
    log: deps.log,
  }))) ?? null
  const selfRestartCheck = wiredSelfRestart?.check ?? null
  const selfRestartActivityMarker = wiredSelfRestart?.marker ?? null

  // Periodic idle sweep — without this, idleEvictMs is dead config (the
  // method exists but was never called from production paths). 30 min of
  // inactivity is the limit before a session is dropped; the next dispatch
  // spawns a fresh subprocess that re-reads keychain credentials. Required
  // to avoid the long-running-daemon OAuth-staleness path that surfaces as
  // the claude binary streaming "Not logged in · Please run /login" as
  // assistant text. unref() so the timer never keeps the event loop alive
  // (matters for tests that build a real bootstrap and then exit).
  //
  // selfRestartCheck rides this SAME 60s tick (no new timer) — see the
  // self-restart block above. It swallows its own errors, so no .catch here.
  const idleSweepTimer = setInterval(() => {
    sessionManager.sweepIdle().catch(err => {
      deps.log('IDLE_SWEEP', `error: ${err instanceof Error ? err.message : String(err)}`)
    })
    void selfRestartCheck?.()
  }, 60_000)
  idleSweepTimer.unref()

  // fallback 回复 / recordTurn / coordinator — ./wire-coordinator.ts(2026-09-27 拆分)。
  const { anomalyNotes, sendAssistantText, coordinator } = wireCoordinator(deps, ctxBase, { health, resolve, sessionManager, conversationStore, registry, defaultProviderId, readAgentConfig, permissionMode, turnTimeoutMs })

  // RFC 03 P4 — bare delegate providers + one-shot dispatcher.
  // See ./delegate.ts for why these are constructed separately from the
  // registry's main providers (no mcpServers — recursion prevention).
  const dispatchDelegate = buildDelegateDispatch({
    stateDir: deps.stateDir, networkGate: deps.networkGate,
    log: deps.log,
    ...(claudeBin ? { claudeBin } : {}),
    // 没有 claude 二进制就别把 claude 放进 delegate 名单 —— 与 codex/openai
    // 同一个姿态。上面那条 WARNING 之前只是说说,名单照旧列着它。
    claudeAvailable: !!claudeBin,
    // 版本不同不再拦(见 providers.ts 的 2026-09-09 定案);只有 --version 都打不出来才不给。
    ...(codexBinary && codexVersionCheck && codexVersionCheck.reason !== 'version_probe_failed' ? { codexPathOverride: codexBinary } : {}),
    // busy-registry hold (spec 2026-08-11 §2, Task 4 step 3 + Task 6) —
    // a delegate dispatch is a one-shot session outside SessionManager.
    holdBusy: busyRegistry.hold,
    // 同上:one-shot delegate 失败也采一笔。
    onProviderFailure: (info) => {
      void import('../diagnostics/failure-shapes').then(m => m.recordFailureShape(deps.stateDir, info))
    },
  })

  // A2A registry / client / events + resolveOperatorChatId — ./wire-a2a.ts(2026-09-27 拆分)。
  const { a2aRegistry, a2aClient, a2aEventsStore, resolveOperatorChatId } = wireA2a(ctxBase)

  // 降级兜底:social 抛错时的 inert wiring — 与 wireSocial 未配置时的内部
  // 状态同形(全 handler undefined),下游 a2a/mailbox/return 的门原样生效。
  const inertSocialWiring: import('./wire-social').SocialWiring = {
    onLetter: undefined,
  }
  const socialWiring = (await sup.start('social', async () => {
    const w = await wireSocial({
      log: deps.log,
      stateDir: deps.stateDir,
      sendFile: deps.ilink.sendFile ? (c, p) => deps.ilink.sendFile!(c, p) : undefined,
      db: deps.db,
      configuredAgent,
      selfId,
      registry,
      defaultProviderId,
      resolveOperatorChatId,
      sendAssistantText,
      a2aRegistry,
      a2aClient,
      knowledge,
      // 串门 / 答心愿是脱离会话的后台模型活 —— 登记进 busy,空闲自动重启
      // 才不会掐在半程(和 delegate 的 'a2a-delegate' 同一个理由)。
      holdBusy: busyRegistry.hold,
    })
    // 未配置 / 无 cheapEval ⇒ wireSocial 返回 inert 对象(social 字段缺席)
    // ⇒ 映射为 null ⇒ supervisor 记 off。
    return w.social ? w : null
  })) ?? inertSocialWiring
  socialWired.set(!!socialWiring.social)

  const a2aWiring = await sup.start('a2a-server', () => wireA2aServer({
    log: deps.log,
    stateDir: deps.stateDir,
    configuredAgent,
    a2aRegistry,
    a2aClient,
    a2aEventsStore,
    dispatchDelegate,
    resolveOperatorChatId,
    sendAssistantText,
    onLetter: socialWiring.onLetter,
  }))
  const a2aDeps = a2aWiring?.a2aDeps
  const a2aServer = a2aWiring?.a2aServer ?? null

  // 配对码 (pairing-code design §7) — the daemon-side pairing engine. Gated
  // ONLY on mailbox_relays (rendezvous needs a relay); independent of
  // social_enabled — a daemon can pair without social being on. `selfId` is
  // the SAME constant resolved once above; `url` advertises this daemon's
  // own a2a_listen base (undefined ⇒ a pure NAT'd, url-less mailbox peer).
  // Undefined when mailbox_relays is unconfigured — the WeChat「配对」dispatch
  // seam and internal-api /v1/pair/* routes then stay inert, same posture
  // as boot.social/boot.penpal.
  const pairingEngine = await sup.start('pairing', () => wirePairing({
    stateDir: deps.stateDir,
    configuredAgent,
    a2aRegistry,
    db: deps.db,
    selfId,
    url: a2aServer ? a2aServer.baseUrl() : undefined,
    notify: (msg) => { const op = resolveOperatorChatId(); if (op && sendAssistantText) void sendAssistantText(op, msg) },
    log: deps.log,
  }))

  // mailbox 轮询器 deps — ./wire-mailbox-deps.ts(2026-09-27 拆分)。
  const mailboxPollerDeps = wireMailboxDeps(ctx, { a2aRegistry, onMailboxLetter: socialWiring.onMailboxLetter, readAgentConfig })

  // 乙 v2 — ./wire-yi.ts(2026-09-27 拆分);经 sup.start('yi')。
  const yiHub = await wireYi(ctx, { a2aRegistry, dispatchDelegate })

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
    defaultProviderId, pluginsHealth, providerProbes, stopProviderProbes,
    codeHead: wiredSelfRestart?.loadedHead ?? null,
    providerNotes: () => {
      const out: Partial<Record<ProviderId, string>> = { ...baseProviderNotes() }
      for (const [id, note] of anomalyNotes) out[id] = out[id] ? `${out[id]} · ⚠️ ${note}` : `⚠️ ${note}`
      return out
    },
    agentProviderKind: defaultProviderId,
    /**
     * RFC 03 P4 — late-bound into internal-api by main.ts after
     * buildBootstrap returns. The route is 503 until that wiring lands.
     */
    dispatchDelegate,
    ...(a2aDeps ? { a2aDeps } : {}),
    a2aServer,
    yiHub,
    agentConfig: configuredAgent,
    sendAssistantText,
    /**
     * spec §2 (pairing-code design) — this daemon's stable-unique self slug,
     * resolved once above. Shared by wireSocial + wirePairing + (via this
     * field) pipeline-deps' exec/hands delegate path — see the doc comment
     * on Bootstrap['selfId'] in ./types.ts.
     */
    selfId,
    /**
     * 社交面(笔友信道 + 心愿)— late-bound into internal-api by main.ts
     * (mirrors a2aDeps/setA2A). Undefined when social_enabled +
     * social_disclosure_policy aren't both configured — POST
     * /v1/social/wish then 503s.
     */
    ...(socialWiring.social ? { social: socialWiring.social } : {}),
    /**
     * Anonymous pen-pal channel (Task 8/10/11) — the "回信 <channel> <text>"
     * dispatch seam in pipeline-deps.ts reads this directly (not
     * boot.social.penpal). Undefined whenever social wiring is inert, same
     * gate as boot.social.
     */
    ...(socialWiring.social ? { penpal: socialWiring.social.penpal } : {}),
    /**
     * Content-blind mailbox transport (Task 8) — present only when
     * social_enabled + at least one mailbox_relays entry are configured.
     * main.ts mounts the poller lifecycle iff this is set.
     */
    ...(mailboxPollerDeps ? { mailboxPollerDeps } : {}),
    /**
     * 配对码 (spec §7) — undefined when mailbox_relays isn't configured;
     * see Bootstrap['pairing']'s doc comment in ./types.ts.
     */
    ...(pairingEngine ? { pairing: pairingEngine } : {}),
    /**
     * Knowledge Kernel (Phase 01, T5) — undefined when `knowledge_enabled`
     * is not configured; see Bootstrap['knowledge']'s doc comment in
     * ./types.ts.
     */
    ...(knowledge ? { knowledge } : {}),
    /**
     * Connection-health runtime (Task 7) — see ./wire-health.ts and the
     * doc comment on Bootstrap['health'] in ./types.ts.
     */
    health,
    /**
     * busy-registry hold (spec 2026-08-11 §2) — see Bootstrap['holdBusy']'s
     * doc comment in ./types.ts. Always present (busyRegistry is
     * constructed unconditionally above, independent of whether
     * self-restart itself is enabled).
     */
    holdBusy: busyRegistry.hold,
    /** busy-registry label 快照(spec 2026-09-03-companion-presence)。 */
    busyLabels: busyRegistry.labels,
    /**
     * self-restart (spec 2026-08-03-daemon-self-restart-on-stale-code) —
     * undefined when deps.requestRestart wasn't provided (mechanism fully
     * inert); see Bootstrap['markInboundActivity']'s doc comment in
     * ./types.ts. main.ts's wireMain wires `.mark` into mw-messages'
     * markInboundActivity via pipeline-deps' `messages` dep.
     */
    ...(selfRestartActivityMarker ? { markInboundActivity: selfRestartActivityMarker.mark } : {}),
  }
}
