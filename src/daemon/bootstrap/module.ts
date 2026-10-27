/**
 * bootstrap 那一组接进 daemon 的那一份:provider registry / 会话管理 / 协调器 + 可选的知识库 / 社交 / A2A / 配对 / 乙
 * (一组模块,./index.ts 的 bootstrapModules),把它的产物交给 internal-api 路由的 `boot-api`,外部 CLI 重探计时器 `provider-probes`。
 * 只有模块表 daemon-modules.ts 引这个文件。
 */
import { log } from '../../lib/log'
import { loadAccess } from '../../lib/access'
import { loadCompanionConfig } from '../../lib/companion-config'
import { countInboundMessagesSync, NEW_RELATIONSHIP_MSG_COUNT } from '../../lib/messages-store'
import { pick } from '../../lib/pick'
import { resolveTier } from '../../domain/user-tier'
import { SUPERVISED_ENV } from '../../domain/supervised-env'
import { capabilitiesFor } from '../../domain/capability-matrix'
import { WECHAT_PORTS as W, type WechatAccounts, type WechatCompanionControls, type WechatPermissions, type WechatSend } from '../../ports/wechat'
import type { WorkbenchService } from '../../features/workbench'
import { retractOnFactStatus, type MemoryFeature, type MemoryPromptReads } from '../../features/memory'
import { careLevel, companionOfferEligible } from '../../features/companion'
import type { TerminalFeature } from '../../features/terminal'
import type { StickersFeature } from '../../features/stickers'
import type { DaemonModule } from '../modules/container'
import type { Foundation } from '../foundation'
import type { GuardRuntime } from '../guard/runtime'
import type { InternalApiLifecycle } from '../internal-api/lifecycle'
import type { WiredDeps } from '../wiring'
import type { CliUpgradeModule } from '../cli-upgrade/start'
import { makeReplyDeliveryRuntime } from '../reply-delivery'
import { makeChatOwnerRules } from '../permission-gate'
import { makeLlmHealth, type LlmHealth } from '../llm-health'
import { ownerChatIdOf } from '../owner-chat'
import { bootstrapModules, type Bootstrap } from './index'

/** boot-api 交出去的:靠 bootstrap 才有的 LLM 体检。 */
export interface BootApi { llmHealth: LlmHealth }

export function bootstrapGroupModules(f: Foundation): DaemonModule[] {
  const { stateDir, dangerously, db } = f
  return bootstrapModules({
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
  })
}

/** 把 bootstrap 的产物交给 internal-api 的路由;LLM 通道体检。 */
export function bootApiModule(f: Foundation): DaemonModule<BootApi> {
  const ownerChatId = () => ownerChatIdOf(f.stateDir)
  return {
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
  } satisfies DaemonModule<BootApi>
}

/** 外部 CLI provider 的退避重探计时器(2026-10-04)—— 关停时别再起探测、别再晚注册。 */
export function providerProbesModule(): DaemonModule {
  return {
    name: 'provider-probes',
    needs: ['bootstrap'],
    init(ctx) { const boot = ctx.get<Bootstrap>('bootstrap'); ctx.own('stop', () => boot.stopProviderProbes?.()) },
  }
}

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
