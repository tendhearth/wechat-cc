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
import { hostname as osHostname } from 'node:os'
import { join } from 'node:path'
import { log } from '../lib/log'
import { loadAccess } from '../lib/access'
import { makeMtimeCachedConfigReader } from '../lib/agent-config'
import { countInboundMessagesSync, NEW_RELATIONSHIP_MSG_COUNT } from '../lib/messages-store'
import { notifyDesktop } from '../lib/desktop-notify'
import { readOwnerDoc, renderOwnerForPrompt } from '../lib/memory-owner'
import { APP_VERSION, BUILD_SHA } from '../lib/app-version'
import type { Lifecycle } from '../lib/lifecycle'
import { SUPERVISED_ENV } from '../core/supervised-env'
import { providerCallTarget } from '../core/provider-registry'
import { capabilitiesFor } from '../core/capability-matrix'
import { CORE_MEMORY_MAX_CHARS, KNOWLEDGE_MEMORY_MAX_CHARS } from '../core/prompt-builder'
import { summarizeJobs } from '../core/scheduled-jobs-store'
import { makeProjectLessons } from '../core/workbench/project-lessons'
import { makeWorkbenchStore } from '../core/workbench/store'
import type { WorkbenchService } from '../core/workbench/service'
import type { CliUpgrader } from '../core/cli-upgrade/engine'
import type { DaemonModule } from './modules/container'
import { lifecycleModule, type LifecycleHolder } from './modules/lifecycle-module'
import type { Foundation } from './foundation'
import { makeGuardRuntime, type GuardRuntime } from './guard/runtime'
import { providersInUse } from './guard/targets'
import { registerGuard } from './guard/lifecycle'
import type { GuardLifecycle } from './guard/lifecycle'
import { makeIlinkAdapter, type IlinkAdapter } from './ilink-glue'
import { makeReplyDeliveryRuntime } from './reply-delivery'
import { registerInternalApi, type InternalApiLifecycle } from './internal-api/lifecycle'
import { makeSelfChangeGlue } from './self-change-glue'
import { runSelftestConverse } from './selftest'
import { providerDisplayName } from './provider-display-names'
import { makeAtelierStore } from './atelier-store'
import { bootstrapModules, resolveAdminChatId, type Bootstrap } from './bootstrap'
import { makeMemoryFS } from './memory/fs-api'
import { makeMemoryLlmOps, resolveCheapEval } from './memory-llm-ops'
import { MEMORY_FILENAME, parseMemoryDoc, renderForPrompt } from './memory/curated-doc'
import { readDraftForPrompt } from './memory/today-draft'
import { makeMemoryImportCommand } from './memory/import-command'
import { registerMemoryNightly } from './memory/nightly-lifecycle'
import { loadCompanionConfig } from './companion/config'
import { careLevel } from './companion/calibration'
import { companionOfferEligible } from './companion/offer-eligibility'
import { registerCompanionPush, registerCompanionIntrospect, registerIngest } from './companion/lifecycle'
import { makeLlmHealth, type LlmHealth } from './llm-health'
import { wireCliSessions } from './bootstrap/wire-cli-sessions'
import { wireActivity } from './bootstrap/wire-activity'
import { wireJobs } from './bootstrap/wire-jobs'
import { wireWorkbench } from './bootstrap/wire-workbench'
import { wireWorkbenchNotifications } from './bootstrap/wire-workbench-notifications'
import { wireWorkbenchArtifacts } from './bootstrap/wire-workbench-artifacts'
import { wireLetters } from './bootstrap/wire-letters'
import { makeProjectLessonsCommand } from './project-lessons-command'
import { agendaReplyText, appBundleHasCalendarUsage, makeCalendar, makeCalendarCommand } from './calendar/calendar'
import { fromReplyHandler } from './commands/registry'
import { defaultRunner, makeCliReplyHandler } from './cli-reply-handler'
import { makeCliPhoneActions } from './cli-phone-actions'
import { liveSessionIds } from './claude-live-window'
import { scopedSend } from './inbound/reply-scope'
import { makeRemoteReply } from './cli-remote-reply'
import { wireMain, type WiredDeps } from './wiring'
import { buildInboundPipeline, type AppTurn } from './inbound/build'
import type { PipelineRun } from './inbound/types'
import { startPendingFlush } from './speech/pending-notices'
import { registerSessions } from './sessions-lifecycle'
import { registerIlink } from './ilink-lifecycle'
import { registerPolling, type PollingLifecycle } from './polling-lifecycle'
import { startCliUpgrade } from './cli-upgrade/start'
import { registerReminders, sendReminderVia } from './reminders/sweeper'
import { makeRemindersStore } from './reminders/store'
import { registerReportSweeper, sendReportVia } from './reports/sweeper'
import { runStartupSweeps } from './startup-sweeps'
import { isHeartbeatFresh } from './single-instance'

/** boot-api 交出去的:靠 bootstrap 才有的 LLM 体检。 */
interface BootApi { llmHealth: LlmHealth }
type CliSessions = ReturnType<typeof wireCliSessions>
/** 「主人的命令」那一组:定时 / 日历 / 做过的事 / 经验 / 导入记忆 / 终端会话(命令表里的顺序就是优先级)。 */
interface OwnerCommands {
  commands: ReturnType<typeof fromReplyHandler>[]
  jobs: ReturnType<typeof wireJobs>
  activity: ReturnType<typeof wireActivity>
}
interface CliUpgradeModule { upgrader(): CliUpgrader | null }

export function daemonModules(f: Foundation): DaemonModule[] {
  const { stateDir, dangerously, db } = f
  const ownerChatId = () => resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null)
  const isOwner = (chatId: string) => ownerChatId() === chatId

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
    {
      name: 'ilink-adapter',
      needs: ['network-gate'],
      lazy: ['wired'],
      init(ctx): IlinkAdapter {
        const wired = ctx.late<WiredDeps>('wired')
        return makeIlinkAdapter({ stateDir, accounts: f.accounts, db, conversationStore: f.conversationStore, networkGate: ctx.get<GuardRuntime>('network-gate').gate, speech: () => wired()?.speech ?? null })
      },
    } satisfies DaemonModule<IlinkAdapter>,

    // —— 回复交付(spec 2026-10-03-reply-delivery):daemon 负责送达的那一条路,必须是同一个实例 ——
    {
      name: 'reply-delivery',
      needs: ['ilink-adapter'],
      init(ctx) {
        const ilink = ctx.get<IlinkAdapter>('ilink-adapter')
        return makeReplyDeliveryRuntime({
          sendText: (c, t) => ilink.sendMessage(c, t),
          sink: { captureReply: (c, r) => f.replySinks.captureReply?.(c, r) ?? false },
          isSinkOpen: (c) => f.replySinks.isOpen?.(c) ?? false,
          observe: (c, t) => f.outboundTaps.observe(c, t),
          chatPrefs: (c) => f.chatPrefs.get(c),
          log: (t, l, x) => log(t, l, x),
        })
      },
    } satisfies DaemonModule<ReturnType<typeof makeReplyDeliveryRuntime>>,

    // —— internal API:bootstrap 要它的 baseUrl / token 去配 MCP,所以在 init 段就监听(桌面这时来问 ⇒ 「还没有」)——
    {
      name: 'internal-api',
      needs: ['ilink-adapter', 'reply-delivery', 'network-gate'],
      lazy: ['bootstrap', 'polling', 'wired'],
      async init(ctx): Promise<InternalApiLifecycle> {
        const ilink = ctx.get<IlinkAdapter>('ilink-adapter')
        const guardRt = ctx.get<GuardRuntime>('network-gate')
        const boot = ctx.late<Bootstrap>('bootstrap')
        const polling = ctx.late<LifecycleHolder<PollingLifecycle>>('polling')
        const wired = ctx.late<WiredDeps>('wired')
        const api: InternalApiLifecycle = await registerInternalApi({
          stateDir, daemonPid: process.pid, memory: f.memoryFS, db, projects: ilink.projects,
          atelier: makeAtelierStore(stateDir),
          getChatPrefs: (c) => f.chatPrefs.get(c),
          setChatPref: (c, p) => f.chatPrefs.set(c, p),
          stickers: f.stickerLib,
          stickerFeedback: f.stickerFeedback,
          stickerSource: f.stickerSource,
          replySinks: f.replySinks,
          outboundTaps: f.outboundTaps,
          replyDelivery: ctx.get('reply-delivery'),
          hunt: f.huntStore,
          // 待决权限的桌面面(spec §6)。和微信「y/n <hash>」共用 ilink 里那一份 PendingPermissions ——
          // 从哪边拍板都算数。拍板本身也是「主人刚跟我说过话」的证据,所以成功时记一笔 contact。
          permissions: {
            list: () => ilink.listPendingPermissions(),
            resolve: (h, d) => { const ok = ilink.resolvePermission(h, d); if (ok) f.petSignals.noteContact(); return ok },
          },
          // 自改流水线的三个抓手(spec 2026-09-18-self-change-pipeline §daemon 侧):流水线是 daemon 外面的 CLI 进程,
          // 「报进展 / 问 y-n / 查拍板」都经这里回来;卡片和微信、桌面共用同一份 PendingPermissions。
          selfChange: makeSelfChangeGlue({
            ownerChatId: () => loadCompanionConfig(stateDir).default_chat_id ?? null,
            speech: () => wired()?.speech ?? null,
            // 只登记、自己发卡:卡片发不出去时条目要留在登记处,好让主人从桌面权限卡或 `self change --approve <id>` 拍板。
            registerPending: (h, t, meta) => ilink.registerPendingPermission(h, t, meta),
            sweepPending: () => { ilink.sweepPendingPermissions() },
            codeOf: (h) => ilink.pendingPermissionCodeOf(h),
            newHash: () => randomBytes(8).toString('hex'),
            now: () => Date.now(),
            log: (line) => { log('SELF-CHANGE', line) },
          }),
          // chat_history 工具后端(provider-handoff 的逃生口)
          messages: { listRange: (c: string, o: { limit: number; beforeTs?: string }) => f.messagesStore.listRange(c, o), search: (c: string, q: string, l: number) => f.messagesStore.search(c, q, l) },
          // 桌宠「主人真在跟我说话吗」:只认入站(伙伴自己的外发会 bump lastUsedAt,但不该让熊说「在跟你聊」)。
          latestInboundTs: (c: string) => f.messagesStore.latestInboundTs(c),
          setUserName: (chatId, name) => ilink.setUserName(chatId, name),
          voice: { replyVoice: (c, t) => ilink.voice.replyVoice(c, t), saveConfig: (i) => ilink.voice.saveConfig(i), configStatus: () => ilink.voice.configStatus(), synthesizeSpeech: (t) => ilink.voice.synthesizeSpeech(t), transcribe: (a, m) => ilink.voice.transcribe!(a, m), saveSTTConfig: (i) => ilink.voice.saveSTTConfig!(i), sttStatus: () => ilink.voice.sttStatus!() },
          sharePage: (t, c, o) => ilink.sharePage(t, c, o), resurfacePage: (q) => ilink.resurfacePage(q),
          companion: { enable: () => ilink.companion.enable(), disable: () => ilink.companion.disable(), status: () => ilink.companion.status(), snooze: (m) => ilink.companion.snooze(m), setImportLocal: (e) => ilink.companion.setImportLocal(e) },
          ilink: { sendReply: (c, t) => ilink.sendMessage(c, t).then(r => r as { msgId: string; error?: string }), sendFile: (c, p) => ilink.sendFile(c, p), noteSentMedia: (c, m) => ilink.noteSentMedia?.(c, m), editMessage: (c, m, t) => ilink.editMessage(c, m, t), broadcast: (t, a) => ilink.broadcast(t, a) },
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
          outbound: () => ilink.outboundHealth(),
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

    // —— bootstrap:provider registry / 会话管理 / 协调器 + 可选的知识库 / 社交 / A2A / 配对 / 乙(一组模块,bootstrap/index.ts)——
    ...bootstrapModules({
      needs: ['ilink-adapter', 'reply-delivery', 'internal-api', 'network-gate'],
      lazy: ['cli-upgrade', 'workbench', 'wired'],
      deps: (ctx) => {
        const ilink = ctx.get<IlinkAdapter>('ilink-adapter')
        const internalApi = ctx.get<InternalApiLifecycle>('internal-api')
        const guardRt = ctx.get<GuardRuntime>('network-gate')
        const cliUpgrade = ctx.late<CliUpgradeModule>('cli-upgrade')
        const workbench = ctx.late<WorkbenchService>('workbench')
        const wired = ctx.late<WiredDeps>('wired')
        return {
          stateDir, db, ilink, loadProjects: ilink.loadProjects, networkGate: guardRt.gate,
          // CC 开口那道门在 wired 里才造;bootstrap 里的社交通知比它早接线、晚发 ⇒ 现取。
          speech: () => wired()?.speech ?? null,
          // 工作台正占着这个目录 / 原生会话 ⇒ 会话管理拒 acquire;工作台还没起 ⇒ 不冲突。
          executionGuard: (path, providerId, nativeId) => workbench()?.conflictsExternal(path, providerId, nativeId) ?? false,
          lastActiveChatId: ilink.lastActiveChatId, log: (t, l, x) => log(t, l, x),
          fallbackProject: () => ({ alias: '_default', path: process.cwd() }),
          dangerouslySkipPermissions: dangerously, conversationStore: f.conversationStore,
          replySinks: f.replySinks,
          outboundTaps: f.outboundTaps,
          replyDelivery: ctx.get('reply-delivery'),
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
          ...promptReads(f),
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
      init(ctx): BootApi {
        const boot = ctx.get<Bootstrap>('bootstrap')
        const internalApi = ctx.get<InternalApiLifecycle>('internal-api')
        internalApi.provide({ delegate: { dispatchOneShot: boot.dispatchDelegate, knownPeers: () => boot.registry.list() } })
        internalApi.provide({ conversation: { setMode: (chatId, mode) => boot.coordinator.setMode(chatId, mode) } })
        // 可选子系统没起(配置没开 / 降级)⇒ 不 provide,对应路由照旧 503。
        if (boot.a2aDeps) internalApi.provide({ a2a: boot.a2aDeps })
        if (boot.social) internalApi.provide({ social: boot.social })
        if (boot.knowledge) internalApi.provide({ knowledge: boot.knowledge })
        if (boot.pairing) internalApi.provide({ pairing: boot.pairing })
        // daemon 自己跑的 LLM 记忆操作(spec 2026-07-23):这里是唯一跑它们的地方(不在编译出来的 CLI 里)。
        internalApi.provide({ memoryLlm: makeMemoryLlmOps({ stateDir, db, getMode: (c) => boot.coordinator.getMode(c), registry: boot.registry }) })
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

    // —— 终端会话(重构第二批步 6c,bootstrap/wire-cli-sessions.ts)——
    {
      name: 'cli-sessions',
      needs: ['bootstrap', 'ilink-adapter', 'internal-api', 'network-gate'],
      lazy: ['workbench', 'wired'],
      init(ctx): CliSessions {
        const wired = ctx.late<WiredDeps>('wired')
        const workbench = ctx.late<WorkbenchService>('workbench')
        return wireCliSessions({
          speech: () => wired()?.speech ?? null,
          stateDir, dangerously, db, ilink: ctx.get('ilink-adapter'), own: (n, s) => ctx.own(n, s),
          internalApi: ctx.get('internal-api'), boot: ctx.get<Bootstrap>('bootstrap'), networkGate: ctx.get<GuardRuntime>('network-gate').gate,
          workbench: () => workbench(),
          appPush: () => wired()?.appPush ?? null,
          jobsSince: (since) => summarizeJobs(f.jobsStore, since),
        })
      },
    } satisfies DaemonModule<CliSessions>,

    // —— 主人的命令:命令现在就要(进命令表),要用的只读轮 / 工作台 / 门都在后面 ⇒ 经 late 现取 ——
    {
      name: 'owner-commands',
      needs: ['bootstrap', 'cli-sessions', 'ilink-adapter', 'internal-api', 'network-gate'],
      lazy: ['workbench', 'wired'],
      init(ctx): OwnerCommands {
        const boot = ctx.get<Bootstrap>('bootstrap')
        const ilink = ctx.get<IlinkAdapter>('ilink-adapter')
        const internalApi = ctx.get<InternalApiLifecycle>('internal-api')
        const cli = ctx.get<CliSessions>('cli-sessions')
        const workbench = ctx.late<WorkbenchService>('workbench')
        const wired = ctx.late<WiredDeps>('wired')
        const say = (c: string, t: string) => ilink.sendMessage(c, t)
        // 「CC 做过的事」:手机时间线 / 微信「做过的事」/ 周报共用一组来源。
        const activity = wireActivity({ stateDir, db, ilink, permissionDecisions: cli.permissionDecisions, cliEvents: cli.cliEvents, jobsStore: f.jobsStore })
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
        // 读日历和提醒(只读,spec 2026-10-20-calendar-read-design):默认关;「日历 开」才请求授权。只进主人的轮次。
        const calendar = makeCalendar({
          stateDir, run: defaultRunner, platform: process.platform,
          bundleHasUsage: () => appBundleHasCalendarUsage(process.execPath),
          now: () => Date.now(), timezone: () => loadCompanionConfig(stateDir).timezone ?? 'Asia/Shanghai',
          log: (t, l) => log(t, l),
        })
        internalApi.provide({ calendarAgenda: (offset) => agendaReplyText(calendar, offset) })
        const calendarCommand = makeCalendarCommand({ calendar, isOwner, say })
        // 定时 / 早报 / 周报 / 换一家来审(bootstrap/wire-jobs.ts):runner 在 scheduled-jobs 模块里起。
        const jobs = wireJobs({
          stateDir, db, ilink, boot, jobsStore: f.jobsStore, activityLog: activity.activityLog, activity: activity.activity, calendar, overseerToday: cli.overseerToday, careLedger: f.careLedger,
          quietWindow: () => { const o = ownerChatId(); return o ? f.chatPrefs.get(o).quiet : undefined },
          // async:没就绪时是一个被拒的 promise,不是同步抛 —— requestReview 的 .catch 接得住,照实告诉主人「没审成」
          runJobTurn: async (a) => { const w = wired(); if (!w) throw new Error('jobs_not_wired'); return w.ticks.runJobTurn(a) },
          // 定时那边的一句(连续失败被暂停 …)经 CC 开口那道门(第三批 3a,job_notice 归 report)
          sendProactive: (chatId, text, kind = 'job_notice') => {
            const w = wired()
            if (!w) { log('JOBS', `proactive send dropped (not wired yet) chat=${chatId}`); return }
            void w.speech.tell(kind, chatId, text)
          },
        })
        const a2a = boot.a2aDeps
        const cliReplyHandler = makeCliReplyHandler({
          executionConflict: cli.executionConflict, reserveExecution: cli.reserveExecution,
          hub: cli.cliEvents,
          isOwner,
          sendMessage: scopedSend((c: string, t: string) => ilink.sendMessage(c, t)),
          sharePage: async (title, md, chatId) => (await ilink.sharePage(title, md, { chat_id: chatId })).url,
          holdBusy: (l) => boot.holdBusy(l),
          log: (t, l) => log(t, l),
          dangerously,
          networkGate: ctx.get<GuardRuntime>('network-gate').gate,
          liveWindow: cli.liveWindow, startCwd: cli.startCwd,
          localMachine: osHostname(),
          listSessions: () => cli.cliSessionViews({ limit: 50 }),
          today: cli.overseerToday,
          ...(a2a ? { remote: makeRemoteReply({ registry: a2a.registry, client: a2a.client, selfId: boot.selfId }) } : {}),
        })
        return {
          jobs, activity,
          // 命令表的顺序就是优先级(重构第二批步 2;与原来文本命令链的顺序一致)
          commands: [fromReplyHandler('jobs', jobs.command), fromReplyHandler('calendar', calendarCommand), fromReplyHandler('activity', activity.command), fromReplyHandler('lessons', lessonsCommand), fromReplyHandler('memory-import', memoryImportCommand), fromReplyHandler('cli', cliReplyHandler, { ownsSlash: (m) => /^\s*\/(?:cli|today)\s*[?？]?\s*$/i.test(m.text ?? '') })],
        }
      },
    } satisfies DaemonModule<OwnerCommands>,

    // —— 工作台(「一起做」)——
    {
      name: 'workbench',
      needs: ['bootstrap', 'cli-sessions', 'owner-commands', 'ilink-adapter', 'internal-api', 'network-gate'],
      lazy: ['cli-upgrade'],
      init(ctx): WorkbenchService {
        const boot = ctx.get<Bootstrap>('bootstrap')
        const cli = ctx.get<CliSessions>('cli-sessions')
        const { jobs } = ctx.get<OwnerCommands>('owner-commands')
        const ilink = ctx.get<IlinkAdapter>('ilink-adapter')
        const internalApi = ctx.get<InternalApiLifecycle>('internal-api')
        const cliUpgrade = ctx.late<CliUpgradeModule>('cli-upgrade')
        const service = wireWorkbench({
          db, stateDir, boot, internalApi, matters: f.matters, reportOutbox: f.reportOutbox, networkGate: ctx.get<GuardRuntime>('network-gate').gate, permissionGate: cli.permissionGate, requestReview: (r) => jobs.requestReview(r),
          onTurnError: (providerId, code, message) => {
            cliUpgrade()?.upgrader()?.onTurnError(providerId, code, message)
            // 一起做里被拒也算(只有 agy 用一起做时,大脑那一行不该落后)
            f.providerRefusals.onTurn({ provider: providerId, outcome: 'error', ...(code ? { errorCode: code } : {}), endedAt: Date.now() })
          },
          onTurnCompleted: (providerId) => f.providerRefusals.onTurn({ provider: providerId, outcome: 'completed', endedAt: Date.now() }),
          providerRefusal: (providerId) => f.providerRefusals.get(providerId),
          executionConflict: (path, providerId, nativeId) => boot.sessionManager.hasProjectConflict(path) ||
            (!!nativeId && Object.values(boot.sessionStore.all()).some(s => s.provider === providerId && s.session_id === nativeId)) ||
            cli.legacyClaims.conflicts({ owner: 'workbench', path, providerId, nativeId }) ||
            (!!nativeId && cli.cliEvents.sessions().some(s => s.source === providerId && s.session_id === nativeId && !!s.origin_agent)),
          askUser: ilink.askUser, log: (t, l) => log(t, l),
        })
        ctx.own('stop', () => service.shutdown())
        internalApi.provide({ workbench: service })
        return service
      },
    } satisfies DaemonModule<WorkbenchService>,

    // —— wireMain:入站管道的依赖、伙伴 tick、手机那一簇、CC 开口那道门 ——
    {
      name: 'wired',
      needs: ['bootstrap', 'boot-api', 'cli-sessions', 'owner-commands', 'workbench', 'ilink-adapter', 'reply-delivery', 'internal-api', 'network-gate'],
      lazy: ['pipeline', 'polling', 'companion.ingest'],
      init(ctx): WiredDeps {
        const boot = ctx.get<Bootstrap>('bootstrap')
        const { llmHealth } = ctx.get<BootApi>('boot-api')
        const cli = ctx.get<CliSessions>('cli-sessions')
        const owner = ctx.get<OwnerCommands>('owner-commands')
        const workbench = ctx.get<WorkbenchService>('workbench')
        const ilink = ctx.get<IlinkAdapter>('ilink-adapter')
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
          activity: owner.activity.activity, activityLog: owner.activity.activityLog,
          overseerToday: cli.overseerToday,
          terminalHooks: cli.terminalHooks,
          // 手机拍板 / 说一句:拍板与微信「y/n 码」、桌宠权限卡同一份待批;说一句与微信「@码」同一个 core。
          cliActions: makeCliPhoneActions({
            hub: cli.cliEvents, relay: cli.cliPermissions, core: cli.replyCore, localMachine: osHostname(), log: (t, l) => log(t, l), liveIds: () => liveSessionIds(),
            resolve: (h, d) => { const ok = ilink.resolvePermission(h, d); if (ok) f.petSignals.noteContact(); return ok },
          }),
          matters: f.matters, guardRuntime: guardRt, subsystems: () => f.sup.statuses(), providerRefusals: () => f.providerRefusals.all(),
          panelTokens: internalApi.panelTokens,
          commands: owner.commands,
          stickers: f.stickerLib,
          requestRestart: (reason) => f.requestRestart(reason),
          llmHealth,
          stateDir, db, ilink, accounts: f.accounts, boot, dangerously, chatPrefs: f.chatPrefs, careLedger: f.careLedger, replySinks: f.replySinks,
          outboundTaps: f.outboundTaps, huntStore: f.huntStore, petSignals: f.petSignals, replyDelivery: ctx.get('reply-delivery'),
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
        internalApi.provide({ phoneConnect: wired.phoneConnect })
        internalApi.provide({ memoryNightly: wired.memoryNightly })
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
    lifecycleModule('companion.push', (ctx) => registerCompanionPush(ctx.get<WiredDeps>('wired').companionPushDeps), { needs: ['wired'] }),
    lifecycleModule('companion.introspect', (ctx) => registerCompanionIntrospect(ctx.get<WiredDeps>('wired').companionIntrospectDeps), { needs: ['wired'] }),
    lifecycleModule('companion.ingest', (ctx) => registerIngest(ctx.get<WiredDeps>('wired').companionIngestDeps), { needs: ['wired'] }),
    lifecycleModule('guard', (ctx) => registerGuard(ctx.get<WiredDeps>('wired').guardDeps), { needs: ['wired'] }),
    // 外部 CLI provider 的退避重探计时器(2026-10-04)—— 关停时别再起探测、别再晚注册。
    {
      name: 'provider-probes',
      needs: ['bootstrap'],
      init(ctx) { const boot = ctx.get<Bootstrap>('bootstrap'); ctx.own('stop', () => boot.stopProviderProbes?.()) },
    },
    lifecycleModule('sessions', (ctx) => registerSessions(ctx.get<WiredDeps>('wired').sessionsDeps), { required: true, needs: ['wired'] }),
    lifecycleModule('ilink', (ctx) => registerIlink(ctx.get<WiredDeps>('wired').ilinkDeps), { required: true, needs: ['wired'] }),
    // 工作台的微信通知 / 成果:**停**在 polling 之后(关机时先停入站,再把任务那几句送完,再冲 ilink);
    // **开动**却放在开机最后(startup-sweeps 那一步):补发停机期间做完的任务那几句,要排在「CC 回来了」之后。
    {
      name: 'workbench-notifications',
      needs: ['workbench', 'wired', 'ilink-adapter'],
      init(ctx): Deferred {
        let n: ReturnType<typeof wireWorkbenchNotifications> | null = null
        ctx.own('stop', async () => { await n?.close() })
        return { start: () => {
          n = wireWorkbenchNotifications({ workbench: ctx.get('workbench'), ilink: ctx.get('ilink-adapter'), speech: ctx.get<WiredDeps>('wired').speech })
          void n.wake().catch(() => log('WORKBENCH', 'Task notifications are waiting for storage recovery.'))
        } }
      },
    } satisfies DaemonModule<Deferred>,
    {
      name: 'workbench-artifacts',
      needs: ['workbench', 'ilink-adapter'],
      init(ctx): Deferred {
        let a: ReturnType<typeof wireWorkbenchArtifacts> | null = null
        ctx.own('stop', async () => { await a?.close() })
        return { start: () => { a = wireWorkbenchArtifacts({ workbench: ctx.get('workbench'), ilink: ctx.get('ilink-adapter') }) } }
      },
    } satisfies DaemonModule<Deferred>,
    lifecycleModule('polling', (ctx) => registerPolling({ ...ctx.get<WiredDeps>('wired').pollingDeps, runPipeline: ctx.get<PipelineModule>('pipeline').run }), { required: true, needs: ['wired', 'pipeline'] }),
    // 每晚整理长期记忆 memory.md(2026-09-25)。15 分钟一次「该不该跑」。
    lifecycleModule('memory-nightly', (ctx) => registerMemoryNightly({
      runtime: ctx.get<WiredDeps>('wired').memoryNightly, holdBusy: (l) => ctx.get<Bootstrap>('bootstrap').holdBusy(l), log: (t, l) => log(t, l),
    }), { needs: ['wired', 'bootstrap'] }),
    // CC 的信(2026-10-16):不定期写一封信、排成信纸寄到微信;开关 companion.letters_enabled 默认关。
    {
      name: 'letters',
      optional: true,
      needs: ['bootstrap', 'wired', 'ilink-adapter', 'internal-api'],
      init(ctx) {
        const boot = ctx.get<Bootstrap>('bootstrap')
        const wired = ctx.get<WiredDeps>('wired')
        const ilink = ctx.get<IlinkAdapter>('ilink-adapter')
        const letters = wireLetters({
          stateDir, db,
          providerFor: (c) => { const m = boot.coordinator.getMode(c); return m && m.kind === 'solo' ? m.provider : undefined },
          strongEval: (id) => (typeof boot.registry.getStrongEval === 'function' ? boot.registry.getStrongEval(id as never) : null),
          cheapEval: (c) => resolveCheapEval({ getMode: (x) => boot.coordinator.getMode(x), registry: boot.registry }, c),
          wechatSuspended: () => boot.health.health.shouldSuspend('wechat'),
          speech: wired.speech,
          sendText: (c, t) => ilink.sendMessage(c, t),
          // 逐页发不逐页记;寄出之后整封记成主人对话里的一行(App 对话页看得见),微信不通时寄到 App(2026-10-18)。
          sendFile: (c, file) => ilink.sendFile(c, file, { mirror: false }),
          mirror: (c, pages) => ilink.noteSentMedia?.(c, pages.map(path => ({ kind: 'file' as const, path }))),
          app: () => wired.companionApp,
          holdBusy: (l) => boot.holdBusy(l), log: (t, l) => log(t, l),
        })
        ctx.get<InternalApiLifecycle>('internal-api').provide({ letters: letters.runtime })
        let lc: Lifecycle | null = null
        ctx.onStart('start', () => { lc = letters.start() })
        ctx.own('stop', () => lc?.stop())
      },
    },
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
    // 提醒(spec 2026-08-20-reminders-port):精确到点送达;走 SpeechPolicy(requested:免打扰照发),两条路都送不到 ⇒ 留着。
    lifecycleModule('reminders', (ctx) => registerReminders({
      store: makeRemindersStore(db),
      send: sendReminderVia(ctx.get<WiredDeps>('wired').speech, (t, l) => log(t, l)),
      log: (t, l) => log(t, l),
      activityLog: ctx.get<OwnerCommands>('owner-commands').activity.activityLog,
      isOwner,
    }), { needs: ['wired', 'owner-commands'] }),
    // 定时任务每分钟一拍(wire-jobs.ts):坏了只降级。
    lifecycleModule('scheduled-jobs', (ctx) => ctx.get<OwnerCommands>('owner-commands').jobs.startRunner(), { needs: ['owner-commands', 'wired'] }),
    // 回报投递(task-3,2026-09-23):每轮答复回原对话说一声,人不在就等人回来再送。
    lifecycleModule('reports', (ctx) => {
      // 独立的一份 WorkbenchStore,只用来给「放弃投递」在那件事自己的时间线上留一笔(同一个 db,写入互相可见)。
      const reportEventStore = makeWorkbenchStore(db)
      return registerReportSweeper({
        store: f.reportOutbox,
        matters: f.matters,
        send: sendReportVia(ctx.get<WiredDeps>('wired').speech),
        log: (t, l) => log(t, l),
        noteAbandoned: (matterId, text) => {
          try { reportEventStore.addEvent(matterId, 'system', text) } catch { /* best effort — the drop itself already succeeded */ }
        },
      })
    }, { needs: ['wired'] }),
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

/** 每次起会话时现读的提示词素材(人格、记忆、贴纸、关心档 ……):手改了文件,不用重启就生效。 */
function promptReads(f: Foundation) {
  const { stateDir, db } = f
  const memoryOf = (c: string) => makeMemoryFS({ rootDir: join(stateDir, 'memory', c) })
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
    stickerTagsFor: (c: string) => (f.chatPrefs.get(c).stickers !== false ? f.stickerLib.allTags() : null),
    // persona design §2 — owner chat's persona.md, read fresh per spawn; cultivate only in the owner's own chat.
    personaFor: (c: string) => {
      const ownerChat = loadCompanionConfig(stateDir).default_chat_id
      if (!ownerChat) return {}
      // ownerChat feeds a filesystem join below, so accept only chatId-shaped values.
      if (ownerChat.includes('..') || ownerChat.includes('/') || ownerChat.includes('\\')) return {}
      return { content: memoryOf(ownerChat).read('persona.md') ?? undefined, cultivate: c === ownerChat }
    },
    // core-memory-injection design §2 — THIS chat's OWN profile.md excerpt, capped.
    coreMemoryFor: (c: string) => {
      const profile = memoryOf(c).read('profile.md') ?? ''
      return profile.length > CORE_MEMORY_MAX_CHARS ? profile.slice(0, CORE_MEMORY_MAX_CHARS) : profile
    },
    // 每晚整理的长期记忆(2026-09-25):有 memory.md 就注入它(去尾注),prompt-builder 据此不再注入 profile.md。
    curatedMemoryFor: (c: string) => {
      const raw = memoryOf(c).read(MEMORY_FILENAME)
      return raw ? renderForPrompt(parseMemoryDoc(raw)) : ''
    },
    // 主人原话(记忆编辑设计稿 2026-10-23 §1):只在主人自己的对话里注入,访客 / trusted 的对话读不到。
    ownerMemoryFor: (c: string) => {
      if (c !== loadCompanionConfig(stateDir).default_chat_id) return ''
      return renderOwnerForPrompt(readOwnerDoc(join(stateDir, 'memory', c)))
    },
    // 今天的草稿(同日失忆修复,2026-10-01):CC 白天写进 profile.md 的新行,随 memory.md 一起注入。
    todayDraftFor: (c: string) => { try { return readDraftForPrompt(f.memoryFS, c) } catch { return '' } },
    // knowledge-distillation §2 — THIS chat's daemon-distilled knowledge.md, capped.
    knowledgeMemoryFor: (c: string) => {
      const k = memoryOf(c).read('knowledge.md') ?? ''
      return k.length > KNOWLEDGE_MEMORY_MAX_CHARS ? k.slice(0, KNOWLEDGE_MEMORY_MAX_CHARS) : k
    },
  }
}
