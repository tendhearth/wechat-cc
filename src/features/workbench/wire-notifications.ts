import { makeWechatNotificationWorker, type WechatNoticeKind, type WechatNoticeSendResult, type WechatNotificationNotice } from '../../adapters/store/workbench/wechat-notifications'
import type { WorkbenchService } from './service'
import type { SpeechKind } from '../../domain/speech/kinds'
import type { WechatWorkbenchTransport } from '../../ports/wechat'
import type { SpeechPolicy } from '../../daemon/speech/policy'

/** 两条路都送不到时,多久再问一次门(只是本地判定,不碰网络;不算尝试)。 */
export const UNDELIVERABLE_RECHECK_MS = 60_000

/**
 * 工作台通知归哪一种话(第三批 3a):等主人批准 / 回答 ⇒ permission_ask(blocking,免打扰、别烦我都拦不住);
 * 这一轮做完 / 失败 / 中断 / 停下 ⇒ matter_report(report:免打扰里推到时段结束)。
 */
export function noticeSpeechKind(kind: WechatNoticeKind): SpeechKind {
  return kind === 'permission' || kind === 'question' ? 'permission_ask' : 'matter_report'
}

/**
 * 工作台的微信通知经 CC 开口那道门(第三批 3a)。`workbench_wechat_notices` 仍是持久层:
 *  - 门推后(免打扰 / 两条路都送不到)⇒ `postponed`:回到 pending、到时段结束(或一分钟后)再问,**不算尝试、不退避**;
 *    **不进**门的「待说」队列(这张表自己会重试,进了就是两份)。批准卡带着会过期的码:重试前 notificationEligible
 *    再核一次「还在等、没过期」,所以补发的永远不会是一个死码(权限在登记处等着,桌面 / 终端照样能拍)。
 *  - 门放行 ⇒ 微信能用走工作台自己的严格发送口(幂等 client_id、绑定核对、服务端回执),微信不能用 / 确定没发出去 ⇒
 *    落到 App(记进主人对话,不另推 —— phone-notifier 对同一件事已经推过原生通知)。
 */
export function wireWorkbenchNotifications(opts: {
  workbench: WorkbenchService
  ilink: Pick<WechatWorkbenchTransport, 'sendWorkbenchNotice' | 'chatAccountId'>
  speech: Pick<SpeechPolicy, 'say'>
  now?: () => number
}): {
  wake(context?: { ownerChatId: string; accountId: string }): Promise<void>
  close(): Promise<void>
} {
  const now = opts.now ?? Date.now
  /** 送之前那一道同步核对。不过 ⇒ 回拦下的理由。 */
  const blockedReason = (notice: WechatNotificationNotice): string | null => {
    if (!opts.workbench.notificationEligible(notice)) return 'ineligible'
    if (typeof opts.ilink.chatAccountId !== 'function' || opts.ilink.chatAccountId(notice.ownerChatId) !== notice.accountId) return 'binding_changed'
    return null
  }
  const worker = makeWechatNotificationWorker({
    store: opts.workbench.notificationStore,
    eligible: notice => opts.workbench.notificationEligible(notice),
    async send(notice, signal): Promise<WechatNoticeSendResult> {
      let out: WechatNoticeSendResult = { status: 'deferred', reason: 'not_sent' }
      // 核对失败就不必问门(也不记一行账)
      const early = blockedReason(notice)
      if (early) return { status: 'blocked', reason: early }
      const o = await opts.speech.say({ kind: noticeSpeechKind(notice.kind), chatId: notice.ownerChatId }, async (turn) => {
        // This check deliberately stays synchronous and adjacent to transport.
        // Awaiting between eligibility and send would let a resolved request,
        // mute, owner change, or account rebind become stale in the gap.
        const ready = (): boolean => {
          const why = blockedReason(notice)
          if (why) out = { status: 'blocked', reason: why }
          return why === null
        }
        if (!turn.sendTextWith) { out = { status: 'deferred', reason: 'no_own_sender' }; return }
        if (!ready()) return
        const r = await turn.sendTextWith(notice.ownerChatId, notice.text, async () => {
          if (!ready()) return 'final'
          if (typeof opts.ilink.sendWorkbenchNotice !== 'function') {
            out = { status: 'blocked', reason: 'transport_unavailable' }
            return 'not_sent'
          }
          const t = await opts.ilink.sendWorkbenchNotice(notice, signal)
          out = t
          return t.status === 'accepted' ? 'sent' : t.status === 'deferred' ? 'not_sent' : 'final'
        }, { silent: true, ready })
        if (r.channel === 'app') out = r.ok ? { status: 'accepted', reason: 'app' } : out.status === 'blocked' ? out : { status: 'deferred', reason: 'app_record_failed' }
      })
      if ('defer' in o) {
        const until = o.until ? Date.parse(o.until) : NaN
        return { status: 'postponed', reason: o.reason, until: Number.isFinite(until) ? until : now() + UNDELIVERABLE_RECHECK_MS }
      }
      // blocking / report 不会被 drop(判定表);万一 ⇒ 当一次普通没送成,照样退避,不悄悄丢
      if ('drop' in o) return { status: 'deferred', reason: `speech_dropped:${o.reason}` }
      return out
    },
  })

  const wake = (context?: { ownerChatId: string; accountId: string }) => worker.wake(
    context ? { contextAvailable: context } : undefined,
  )
  opts.workbench.setNotificationWake(wake)

  return {
    wake,
    async close() {
      opts.workbench.setNotificationWake(async () => {})
      await worker.close()
    },
  }
}
