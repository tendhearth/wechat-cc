/**
 * wireMain 接进 daemon 的那一份:`wired`(入站管道的依赖、伙伴 tick、手机那一簇、CC 开口那道门)、入站管道 `pipeline`、
 * 会话起停 `sessions`、开机最后一步 `startup-sweeps`。只有模块表 daemon-modules.ts(和别的平台 module.ts 引类型)引这个文件。
 */
import { log } from '../../lib/log'
import { loadAccess } from '../../lib/access'
import type { Lifecycle } from '../../lib/lifecycle'
import { pick } from '../../lib/pick'
import type { WorkbenchService } from '../../features/workbench'
import type { registerIngest } from '../../features/companion'
import type { TerminalFeature } from '../../features/terminal'
import type { StickersFeature } from '../../features/stickers'
import { WECHAT_PORTS as W, type WechatAccounts, type WechatContacts, type WechatLinkStatus, type WechatPages, type WechatPermissions, type WechatPolling, type WechatSend, type WechatVoice } from '../../ports/wechat'
import type { DaemonModule } from '../modules/container'
import { lifecycleModule, type LifecycleHolder } from '../modules/lifecycle-module'
import type { Foundation } from '../foundation'
import type { GuardRuntime } from '../guard/runtime'
import type { Bootstrap } from '../bootstrap'
import type { BootApi } from '../bootstrap/module'
import type { InternalApiLifecycle } from '../internal-api/lifecycle'
import type { OwnerCommands } from '../commands/module'
import type { Activity } from '../bootstrap/wire-activity'
import type { PollingLifecycle } from '../polling-lifecycle'
import { buildInboundPipeline, type AppTurn } from '../inbound/build'
import type { PipelineRun } from '../inbound/types'
import { startPendingFlush } from '../speech/pending-notices'
import { registerSessions } from '../sessions-lifecycle'
import { runStartupSweeps } from '../startup-sweeps'
import { wireMain, type WiredDeps } from './index'

export interface PipelineModule { run: PipelineRun; appTurn: AppTurn }

/** 造好了、但开动的时刻由别的模块定(工作台通知要排在开机清扫之后)。 */
interface Deferred { start(): void }

export function wiredModule(f: Foundation): DaemonModule<WiredDeps> {
  const { stateDir, dangerously, db } = f
  return {
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
  } satisfies DaemonModule<WiredDeps>
}

export function pipelineModule(): DaemonModule<PipelineModule> {
  return {
    name: 'pipeline',
    needs: ['wired'],
    init(ctx): PipelineModule {
      const p = buildInboundPipeline(ctx.get<WiredDeps>('wired').pipelineDeps)
      return { run: p, appTurn: p.appTurn }
    },
  } satisfies DaemonModule<PipelineModule>
}

export function sessionsModule() {
  return lifecycleModule('sessions', (ctx) => registerSessions(ctx.get<WiredDeps>('wired').sessionsDeps), { required: true, needs: ['wired'] })
}

/** 开机的最后一步:一次性清扫(fire-and-forget,含「CC 回来了」),然后才开动工作台的通知 / 成果。 */
export function startupSweepsModule(f: Foundation): DaemonModule {
  return {
    name: 'startup-sweeps',
    needs: ['wired', 'workbench-notifications', 'workbench-artifacts'],
    init(ctx) {
      ctx.onStart('run', () => {
        runStartupSweeps({ ...ctx.get<WiredDeps>('wired').startupDeps, previousRun: f.previousRun })
        ctx.get<Deferred>('workbench-notifications').start()
        ctx.get<Deferred>('workbench-artifacts').start()
      })
    },
  }
}
