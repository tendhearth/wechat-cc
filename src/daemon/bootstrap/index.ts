/**
 * bootstrap —— 把 daemon 的核心分发图拼起来(架构终态 A2:**一组模块**,进 main 的同一个容器)。
 * 每一块的构造仍在 ./wire-*.ts(或同目录的小模块)里;这里只说「谁要谁」,产物最后在 `bootstrap` 那个模块里
 * 拼回 `Bootstrap`(./types.ts,键集合与类型是对外契约,别在这里改)。
 *
 * 模块(表的顺序 = 开机顺序,关机倒过来):
 *   boot-base   健康运行时 → 权限 / busy → claude 二进制 → MCP specs + 插件 → 配置快照 → self_agent_id(只解析一次,会持久化)
 *   knowledge   [可选] 知识库(knowledge_enabled)
 *   boot-core   模型热读 → 会话存档 → registerProviders → 系统提示 → SessionManager → access 变更失效 → 协调器 →
 *               一次性 delegate → A2A registry / client / events
 *   self-restart[可选] 空闲加载新代码(只在有 supervisor 拉起我们的地方)
 *   idle-sweep  每分钟:空闲会话清扫 + 自重启检查
 *   social      [可选] 社交(social_enabled)    mailbox-poller [可选] 笔友信箱(needs social)
 *   a2a-server  [可选]    pairing [可选](mailbox_relays)    yi [可选]
 *   bootstrap   拼回 Bootstrap(别的模块 needs 的就是它)
 * 可选的那几个:没配置 ⇒ off;起失败 ⇒ degraded,boot 继续;/v1/health.subsystems 看得见。顺序由 ./boot-order.test.ts 钉住。
 *
 * Imported by:
 *   - src/daemon/bootstrap/module.ts (production: `bootstrapGroupModules(f)`, listed in daemon-modules.ts)
 *   - src/daemon/bootstrap.test.ts / bootstrap.a2a.test.ts / bootstrap/boot-order.test.ts(经 buildBootstrap:起一个只有这一组的容器)
 */
import { turnTimeoutMsFromEnv } from '../../lib/turn-timeout'
import { idleSweepModule } from './wire-idle-sweep'
import { SessionManager } from '../../app/session-manager'
import type { ProviderId } from '../../domain/conversation'
import { formatInbound } from '../../domain/prompt-format'
import { join } from 'node:path'
import { makeSessionStore } from '../../adapters/store/session-store'
import { loadAgentConfig } from '../../lib/agent-config'
import { setSessionInvalidator } from '../../lib/access'
import { resolveAdminChatId } from '../companion/resolve-admin'
import { buildDelegateDispatch } from './delegate'
import { registerProviders } from './providers'
import { wirePlugins } from './wire-plugins'
import { knowledgeModule } from './wire-knowledge'
import { wirePermissions } from './wire-permissions'
import { wireModelOptions } from './wire-model-options'
import { wireInstructions } from './wire-instructions'
import { wireCoordinator } from './wire-coordinator'
import { wireA2a } from './wire-a2a'
import { yiModule } from './wire-yi'
import { resolveClaudeBinary, hydrateClaudeAuthEnvFromUserSettings } from './claude-env'
import { socialFeature, INERT_SOCIAL, type SocialWiring } from '../../features/social'
import { a2aServerModule, type A2aServerWiring } from './wire-a2a-server'
import { pairingModule } from './wire-pairing'
import { wireHealth } from './wire-health'
import { selfRestartModule } from './self-restart-module'
import type { WireSelfRestartResult } from './wire-self-restart'
import type { YiHub } from '../../app/yi-hub'
type PairingEngine = NonNullable<Bootstrap['pairing']>
import { resolveSelfAgentId } from '../../adapters/mailbox/self-agent-id'
import type { InternalApi } from '../internal-api/types'
import { createModules, type DaemonModule, type ModuleCtx } from '../modules/container'
import { liftModule } from '../modules/lift'
import type { SubsystemSupervisor } from '../subsystems'
import type { BootstrapDeps, Bootstrap } from './types'
export type { BootstrapDeps, Bootstrap } from './types'

// buildChannelSystemPrompt() moved to src/domain/prompt-builder.ts in
// the RFC 03 review follow-up: the inline string here was v0.x and
// missed delegate_*, share_*, broadcast, set_user_name, send_file,
// edit_message — none of which were in the prompt despite being
// available tools. The prompt-builder also encodes mode-awareness so
// the agent doesn't get confused by chatroom envelopes.

// resolveAdminChatId moved to ../companion/resolve-admin.ts (fix round 1,
// owner-onboarding design §C1 review) so companion/offer-eligibility.ts can
// reuse the SAME owner-resolution rule without importing this whole
// composition-root file. Re-exported here so existing callers that do
// `import { resolveAdminChatId } from './bootstrap'` keep working unchanged.
export { resolveAdminChatId } from '../companion/resolve-admin'
// wrapCheapEvalWithAuthFailCheck 搬到了 ./wire-coordinator.ts;这里 re-export 给还从 './bootstrap' 导入它的调用方。
export { wrapCheapEvalWithAuthFailCheck } from './wire-coordinator'

/** boot-base 交出去的:后面几块都要的那些(含这一轮的 deps 本身)。 */
function bootBase(deps: BootstrapDeps) {
  hydrateClaudeAuthEnvFromUserSettings(deps.log)
  // 各 wire-* 共用的上下文(BootstrapCtx);configuredAgent 在下面才有,之前的 wire 用 ctxBase,之后的用 ctx。
  const ctxBase = { log: deps.log, stateDir: deps.stateDir, db: deps.db }
  // Connection-health runtime (Task 7) — constructed FIRST and unconditionally, no config gate, so it
  // exists before anything that could report a failure (the long-poll loops start strictly after).
  const health = wireHealth({ stateDir: deps.stateDir, log: deps.log })
  // busy / resolver / permissionMode / conversationStore / canUseTool — ./wire-permissions.ts。
  const permissions = wirePermissions(deps, ctxBase)
  const claudeBin = resolveClaudeBinary()
  if (!claudeBin) deps.log('BOOT', 'WARNING: no Claude Code binary found — install Claude Code (`claude`) or set CLAUDE_CODE_EXECUTABLE')
  else deps.log('BOOT', `claude binary: ${claudeBin}`)
  // MCP specs + plugin lane — ./wire-plugins.ts。
  const plugins = wirePlugins(deps, ctxBase)
  // Pin a Claude model from agent-config.json (or fall back to a stable full ID). Without this, the
  // spawned Claude Code subprocess inherits whatever `~/.claude/.claude.json` says — 2026-05-08 incident:
  // fast-mode `opus[1m]` mis-parsed under SDK mode → 404 on every inbound. `configuredAgent` is the boot
  // snapshot used for codex/cursor construction + startup logging, and every optional module's switch.
  const configuredAgent = loadAgentConfig(deps.stateDir)
  // spec §2 (pairing-code design) — one stable-unique slug per daemon, resolved EXACTLY ONCE here and
  // threaded into every seam that self-reports an agent_id to a peer (social, pairing, pipeline-deps'
  // delegate path). resolveSelfAgentId persists on its generate/grandfather branch — never call it twice.
  const selfId = resolveSelfAgentId(configuredAgent, deps.stateDir, {
    // 配置文件读不出来 ⇒ 拒写(lib/json-file):这次不落盘,照常开机,记一行(3e,2026-10-22)。
    onPersistError: err => deps.log('BOOT', `self_agent_id 没能写进 agent-config.json:${err instanceof Error ? err.message : String(err)}`),
  })
  return { deps, ctxBase, ctx: { ...ctxBase, configuredAgent }, health, ...permissions, claudeBin, ...plugins, configuredAgent, selfId }
}
type BootBase = ReturnType<typeof bootBase>

async function bootCore(b: BootBase, parts: { knowledge: Bootstrap['knowledge']; socialWired: () => boolean }) {
  const { deps, ctxBase } = b
  // 模型热读 + Claude SDK Options — ./wire-model-options.ts。
  const { readAgentConfig, currentClaudeModel, currentModelFor, sdkOptionsForProject } = wireModelOptions(ctxBase, { plugins: { wechatStdioForClaude: b.wechatStdioForClaude, delegateStdioForClaude: b.delegateStdioForClaude, pluginMcpForClaude: b.pluginMcpForClaude }, permissionMode: b.permissionMode, buildCanUseTool: b.buildCanUseTool, claudeBin: b.claudeBin })
  // Persistent session_id map — enables `resume` after daemon restart (./session-paths.ts probes the right jsonl).
  const sessionStore = makeSessionStore(deps.db, { migrateFromFile: join(deps.stateDir, 'sessions.json') })
  // Per-turn watchdog (default 10 min, WECHAT_TURN_TIMEOUT_MS; 0 disables). Resolved before
  // registerProviders so agy's `--print-timeout` shares this exact value, same as the coordinator below.
  const turnTimeoutMs = turnTimeoutMsFromEnv(process.env)
  const { registry, defaultProviderId, codexBinary, codexVersionCheck, providerNotes: baseProviderNotes, providerProbes, stopProviderProbes, reprobeProvider } = await registerProviders({
    log: deps.log, networkGate: deps.networkGate,
    stateDir: deps.stateDir,
    db: deps.db,
    ilink: deps.ilink,
    agentProviderKind: deps.agentProviderKind,
    configuredAgent: b.configuredAgent,
    permissionMode: b.permissionMode,
    conversationStore: b.conversationStore,
    sdkOptionsForProject,
    claudeBin: b.claudeBin,
    currentClaudeModel,
    resolveAdminChatId,
    pluginMcp: b.pluginMcp,
    wechatStdioForCodex: b.wechatStdioForCodex,
    delegateStdioForCodex: b.delegateStdioForCodex,
    wechatStdioForCursor: b.wechatStdioForCursor,
    delegateStdioForCursor: b.delegateStdioForCursor,
    wechatStdioForOpenai: b.wechatStdioForOpenai,
    delegateStdioForOpenai: b.delegateStdioForOpenai,
    wechatStdioForGemini: b.wechatStdioForGemini,
    wechatStdioForAgy: b.wechatStdioForAgy,
    turnTimeoutMs,
    ...(deps.chatOwnerRules ? { chatOwnerRules: deps.chatOwnerRules } : {}),
    mintSessionToken: deps.mintSessionToken,
    agyGeminiConfigDir: deps.agyGeminiConfigDir,
  })
  // 系统提示组装 — ./wire-instructions.ts。社交在不在:每次起会话时现问(social 模块在后面)。
  const buildInstructions = wireInstructions(deps, { plugins: { delegateStdioByProvider: b.delegateStdioByProvider, knowledgePluginNames: b.knowledgePluginNames }, defaultProviderId, knowledge: parts.knowledge, socialWired: parts.socialWired })
  const sessionManager = new SessionManager({
    maxConcurrent: 6,
    idleEvictMs: 30 * 60_000,
    registry, networkGate: deps.networkGate,
    ...(deps.executionGuard ? { executionGuard: deps.executionGuard } : {}),
    sessionStore,
    resumeTTLMs: 7 * 24 * 60 * 60_000,
    // Per-session auth token lifecycle — minted once per spawn, revoked on every release/eviction.
    mintSessionToken: deps.mintSessionToken,
    invalidateSessionToken: deps.invalidateSession,
    buildInstructions,
    currentModelFor,
  })
  // Task 14 — when admins / trusted / allowFrom membership changes in access.json, shut down all live
  // sessions so the next acquire respawns under the new tier. Errors are logged but swallowed.
  setSessionInvalidator(() => {
    deps.log('ACCESS', 'tier membership changed — invalidating all live sessions')
    void sessionManager.shutdown().catch(err => {
      deps.log('ACCESS', `invalidate shutdown error: ${err instanceof Error ? err.message : String(err)}`)
    })
  })
  // fallback 回复 / recordTurn / coordinator — ./wire-coordinator.ts。
  const { anomalyNotes, sendAssistantText, coordinator } = wireCoordinator(deps, ctxBase, { health: b.health, resolve: b.resolve, sessionManager, conversationStore: b.conversationStore, registry, defaultProviderId, readAgentConfig, permissionMode: b.permissionMode, turnTimeoutMs })
  // RFC 03 P4 — bare delegate providers + one-shot dispatcher (./delegate.ts: no mcpServers — recursion prevention).
  const dispatchDelegate = buildDelegateDispatch({
    stateDir: deps.stateDir, networkGate: deps.networkGate,
    log: deps.log,
    ...(b.claudeBin ? { claudeBin: b.claudeBin } : {}),
    // 没有 claude 二进制就别把 claude 放进 delegate 名单 —— 与 codex/openai 同一个姿态。
    claudeAvailable: !!b.claudeBin,
    // 版本不同不再拦(见 providers.ts 的 2026-09-09 定案);只有 --version 都打不出来才不给。
    ...(codexBinary && codexVersionCheck && codexVersionCheck.reason !== 'version_probe_failed' ? { codexPathOverride: codexBinary } : {}),
    // busy-registry hold — a delegate dispatch is a one-shot session outside SessionManager.
    holdBusy: b.busyRegistry.hold,
    // 同上:one-shot delegate 失败也采一笔。
    onProviderFailure: (info) => {
      void import('../diagnostics/failure-shapes').then(m => m.recordFailureShape(deps.stateDir, info))
    },
  })
  // A2A registry / client / events + resolveOperatorChatId — ./wire-a2a.ts。
  const a2a = wireA2a(ctxBase)
  return { readAgentConfig, sdkOptionsForProject, sessionStore, registry, defaultProviderId, baseProviderNotes, providerProbes, stopProviderProbes, reprobeProvider, buildInstructions, currentModelFor, sessionManager, anomalyNotes, sendAssistantText, coordinator, dispatchDelegate, ...a2a }
}
type BootCore = Awaited<ReturnType<typeof bootCore>>

/**
 * bootstrap 这一组模块。`deps` 在 boot-base 的 init 里才算(它要的东西来自外面的模块:internal-api 的地址、
 * ilink、CC 开口那道门 ……),所以给的是一个函数;`outer` 是它算 deps 要用到的外面模块(needs / lazy)。
 */
export function bootstrapModules(outer: { needs?: readonly string[]; lazy?: readonly string[]; deps: (ctx: ModuleCtx) => BootstrapDeps }): DaemonModule[] {
  const base = (c: { get<T>(n: string): T }) => c.get<BootBase>('boot-base')
  const core = (c: { get<T>(n: string): T }) => c.get<BootCore>('boot-core')
  // 生产里(bootstrap/module.ts)外面这一层 needs internal-api;只有这一组的测试容器(buildBootstrap)里没有。
  const hasApi = outer.needs?.includes('internal-api') ?? false
  return [
    {
      name: 'boot-base',
      ...(outer.needs ? { needs: outer.needs } : {}),
      ...(outer.lazy ? { lazy: outer.lazy } : {}),
      init: (ctx): BootBase => bootBase(outer.deps(ctx)),
    } satisfies DaemonModule<BootBase>,
    // Knowledge Kernel — ./wire-knowledge.ts;knowledge_enabled 没开 ⇒ off。
    liftModule({ name: 'knowledge', needs: ['boot-base'] }, (up) => {
      const b = base(up)
      if (!b.configuredAgent.knowledge_enabled) b.deps.log('BOOT', 'knowledge: disabled (knowledge_enabled not set)')
      return knowledgeModule(b.ctx, b.loadedPlugins)
    }),
    {
      name: 'boot-core',
      needs: ['boot-base'],
      wants: ['knowledge'],
      lazy: ['social'],
      init: (ctx): Promise<BootCore> => {
        const social = ctx.late<SocialWiring>('social')
        return bootCore(base(ctx), {
          knowledge: ctx.maybe<NonNullable<Bootstrap['knowledge']>>('knowledge') ?? undefined,
          socialWired: () => !!social()?.social,
        })
      },
    } satisfies DaemonModule<BootCore>,
    // self-restart (spec 2026-08-03) — ./wire-self-restart.ts. Entirely inert when deps.requestRestart is
    // omitted (tests / minimal embeddings). lastPollSuccessAgoMs (spec 2026-08-11 §4) comes from the SAME
    // health runtime the poll loop stamps; can't prove it's fresh ⇒ null ⇒ don't restart.
    liftModule({ name: 'self-restart', needs: ['boot-base', 'boot-core'] }, (up) => {
      const b = base(up), c = core(up)
      return selfRestartModule({
        requestRestart: b.deps.requestRestart,
        anyInFlight: () => c.sessionManager.anyInFlight(),
        busy: () => b.busyRegistry.busy(),
        lastPollSuccessAgoMs: (nowMs) => {
          try {
            const at = b.health?.health.get('wechat').lastSuccessAt ?? null
            return at === null ? null : nowMs - at
          } catch { return null }
        },
        log: b.deps.log,
      })
    }),
    // 每分钟一拍:空闲会话清扫 + 自重启检查 —— ./wire-idle-sweep.ts。
    idleSweepModule({ needs: ['boot-base', 'boot-core'], wants: ['self-restart'] }, (c) => ({
      sessionManager: core(c).sessionManager,
      selfRestartCheck: () => c.maybe<WireSelfRestartResult>('self-restart')?.check ?? null,
      log: base(c).deps.log,
    })),
    // 社交 + 笔友信箱轮询:一个功能一个目录(src/features/social);开关就是 social_enabled;关着 / 坏了 ⇒ 下游看到 INERT_SOCIAL。
    // 路由自己挂(要 internal-api:生产里外面这一层 needs 它;只有这一组的测试容器里没有 ⇒ 不挂)。
    // 信箱里给对端叫名字经 A2A 服务那一侧(a2a-server wants social ⇒ 这一条是环边,经 late 现取;它没起就叫 id,跟以前一样)。
    ...socialFeature({
      needs: ['boot-base', 'boot-core', ...(hasApi ? ['internal-api'] : [])],
      wants: ['knowledge'],
      lazy: ['a2a-server'],
      deps: (up) => {
        const b = base(up), c = core(up)
        return {
          log: b.deps.log, ...(b.deps.speech ? { speech: b.deps.speech } : {}),
          stateDir: b.deps.stateDir,
          sendFile: b.deps.ilink.sendFile ? (chat, p) => b.deps.ilink.sendFile!(chat, p) : undefined,
          db: b.deps.db,
          configuredAgent: b.configuredAgent,
          selfId: b.selfId,
          registry: c.registry,
          defaultProviderId: c.defaultProviderId,
          resolveOperatorChatId: c.resolveOperatorChatId,
          sendAssistantText: c.sendAssistantText,
          a2aRegistry: c.a2aRegistry,
          a2aClient: c.a2aClient,
          knowledge: up.maybe<NonNullable<Bootstrap['knowledge']>>('knowledge') ?? undefined,
          // 串门 / 答心愿是脱离会话的后台模型活 —— 登记进 busy,空闲自动重启才不会掐在半程。
          holdBusy: b.busyRegistry.hold,
        }
      },
      ...(hasApi ? {
        api: (ctx: ModuleCtx) => {
          const internalApi = ctx.get<Pick<InternalApi, 'mount' | 'provide'>>('internal-api')
          const a2a = ctx.late<A2aServerWiring>('a2a-server')
          return { mount: internalApi.mount, provide: internalApi.provide, peerName: (id: string) => a2a()?.a2aDeps?.registry.get(id)?.name }
        },
      } : {}),
      mailbox: {
        needs: ['boot-base', 'boot-core'],
        deps: (up) => [base(up).ctx, { a2aRegistry: core(up).a2aRegistry, readAgentConfig: core(up).readAgentConfig }],
      },
    }),
    liftModule({ name: 'a2a-server', needs: ['boot-base', 'boot-core'], wants: ['social'] }, (up) => {
      const b = base(up), c = core(up)
      return a2aServerModule({
        log: b.deps.log,
        stateDir: b.deps.stateDir,
        configuredAgent: b.configuredAgent,
        a2aRegistry: c.a2aRegistry,
        a2aClient: c.a2aClient,
        a2aEventsStore: c.a2aEventsStore,
        dispatchDelegate: c.dispatchDelegate,
        resolveOperatorChatId: c.resolveOperatorChatId,
        sendAssistantText: c.sendAssistantText, ...(b.deps.speech ? { speech: b.deps.speech } : {}),
        onLetter: (up.maybe<SocialWiring>('social') ?? INERT_SOCIAL).onLetter,
      })
    }),
    // 配对码 (pairing-code design §7) — gated ONLY on mailbox_relays (rendezvous needs a relay); independent
    // of social_enabled. `url` advertises this daemon's own a2a_listen base (undefined ⇒ url-less mailbox peer).
    liftModule({ name: 'pairing', needs: ['boot-base', 'boot-core'], wants: ['a2a-server'] }, (up) => {
      const b = base(up), c = core(up)
      const a2aServer = up.maybe<A2aServerWiring>('a2a-server')?.a2aServer ?? null
      return pairingModule({
        stateDir: b.deps.stateDir,
        configuredAgent: b.configuredAgent,
        a2aRegistry: c.a2aRegistry,
        db: b.deps.db,
        selfId: b.selfId,
        url: a2aServer ? a2aServer.baseUrl() : undefined,
        tellOwner: { resolveOperatorChatId: c.resolveOperatorChatId, sendAssistantText: c.sendAssistantText, ...(b.deps.speech ? { speech: b.deps.speech } : {}), log: b.deps.log },
        log: b.deps.log,
      })
    }),
    // 乙 v2 — ./wire-yi.ts。
    liftModule({ name: 'yi', needs: ['boot-base', 'boot-core'] }, (up) => yiModule(base(up).configuredAgent, { a2aRegistry: core(up).a2aRegistry, dispatchDelegate: core(up).dispatchDelegate })),
    {
      name: 'bootstrap',
      needs: ['boot-base', 'boot-core'],
      wants: ['knowledge', 'self-restart', 'social', 'a2a-server', 'pairing', 'yi'],
      init: (ctx): Bootstrap => assemble(base(ctx), core(ctx), {
        knowledge: ctx.maybe<NonNullable<Bootstrap['knowledge']>>('knowledge') ?? undefined,
        selfRestart: ctx.maybe<WireSelfRestartResult>('self-restart'),
        social: ctx.maybe<SocialWiring>('social') ?? INERT_SOCIAL,
        a2a: ctx.maybe<A2aServerWiring>('a2a-server'),
        pairing: ctx.maybe<PairingEngine>('pairing') ?? undefined,
        yiHub: ctx.maybe<YiHub | undefined>('yi') ?? undefined,
      }),
    } satisfies DaemonModule<Bootstrap>,
  ]
}

function assemble(b: BootBase, c: BootCore, opt: {
  knowledge: Bootstrap['knowledge']
  selfRestart: WireSelfRestartResult | null
  social: SocialWiring
  a2a: A2aServerWiring | null
  pairing: PairingEngine | undefined
  yiHub: YiHub | undefined
}): Bootstrap {
  const a2aDeps = opt.a2a?.a2aDeps
  const marker = opt.selfRestart?.marker ?? null
  return {
    sessionManager: c.sessionManager,
    sessionStore: c.sessionStore,
    conversationStore: b.conversationStore,
    registry: c.registry,
    coordinator: c.coordinator,
    resolve: b.resolve,
    formatInbound,
    sdkOptionsForProject: c.sdkOptionsForProject,
    buildInstructions: c.buildInstructions,
    currentModelFor: c.currentModelFor,
    defaultProviderId: c.defaultProviderId, pluginsHealth: b.pluginsHealth, providerProbes: c.providerProbes, stopProviderProbes: c.stopProviderProbes, reprobeProvider: c.reprobeProvider,
    codeHead: opt.selfRestart?.loadedHead ?? null,
    providerNotes: () => {
      const out: Partial<Record<ProviderId, string>> = { ...c.baseProviderNotes() }
      for (const [id, note] of c.anomalyNotes) out[id] = out[id] ? `${out[id]} · 注意:${note}` : `注意:${note}`
      return out
    },
    agentProviderKind: c.defaultProviderId,
    dispatchDelegate: c.dispatchDelegate,
    ...(a2aDeps ? { a2aDeps } : {}),
    a2aServer: opt.a2a?.a2aServer ?? null,
    yiHub: opt.yiHub,
    agentConfig: b.configuredAgent,
    sendAssistantText: c.sendAssistantText,
    selfId: b.selfId,
    ...(opt.social.social ? { social: opt.social.social, penpal: opt.social.social.penpal } : {}),
    ...(opt.pairing ? { pairing: opt.pairing } : {}),
    ...(opt.knowledge ? { knowledge: opt.knowledge } : {}),
    health: b.health,
    holdBusy: b.busyRegistry.hold,
    busyLabels: b.busyRegistry.labels,
    ...(marker ? { markInboundActivity: marker.mark } : {}),
  }
}

/**
 * 只有 bootstrap 这一组的容器:测试用(生产里这一组经 bootstrap/module.ts 进 daemon-modules.ts 的大容器)。
 * 给了 supervisor ⇒ 这一组的状态交给它收养(跟生产一样进 /v1/health.subsystems)。
 */
export async function buildBootstrap(deps: BootstrapDeps & { supervisor?: SubsystemSupervisor }): Promise<Bootstrap> {
  const group = createModules(bootstrapModules({ deps: () => deps }), { log: (t, l) => deps.log(t, l) })
  deps.supervisor?.adopt(group)
  await group.start()
  return group.provided<Bootstrap>('bootstrap')!
}
