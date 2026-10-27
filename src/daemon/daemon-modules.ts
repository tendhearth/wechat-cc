/**
 * daemon 的全部模块(架构终态 A1,docs/architecture-end-state-2026-10-25.md;核心链设计稿 PR 6)。
 *
 * 一张表、一个容器(modules/container.ts):`needs` 定开机先后,关机严格倒过来;晚到的东西(环的那一头)
 * 只有一种拿法 —— `lazy` 里写明,经 `ctx.lazy` / `ctx.late` 现取。以前 main.ts 里的六种晚绑定
 * (Ref、`{current}`、`let`、setter、`bootRef?.x`、手排的登记顺序)都收成这一种。
 *
 * 表的顺序就是开机顺序(同层按表里的顺序),也就是关机顺序的倒序;关机顺序由
 * `__e2e__/shutdown-order.e2e.test.ts` 的快照钉住。挪一行 = 改关机顺序,快照会红。
 *
 * 地基(锁、db、几个共享单例)不是模块,见 foundation.ts。
 */
import { randomBytes } from 'node:crypto'
import { log } from '../lib/log'
import { loadAccess } from '../lib/access'
import { resolveTier } from '../domain/user-tier'
import { makeChatOwnerRules } from './permission-gate'
import { makeMtimeCachedConfigReader } from '../lib/agent-config'
import { countInboundMessagesSync, NEW_RELATIONSHIP_MSG_COUNT } from '../lib/messages-store'
import { notifyDesktop } from '../lib/desktop-notify'
import { APP_VERSION, BUILD_SHA } from '../lib/app-version'
import type { Lifecycle } from '../lib/lifecycle'
import { SUPERVISED_ENV } from '../domain/supervised-env'
import { providerCallTarget } from '../app/provider-registry'
import { capabilitiesFor } from '../domain/capability-matrix'
import { makeProjectLessons, type WorkbenchService } from '../features/workbench'
import { workbenchModule, workbenchNotificationsModule, workbenchArtifactsModule } from '../features/workbench/module'
import type { CliUpgrader } from './cli-upgrade/engine'
import type { CliUpgradeModule } from './cli-upgrade/start'
import type { DaemonModule } from './modules/container'
import { lifecycleModule, type LifecycleHolder } from './modules/lifecycle-module'
import type { Foundation } from './foundation'
import { makeGuardRuntime, type GuardRuntime } from './guard/runtime'
import { providersInUse } from './guard/targets'
import { registerGuard } from './guard/lifecycle'
import type { GuardLifecycle } from './guard/lifecycle'
import { makeIlinkAdapter, ILINK_PORTS, type IlinkAdapter } from './ilink-glue'
import { WECHAT_PORTS as W, type WechatAccounts, type WechatCompanionControls, type WechatContacts, type WechatLinkStatus, type WechatPages, type WechatPermissions, type WechatPolling, type WechatSend, type WechatVoice } from '../ports/wechat'
import { makeReplyDeliveryRuntime } from './reply-delivery'
import { registerInternalApi, type InternalApiLifecycle } from './internal-api/lifecycle'
import { makeSelfChangeGlue } from './self-change-glue'
import { runSelftestConverse } from './selftest'
import { providerDisplayName } from './provider-display-names'
import { bootstrapModules, type Bootstrap } from './bootstrap'
import { ownerChatIdOf, isOwnerOf } from './owner-chat'
import { pick } from '../lib/pick'
import { retractOnFactStatus, makeMemoryImportCommand, type MemoryFeature, type MemoryPromptReads } from '../features/memory'
import { memoryModule, memoryNightlyModule } from '../features/memory/module'
import { loadCompanionConfig } from '../lib/companion-config'
import { careLevel, companionOfferEligible, type registerIngest } from '../features/companion'
import { companionModule, companionPushModule, companionIntrospectModule, companionIngestModule } from '../features/companion/module'
import { makeLlmHealth, type LlmHealth } from './llm-health'
import type { TerminalFeature } from '../features/terminal'
import { terminalModule } from '../features/terminal/module'
import { wireActivity, type Activity } from './bootstrap/wire-activity'
import type { JobsFeature } from '../features/jobs'
import { jobsModule, scheduledJobsModule } from '../features/jobs/module'
import { lettersModule } from '../features/letters/module'
import { atelierModule } from '../features/atelier/module'
import { journalModule } from '../features/journal/module'
import { huntModule } from '../features/hunt/module'
import { voiceModule } from '../features/voice/module'
import { phoneModule } from '../features/phone/module'
import { makeProjectLessonsCommand } from './project-lessons-command'
import type { CalendarFeature } from '../features/calendar'
import { calendarModule } from '../features/calendar/module'
import { consoleModule } from '../features/console/module'
import { fromReplyHandler } from './commands/registry'
import { wireMain, type WiredDeps } from './wiring'
import { buildInboundPipeline, type AppTurn } from './inbound/build'
import type { PipelineRun } from './inbound/types'
import { startPendingFlush } from './speech/pending-notices'
import { registerSessions } from './sessions-lifecycle'
import { registerIlink } from './ilink-lifecycle'
import { registerPolling, type PollingLifecycle } from './polling-lifecycle'
import { startCliUpgrade } from './cli-upgrade/start'
import { remindersModule } from '../features/reminders/module'
import type { StickersFeature } from '../features/stickers'
import { stickersModule } from '../features/stickers/module'
import { reportOutboxModule, reportsModule } from '../features/reports/module'
import { runStartupSweeps } from './startup-sweeps'
import { isHeartbeatFresh } from './single-instance'

/** boot-api 交出去的:靠 bootstrap 才有的 LLM 体检。 */
interface BootApi { llmHealth: LlmHealth }
/** 「主人的命令」那一组:定时 / 日历 / 做过的事 / 经验 / 导入记忆 / 终端会话(命令表里的顺序就是优先级)。 */
interface OwnerCommands {
  commands: ReturnType<typeof fromReplyHandler>[]
}

export function daemonModules(f: Foundation): DaemonModule[] {
  const { stateDir, dangerously, db } = f
  const ownerChatId = () => ownerChatIdOf(stateDir)
  const isOwner = isOwnerOf(stateDir)

  return [
    // —— 网络守护的闸门:语音、provider registry、SessionManager、协调器、工作台都接它,所以最先有 ——
    {
      name: 'network-gate',
      lazy: ['guard', 'bootstrap', 'workbench'],
      init(ctx): GuardRuntime {
        const guard = ctx.late<LifecycleHolder<GuardLifecycle>>('guard')
        const boot = ctx.late<Bootstrap>('bootstrap')
        const workbench = ctx.late<WorkbenchService>('workbench')
        const readCfg = makeMtimeCachedConfigReader(stateDir)
        return makeGuardRuntime({
          stateDir, log: (t, l) => log(t, l),
          lifecycle: () => guard()?.current() ?? null,
          // 评审 #193 P1-1:按 provider / 会话自己报的实际目标,不按此刻的配置推。bootstrap 之前是空。
          providersInUse: () => {
            const b = boot()
            if (!b) return []
            return providersInUse(
              (() => { try { return readCfg() } catch { return null } })(),
              b.registry.list(),
              b.sessionManager.list().map(s => ({ id: s.providerId, model: s.model ?? null, target: b.sessionManager.effectiveTarget(s) })),
              (id) => providerCallTarget(b.registry.get(id)?.provider, id, 'session'),
            )
          },
          // 暂停在跑的任务(2026-10-03):health 的 guard 块 / `guard status` 列出被冻住的任务。
          suspendedTasks: () => workbench()?.networkSuspended() ?? [],
        })
      },
    } satisfies DaemonModule<GuardRuntime>,

    // —— ilink 适配器(只造,不拉消息):权限卡、自改、终端会话要经 CC 开口那道门(wired 里才造)——
    // 别的模块不拿整个 adapter,只 needs 它交出的窄口(`wechat.send` …,src/ports/wechat.ts;架构终态 A6)。
    {
      name: 'ilink-adapter',
      needs: ['network-gate'],
      lazy: ['wired'],
      init(ctx): IlinkAdapter {
        const wired = ctx.late<WiredDeps>('wired')
        return makeIlinkAdapter({ stateDir, accounts: f.accounts, db, conversationStore: f.conversationStore, networkGate: ctx.get<GuardRuntime>('network-gate').gate, speech: () => wired()?.speech ?? null })
      },
      ports: ILINK_PORTS,
    } satisfies DaemonModule<IlinkAdapter>,

    // —— 回复交付(spec 2026-10-03-reply-delivery):daemon 负责送达的那一条路,必须是同一个实例 ——
    {
      name: 'reply-delivery',
      needs: [W.send],
      init(ctx) {
        const wxSend = ctx.get<WechatSend>(W.send)
        return makeReplyDeliveryRuntime({
          sendText: (c, t) => wxSend.sendMessage(c, t),
          sink: { captureReply: (c, r) => f.replySinks.captureReply?.(c, r) ?? false },
          isSinkOpen: (c) => f.replySinks.isOpen?.(c) ?? false,
          observe: (c, t) => f.outboundTaps.observe(c, t),
          chatPrefs: (c) => f.chatPrefs.get(c),
          log: (t, l, x) => log(t, l, x),
        })
      },
    } satisfies DaemonModule<ReturnType<typeof makeReplyDeliveryRuntime>>,

    // 打猎「默认关」那次的一次性开机步骤:排在 internal-api 开门、任何伙伴那一拍之前(以前在地基里)
    huntModule(f),

    // —— internal API:bootstrap 要它的 baseUrl / token 去配 MCP,所以在 init 段就监听(桌面这时来问 ⇒ 「还没有」)——
    {
      name: 'internal-api',
      needs: [W.send, W.permissions, W.contacts, W.pages, W.link, 'reply-delivery', 'network-gate'],
      lazy: ['bootstrap', 'polling', 'wired'],
      async init(ctx): Promise<InternalApiLifecycle> {
        const wxSend = ctx.get<WechatSend>(W.send)
        const wxPerm = ctx.get<WechatPermissions>(W.permissions)
        const wxContacts = ctx.get<WechatContacts>(W.contacts)
        const wxPages = ctx.get<WechatPages>(W.pages)
        const wxLink = ctx.get<WechatLinkStatus>(W.link)
        const guardRt = ctx.get<GuardRuntime>('network-gate')
        const boot = ctx.late<Bootstrap>('bootstrap')
        const polling = ctx.late<LifecycleHolder<PollingLifecycle>>('polling')
        const wired = ctx.late<WiredDeps>('wired')
        const api: InternalApiLifecycle = await registerInternalApi({
          stateDir, daemonPid: process.pid, db, projects: f.projects,
          getChatPrefs: (c) => f.chatPrefs.get(c),
          setChatPref: (c, p) => f.chatPrefs.set(c, p),
          replySinks: f.replySinks,
          outboundTaps: f.outboundTaps,
          replyDelivery: ctx.get('reply-delivery'),
          journal: f.journal,
          // 待决权限的桌面面(spec §6)。和微信「y/n <hash>」共用 ilink 里那一份 PendingPermissions ——
          // 从哪边拍板都算数。拍板本身也是「主人刚跟我说过话」的证据,所以成功时记一笔 contact。
          permissions: {
            list: () => wxPerm.listPendingPermissions(),
            resolve: (h, d) => { const ok = wxPerm.resolvePermission(h, d); if (ok) f.petSignals.noteContact(); return ok },
          },
          // 自改流水线的三个抓手(spec 2026-09-18-self-change-pipeline §daemon 侧):流水线是 daemon 外面的 CLI 进程,
          // 「报进展 / 问 y-n / 查拍板」都经这里回来;卡片和微信、桌面共用同一份 PendingPermissions。
          selfChange: makeSelfChangeGlue({
            ownerChatId: () => loadCompanionConfig(stateDir).default_chat_id ?? null,
            speech: () => wired()?.speech ?? null,
            // 只登记、自己发卡:卡片发不出去时条目要留在登记处,好让主人从桌面权限卡或 `self change --approve <id>` 拍板。
            registerPending: (h, t, meta) => wxPerm.registerPendingPermission(h, t, meta),
            sweepPending: () => { wxPerm.sweepPendingPermissions() },
            codeOf: (h) => wxPerm.pendingPermissionCodeOf(h),
            newHash: () => randomBytes(8).toString('hex'),
            now: () => Date.now(),
            log: (line) => { log('SELF-CHANGE', line) },
          }),
          // chat_history 工具后端(provider-handoff 的逃生口)
          messages: { listRange: (c: string, o: { limit: number; beforeTs?: string }) => f.messagesStore.listRange(c, o), search: (c: string, q: string, l: number) => f.messagesStore.search(c, q, l) },
          // 桌宠「主人真在跟我说话吗」:只认入站(伙伴自己的外发会 bump lastUsedAt,但不该让熊说「在跟你聊」)。
          latestInboundTs: (c: string) => f.messagesStore.latestInboundTs(c),
          setUserName: (chatId, name) => wxContacts.setUserName(chatId, name),
          sharePage: (t, c, o) => wxPages.sharePage(t, c, o), resurfacePage: (q) => wxPages.resurfacePage(q),
          ilink: { sendReply: (c, t) => wxSend.sendMessage(c, t).then(r => r as { msgId: string; error?: string }), sendFile: (c, p) => wxSend.sendFile(c, p), noteSentMedia: (c, m) => wxSend.noteSentMedia?.(c, m), editMessage: (c, m, t) => wxSend.editMessage(c, m, t), broadcast: (t, a) => wxSend.broadcast(t, a) },
          // 微信回复前缀用短名;两种 Gemini 都开着时要分得开,所以按现在注册了谁来解析(收敛清单 ⑥)
          prefix: { conversationStore: f.conversationStore, providerDisplayName: (id) => providerDisplayName(id, boot()?.registry.list() ?? []), permissionMode: dangerously ? 'dangerously' as const : 'strict' as const },
          turns: f.turnRecordStore,
          // 下面这些读口在 bootstrap 起来之前回「还没有」(null / 空 / no-op),路由据此回 503 —— 跟以前一样。
          listSessions: () => boot()?.sessionManager?.list() ?? null,
          heartbeatFresh: () => isHeartbeatFresh(f.heartbeatPath),
          polling: () => polling()?.current()?.bootSummary() ?? null,
          // 后台在跑的版本(2026-09-16):head 只在「从 git 检出跑」时有值;打包产物里退回编译期钉进去的 BUILD_SHA。
          version: () => ({ cli: APP_VERSION, head: boot()?.codeHead ?? (BUILD_SHA === 'dev' ? null : BUILD_SHA), boot_at: f.bootAtIso }),
          subsystems: () => f.sup.statuses(),
          // 网络守护此刻的判断(2026-10-02):safe=false ⇒ 所有模型调用暂停。
          guard: () => guardRt.health(),
          // 插件快照(2026-09-30):bootstrap 之前是 null,self deploy 的健康门会等它。
          plugins: () => boot()?.pluginsHealth ?? null,
          providerProbes: () => boot()?.providerProbes?.() ?? [],
          providerRefusals: () => f.providerRefusals.all(),
          outbound: () => wxLink.outboundHealth(),
          releaseSession: (k) => boot()?.sessionManager?.release(k) ?? Promise.resolve(),
          // 换模型时把该 provider 的会话存档行删掉:不删的话下一次 spawn 会 resume 回旧会话,新模型钉不上。
          forgetProviderSessions: (providerId) => boot()?.sessionStore?.deleteProvider(providerId) ?? 0,
          // POST /v1/selftest/converse:registry 没建好之前起不了会话 ⇒ null,路由回 503 selftest_not_wired。
          selftestConverse: (input) => {
            const b = boot()
            if (!b) return Promise.resolve(null)
            return runSelftestConverse({
              registry: b.registry,
              mintSessionToken: (tier, key, o) => api.mintSessionToken(tier, key, o),
              invalidateSession: (key) => api.invalidateSession(key),
              log: (t, l) => log(t, l),
            }, input)
          },
          requestRestart: () => f.requestRestart('internal-api'),
          markInboundActivity: () => boot()?.markInboundActivity?.(),
          // busy-registry hold(spec 2026-08-11):bootstrap 之前什么都不会「忙」,给一个空的放手。
          holdBusy: (l) => boot()?.holdBusy?.(l) ?? (() => {}),
          busyLabels: () => boot()?.busyLabels?.() ?? [],
          log: (t, l) => log(t, l),
          // LLM 记忆路由的 chat_id 缺省:access.json 里唯一的 admin。
          resolveAdminChatId: () => ownerChatId(),
        })
        ctx.own('stop', () => api.stop())
        return api
      },
    } satisfies DaemonModule<InternalApiLifecycle>,
    // 记忆:bootstrap 的提示词要它的素材(needs);`/v1/memory/*` 紧跟 internal-api
    memoryModule(f),
    // 下面这几个只挂路由,紧跟 internal-api(以前随 internal-api 一起就在,桌面 / MCP 工具开机就来):控制台、画室、背包、陪伴、语音、手机
    consoleModule(f),
    atelierModule(f),
    journalModule(f),
    companionModule(f),
    voiceModule(),
    phoneModule(),

    // 贴纸:表情库全 daemon 一份,bootstrap(提示词)和 wired 都要它
    stickersModule(f),

    // —— bootstrap:provider registry / 会话管理 / 协调器 + 可选的知识库 / 社交 / A2A / 配对 / 乙(一组模块,bootstrap/index.ts)——
    ...bootstrapModules({
      needs: [W.send, W.permissions, W.companion, W.accounts, 'reply-delivery', 'internal-api', 'network-gate', 'stickers', 'memory'],
      lazy: ['cli-upgrade', 'workbench', 'wired', 'terminal'],
      deps: (ctx) => {
        const wxSend = ctx.get<WechatSend>(W.send)
        const wxPerm = ctx.get<WechatPermissions>(W.permissions)
        const wxCompanion = ctx.get<WechatCompanionControls>(W.companion)
        const wxAccounts = ctx.get<WechatAccounts>(W.accounts)
        const terminal = ctx.late<TerminalFeature>('terminal')
        const replyDelivery = ctx.get<ReturnType<typeof makeReplyDeliveryRuntime>>('reply-delivery')
        const internalApi = ctx.get<InternalApiLifecycle>('internal-api')
        const guardRt = ctx.get<GuardRuntime>('network-gate')
        const cliUpgrade = ctx.late<CliUpgradeModule>('cli-upgrade')
        const workbench = ctx.late<WorkbenchService>('workbench')
        const wired = ctx.late<WiredDeps>('wired')
        return {
          stateDir, db, loadProjects: () => f.projects.load(), networkGate: guardRt.gate,
          ilink: { ...pick(wxSend, 'sendMessage', 'sendFile'), ...pick(wxPerm, 'askUser'), companion: wxCompanion },
          // CC 开口那道门在 wired 里才造;bootstrap 里的社交通知比它早接线、晚发 ⇒ 现取。
          speech: () => wired()?.speech ?? null,
          // 工作台正占着这个目录 / 原生会话 ⇒ 会话管理拒 acquire;工作台还没起 ⇒ 不冲突。
          executionGuard: (path, providerId, nativeId) => workbench()?.conflictsExternal(path, providerId, nativeId) ?? false,
          lastActiveChatId: wxAccounts.lastActiveChatId, log: (t, l, x) => log(t, l, x),
          fallbackProject: () => ({ alias: '_default', path: process.cwd() }),
          dangerouslySkipPermissions: dangerously, conversationStore: f.conversationStore,
          replySinks: f.replySinks,
          outboundTaps: f.outboundTaps,
          replyDelivery,
          // 主人自己的对话走放行规则(2026-10-25 主人点头):规则那一层在终端会话功能里(比 bootstrap 晚起)⇒ 现取;
          // 主人与否按 access.json 的 admins 现算(原始档位,不看 --dangerously)。
          chatOwnerRules: () => {
            const gate = terminal()?.permissionGate
            return gate ? makeChatOwnerRules({ gate, replyDelivery, isOwnerChat: (c) => resolveTier(c, loadAccess()) === 'admin' }) : null
          },
          petSignals: f.petSignals,
          onTurnRecord: (r) => {
            f.turnRecordStore.append(r)
            f.providerRefusals.onTurn(r)
            // CLI 自动升级的报错触发(2026-10-04):错误通道像「CLI 太旧」⇒ 排一次版本检查。
            if (r.outcome !== 'completed') cliUpgrade()?.upgrader()?.onTurnError(r.provider, r.errorCode, r.error)
          },
          mintSessionToken: internalApi.mintSessionToken,
          invalidateSession: internalApi.invalidateSession,
          internalApi: { baseUrl: internalApi.baseUrl, tokenFilePath: internalApi.tokenFilePath },
          ...promptReads(f, ctx.get<StickersFeature>('stickers').lib, ctx.get<MemoryFeature>('memory').promptReads),
          // self-restart(spec 2026-08-03):只在有 supervisor 拉起我们的地方开(`service install` 写进 launchd / systemd 的
          // WECHAT_CC_SUPERVISED)—— 前台 `bun cli.ts run`、Windows 的登录任务里 exit(0) 就是死了,而这个功能是静默的。
          ...(process.env[SUPERVISED_ENV] === '1'
            ? { requestRestart: () => f.requestRestart('self-restart-stale-code') }
            : {}),
        }
      },
    }),

    // —— 把 bootstrap 的产物交给 internal-api 的路由;LLM 通道体检 ——
    {
      name: 'boot-api',
      needs: ['bootstrap', 'internal-api'],
      // 待办「不对」一路收回要 wired 造的每晚整理(G5);只在知识库起了才取 ⇒ 测试里不走这条,守卫 scripts/module-lazy.guard.test.ts 静态核
      lazy: ['wired'],
      init(ctx): BootApi {
        const boot = ctx.get<Bootstrap>('bootstrap')
        const internalApi = ctx.get<InternalApiLifecycle>('internal-api')
        internalApi.provide({ delegate: { dispatchOneShot: boot.dispatchDelegate, knownPeers: () => boot.registry.list() } })
        internalApi.provide({ conversation: { setMode: (chatId, mode) => boot.coordinator.setMode(chatId, mode) } })
        // 可选子系统没起(配置没开 / 降级)⇒ 不 provide,对应路由照旧 503。
        if (boot.a2aDeps) internalApi.provide({ a2a: boot.a2aDeps })
        // 社交的路由和窄口(socialView)由社交模块自己挂 / 交(src/features/social),不经这里。
        // 待办「不对」/ MCP 的 superseded 走 /v1/knowledge/facts/set_fact_status:状态改了就一路收回(架构终态 G5,主人 10-26 第 1 条)
        if (boot.knowledge) {
          const k = boot.knowledge
          const wiredLate = ctx.late<WiredDeps>('wired')
          internalApi.provide({ knowledge: k.facts ? { ...k, facts: retractOnFactStatus(k.facts, {
            factById: (id) => k.store.factById(id),
            retract: (text, verdict) => {
              const owner = ownerChatId(), w = wiredLate()
              if (owner && w) void w.memoryNightly.retractText(owner, text, verdict, '待办').catch(err => log('MEMORY_NIGHTLY', `fact retract failed: ${err instanceof Error ? err.message : String(err)}`))
            },
          }) } : k })
        }
        if (boot.pairing) internalApi.provide({ pairing: boot.pairing })
        internalApi.provide({ incidents: boot.health.incidents })
        // LLM 通道体检:没有开机探测、没有定时器(主人 2026-08-25:断网时无人要求的外呼是风控形状),只在点「测试连接」时拨。
        const llmHealth = makeLlmHealth({ registry: boot.registry, defaultProviderId: boot.defaultProviderId, hintFor: (id) => capabilitiesFor(id).authFailHint, log })
        internalApi.provide({ llmHealth, llmRegistered: () => boot.registry.list(), llmNames: (id) => boot.registry.namesOf(id), llmEndpoints: () => {
          // 自配 base_url:目前只有 openai-compatible 端点可指向国内 / 本地服务;网络体检据此探真实端点。
          const eps: Record<string, string> = {}
          const b = boot.agentConfig.openaiBaseUrl
          if (b) eps.openai = b
          return eps
        } })
        return { llmHealth }
      },
    } satisfies DaemonModule<BootApi>,

    // 终端会话
    terminalModule(f),

    // —— 功能(一个功能一个目录,src/features/<名>)——
    calendarModule(f),

    // —— 「CC 做过的事」:手机时间线 / 微信「做过的事」/ 周报共用一组来源 ——
    {
      name: 'activity',
      needs: ['terminal', W.send],
      init(ctx): Activity {
        const cli = ctx.get<TerminalFeature>('terminal')
        return wireActivity({ stateDir, db, ilink: ctx.get<WechatSend>(W.send), permissionDecisions: cli.permissionDecisions, cliEvents: cli.cliEvents, jobsStore: f.jobsStore })
      },
    } satisfies DaemonModule<Activity>,
    // 定时 / 早报 / 周报 / 换一家来审
    jobsModule(f),

    // —— 主人的命令:命令现在就要(进命令表),要用的只读轮 / 工作台 / 门都在后面 ⇒ 经 late 现取 ——
    {
      name: 'owner-commands',
      needs: ['bootstrap', 'terminal', 'calendar', 'activity', 'jobs', W.send, 'internal-api', 'network-gate'],
      lazy: ['workbench', 'wired'],
      init(ctx): OwnerCommands {
        const boot = ctx.get<Bootstrap>('bootstrap')
        const wxSend = ctx.get<WechatSend>(W.send)
        const internalApi = ctx.get<InternalApiLifecycle>('internal-api')
        const cli = ctx.get<TerminalFeature>('terminal')
        const workbench = ctx.late<WorkbenchService>('workbench')
        const wired = ctx.late<WiredDeps>('wired')
        const say = (c: string, t: string) => wxSend.sendMessage(c, t)
        const activity = ctx.get<Activity>('activity')
        const jobs = ctx.get<JobsFeature>('jobs')
        // 微信「经验 <项目> …」(第二轮对标 ★2):只认主人;项目按名字认。
        const lessonsCommand = makeProjectLessonsCommand({
          isOwner, say,
          projects: () => { const w = workbench(); return w ? w.projects().map(p => ({ name: p.name, path: p.path })) : null },
          lessons: makeProjectLessons(stateDir),
        })
        // 微信「导入记忆」(第二轮对标 #7):主人把别的助手对他的了解贴回来,点头的才写进记忆。
        const memoryImportCommand = makeMemoryImportCommand({
          isOwner, say, now: () => Date.now(),
          importEntries: (items, label) => { const w = wired(); if (!w) throw new Error('memory_not_wired'); return w.memoryNightly.importEntries(items, label) },
        })
        // 读日历和提醒:一个功能一个目录(src/features/calendar);命令从那里来。
        const { command: calendarCommand } = ctx.get<CalendarFeature>('calendar')
        // 微信「终端」「看 码」「@码 …」「y 码」:终端会话那个功能造好的(src/features/terminal)
        const cliReplyHandler = cli.command
        return {
          // 命令表的顺序就是优先级(重构第二批步 2;与原来文本命令链的顺序一致)
          commands: [fromReplyHandler('jobs', jobs.command), fromReplyHandler('calendar', calendarCommand), fromReplyHandler('activity', activity.command), fromReplyHandler('lessons', lessonsCommand), fromReplyHandler('memory-import', memoryImportCommand), fromReplyHandler('cli', cliReplyHandler, { ownsSlash: (m) => /^\s*\/(?:cli|today)\s*[?？]?\s*$/i.test(m.text ?? '') })],
        }
      },
    } satisfies DaemonModule<OwnerCommands>,

    // 回报的队列 + ReportSink:工作台入队要它,所以排在工作台前面;投递那一拍在下面 `reports`
    reportOutboxModule(f),

    // 工作台(「一起做」)
    workbenchModule(f),

    // —— wireMain:入站管道的依赖、伙伴 tick、手机那一簇、CC 开口那道门 ——
    {
      name: 'wired',
      needs: ['bootstrap', 'boot-api', 'terminal', 'owner-commands', 'activity', 'workbench', W.send, W.accounts, W.contacts, W.pages, W.permissions, W.link, W.voice, W.polling, 'reply-delivery', 'internal-api', 'network-gate', 'stickers'],
      lazy: ['pipeline', 'polling', 'companion.ingest'],
      init(ctx): WiredDeps {
        const boot = ctx.get<Bootstrap>('bootstrap')
        const { llmHealth } = ctx.get<BootApi>('boot-api')
        const cli = ctx.get<TerminalFeature>('terminal')
        const owner = ctx.get<OwnerCommands>('owner-commands')
        const workbench = ctx.get<WorkbenchService>('workbench')
        const wxSend = ctx.get<WechatSend>(W.send)
        const wxAccounts = ctx.get<WechatAccounts>(W.accounts)
        const wxContacts = ctx.get<WechatContacts>(W.contacts)
        const wxPages = ctx.get<WechatPages>(W.pages)
        const wxPerm = ctx.get<WechatPermissions>(W.permissions)
        const wxLink = ctx.get<WechatLinkStatus>(W.link)
        const wxVoice = ctx.get<WechatVoice>(W.voice)
        const wxPolling = ctx.get<WechatPolling>(W.polling)
        const internalApi = ctx.get<InternalApiLifecycle>('internal-api')
        const guardRt = ctx.get<GuardRuntime>('network-gate')
        const pipeline = ctx.late<PipelineModule>('pipeline')
        const polling = ctx.late<LifecycleHolder<PollingLifecycle>>('polling')
        const ingest = ctx.late<LifecycleHolder<ReturnType<typeof registerIngest>>>('companion.ingest')
        const wired = wireMain({
          late: {
            polling: () => polling()?.current() ?? null,
            pipeline: () => pipeline()?.run ?? null,
            appTurn: () => pipeline()?.appTurn ?? null,
            // inbound path nudges ingestion on fresh activity
            ingestNudge: () => ingest()?.current()?.nudge ?? null,
          },
          workbench,
          cliSessions: () => cli.cliEvents.list({ limit: 50 }),
          activity: ctx.get<Activity>('activity').activity, activityLog: ctx.get<Activity>('activity').activityLog,
          overseerToday: cli.overseerToday,
          terminalHooks: cli.terminalHooks,
          // 手机拍板 / 说一句(终端会话那个功能造好的):拍板与微信「y/n 码」、桌宠权限卡同一份待批;说一句与微信「@码」同一个 core。
          cliActions: cli.phoneActions,
          matters: f.matters, guardRuntime: guardRt, subsystems: () => f.sup.statuses(), providerRefusals: () => f.providerRefusals.all(),
          panelTokens: internalApi.panelTokens,
          commands: owner.commands,
          stickers: ctx.get<StickersFeature>('stickers').lib,
          requestRestart: (reason) => f.requestRestart(reason),
          llmHealth,
          // 微信那一侧:入站管道那一簇 + 拉消息 / 冲盘要的那几样(PipelineWechat & 生命周期那两样),从各口挑。
          ilink: {
            ...pick(wxSend, 'sendMessage', 'sendFile', 'sendTyping', 'onMediaSent'),
            ...pick(wxAccounts, 'routeChatToAccount', 'captureContextToken', 'markChatActive', 'resolveAccountId'),
            ...pick(wxContacts, 'setUserName', 'resolveUserName'),
            ...pick(wxPages, 'sharePage'),
            ...pick(wxPerm, 'probePermissionReply', 'handlePermissionReply', 'listPendingPermissions'),
            ...pick(wxLink, 'outboundHealth', 'proactiveClosedSince', 'sessionState'),
            ...pick(wxPolling, 'getUpdatesForLoop', 'flush'),
            voice: wxVoice,
          },
          stateDir, db, projects: f.projects, accounts: f.accounts, boot, dangerously, chatPrefs: f.chatPrefs, careLedger: f.careLedger, replySinks: f.replySinks,
          outboundTaps: f.outboundTaps, journal: f.journal, petSignals: f.petSignals, replyDelivery: ctx.get('reply-delivery'),
          // 随身 CC 首屏:聊天日摘要读 turn_records;presence 走 internal-api 的共用入口。
          turns: f.turnRecordStore,
          presence: () => internalApi.getPresence(),
          loadAccess,
          log: (t, l) => log(t, l),
          schedulerIntervalMs: f.schedulerIntervalMs,
        })
        internalApi.provide({ companionConverse: wired.companionConverse })
        if (wired.mattersService) internalApi.provide({ matters: wired.mattersService })
        internalApi.provide({ petTurn: wired.petTurn })
        internalApi.provide({ settingsLink: wired.settingsPanelLink })
        internalApi.provide({ connections: wired.connections })
        // 「一件事」活动时间:先于工作台停,退订 changes + 清节流定时器。
        ctx.own('matter-activity', async () => wired.stopMatterActivity())
        // 手机那一簇(隧道 / notifier / 订阅 / 设置面板):比 polling 晚停 ⇒ 入站先停,App 在途的回复还能经隧道送完。
        ctx.own('phone', () => wired.stopPhone())
        // 推后了的 report / blocking 补说的那一拍(speech/pending-notices.ts):门这一层唯一的触发点
        let flush: Lifecycle | null = null
        ctx.onStart('speech-pending-flush', () => { flush = startPendingFlush(wired.speech, (t, l) => log(t, l)) })
        ctx.own('speech-pending-flush', () => flush?.stop())
        return wired
      },
    } satisfies DaemonModule<WiredDeps>,

    {
      name: 'pipeline',
      needs: ['wired'],
      init(ctx): PipelineModule {
        const p = buildInboundPipeline(ctx.get<WiredDeps>('wired').pipelineDeps)
        return { run: p, appTurn: p.appTurn }
      },
    } satisfies DaemonModule<PipelineModule>,

    // —— 起了就跑的那些(start 段按这个顺序起,关机倒过来)——
    companionPushModule(),
    companionIntrospectModule(),
    companionIngestModule(),
    lifecycleModule('guard', (ctx) => registerGuard(ctx.get<WiredDeps>('wired').guardDeps), { needs: ['wired'] }),
    // 外部 CLI provider 的退避重探计时器(2026-10-04)—— 关停时别再起探测、别再晚注册。
    {
      name: 'provider-probes',
      needs: ['bootstrap'],
      init(ctx) { const boot = ctx.get<Bootstrap>('bootstrap'); ctx.own('stop', () => boot.stopProviderProbes?.()) },
    },
    lifecycleModule('sessions', (ctx) => registerSessions(ctx.get<WiredDeps>('wired').sessionsDeps), { required: true, needs: ['wired'] }),
    lifecycleModule('ilink', (ctx) => registerIlink(ctx.get<WiredDeps>('wired').ilinkDeps), { required: true, needs: ['wired'] }),
    // 工作台的微信通知 / 成果:停在 polling 之后,开动却在开机最后(startup-sweeps)
    workbenchNotificationsModule(),
    workbenchArtifactsModule(),
    lifecycleModule('polling', (ctx) => registerPolling({ ...ctx.get<WiredDeps>('wired').pollingDeps, runPipeline: ctx.get<PipelineModule>('pipeline').run }), { required: true, needs: ['wired', 'pipeline'] }),
    memoryNightlyModule(),
    lettersModule(f),
    // 外部 agent CLI 自动升级(主人 2026-10-04,docs/maintainer/cli-auto-upgrade.md):空闲时升、升完自检、不过就退回。
    {
      name: 'cli-upgrade',
      optional: true,
      needs: ['bootstrap', 'wired', 'internal-api', 'network-gate'],
      init(ctx): CliUpgradeModule {
        const boot = ctx.get<Bootstrap>('bootstrap')
        const wired = ctx.get<WiredDeps>('wired')
        const internalApi = ctx.get<InternalApiLifecycle>('internal-api')
        let upgrader: CliUpgrader | null = null
        let lc: Lifecycle | null = null
        ctx.onStart('start', () => {
          const started = startCliUpgrade({
            stateDir, sessionManager: boot.sessionManager, busyLabels: () => boot.busyLabels(), holdBusy: (l) => boot.holdBusy(l),
            registry: boot.registry, networkGate: ctx.get<GuardRuntime>('network-gate').gate,
            // 开机探测失败、正在重探的 provider:升完立刻重探一次,注册上再自检(#211)。
            reprobeProvider: (id) => boot.reprobeProvider?.(id) ?? Promise.resolve(null),
            mintSessionToken: (tier, key, o) => internalApi.mintSessionToken(tier, key, o),
            invalidateSession: (key) => internalApi.invalidateSession(key),
            sendOwner: async (text) => {
              const o = ownerChatId()
              if (!o) return false
              // 经 CC 开口那道门(upgrade_notice 归 report);被推后 / 没发出去 ⇒ false,调用方照旧发桌面通知
              return wired.speech.tell('upgrade_notice', o, text)
            },
            notifyDesktop: (t, b) => notifyDesktop(t, b),
            log: (t, l) => log(t, l),
          })
          upgrader = started.upgrader; lc = started.lifecycle
          internalApi.provide({ cliUpgrade: started.upgrader })
        })
        ctx.own('stop', () => lc?.stop())
        return { upgrader: () => upgrader }
      },
    } satisfies DaemonModule<CliUpgradeModule>,
    remindersModule(f),
    scheduledJobsModule(),
    reportsModule(),
    // 开机的最后一步:一次性清扫(fire-and-forget,含「CC 回来了」),然后才开动工作台的通知 / 成果(见上)。
    {
      name: 'startup-sweeps',
      needs: ['wired', 'workbench-notifications', 'workbench-artifacts'],
      init(ctx) {
        ctx.onStart('run', () => {
          runStartupSweeps({ ...ctx.get<WiredDeps>('wired').startupDeps, previousRun: f.previousRun })
          ctx.get<Deferred>('workbench-notifications').start()
          ctx.get<Deferred>('workbench-artifacts').start()
        })
      },
    },
  ]
}

interface PipelineModule { run: PipelineRun; appTurn: AppTurn }

/** 造好了、但开动的时刻由别的模块定(工作台通知要排在开机清扫之后)。 */
interface Deferred { start(): void }

/** 每次起会话时现读的提示词素材(人格、记忆、贴纸、关心档 ……):手改了文件,不用重启就生效。记忆那几样归记忆功能(src/features/memory)。 */
function promptReads(f: Foundation, stickers: StickersFeature['lib'], memory: MemoryPromptReads) {
  const { stateDir, db } = f
  return {
    // Proactive-care design §5/§7 — this chat's effective care level per-spawn (chat-prefs override ∪ default_chat_id).
    careLevelFor: (c: string) => careLevel(c, f.chatPrefs.get(c), loadCompanionConfig(stateDir).default_chat_id ?? undefined),
    // onboarding-curiosity design §2 — cheap indexed COUNT per spawn.
    newRelationshipFor: (c: string) => countInboundMessagesSync(db, c) < NEW_RELATIONSHIP_MSG_COUNT,
    // owner-onboarding design §C1 — companion-offer nudge; owner resolved via admins membership (guest-safe by construction).
    companionOfferFor: (c: string) => companionOfferEligible({
      chatId: c,
      access: loadAccess(),
      companion: loadCompanionConfig(stateDir),
      inboundCount: countInboundMessagesSync(db, c),
    }),
    // bubble-replies design — `/set split off` silences both route splitting and the bubble guidance.
    bubbleRepliesFor: (c: string) => f.chatPrefs.get(c).split !== false,
    // image-stickers plan §5 — per-chat opt-out hides both sticker sections (null); pref on ⇒ allTags() (may be []).
    stickerTagsFor: (c: string) => (f.chatPrefs.get(c).stickers !== false ? stickers.allTags() : null),
    // 人格、画像、长期记忆、主人原话、今天的草稿、知识(src/features/memory/prompt-reads.ts)
    ...memory,
  }
}
