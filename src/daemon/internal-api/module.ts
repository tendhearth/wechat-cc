/**
 * internal API 接进 daemon 的那一份:bootstrap 要它的 baseUrl / token 去配 MCP,所以在 init 段就监听(桌面这时来问 ⇒ 「还没有」)。
 * 只有模块表 daemon-modules.ts 引这个文件。
 */
import { randomBytes } from 'node:crypto'
import { log } from '../../lib/log'
import { loadCompanionConfig } from '../../lib/companion-config'
import { APP_VERSION, BUILD_SHA } from '../../lib/app-version'
import type { DaemonModule } from '../modules/container'
import type { LifecycleHolder } from '../modules/lifecycle-module'
import type { Foundation } from '../foundation'
import type { GuardRuntime } from '../guard/runtime'
import type { Bootstrap } from '../bootstrap'
import type { WiredDeps } from '../wiring'
import type { PollingLifecycle } from '../polling-lifecycle'
import { WECHAT_PORTS as W, type WechatContacts, type WechatLinkStatus, type WechatPages, type WechatPermissions, type WechatSend } from '../../ports/wechat'
import { makeSelfChangeGlue } from '../self-change-glue'
import { runSelftestConverse } from '../selftest'
import { providerDisplayName } from '../provider-display-names'
import { isHeartbeatFresh } from '../single-instance'
import { ownerChatIdOf } from '../owner-chat'
import { registerInternalApi, type InternalApiLifecycle } from './lifecycle'

export function internalApiModule(f: Foundation): DaemonModule<InternalApiLifecycle> {
  const { stateDir, dangerously, db } = f
  const ownerChatId = () => ownerChatIdOf(stateDir)
  return {
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
  } satisfies DaemonModule<InternalApiLifecycle>
}
