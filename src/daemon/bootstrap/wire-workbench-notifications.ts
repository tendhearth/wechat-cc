import { makeWechatNotificationWorker } from '../../core/workbench/wechat-notifications'
import type { WorkbenchService } from '../../core/workbench/service'
import type { IlinkAdapter } from '../ilink-glue'

export function wireWorkbenchNotifications(opts: {
  workbench: WorkbenchService
  ilink: Pick<IlinkAdapter, 'sendWorkbenchNotice' | 'chatAccountId'>
}): {
  wake(context?: { ownerChatId: string; accountId: string }): Promise<void>
  close(): Promise<void>
} {
  const worker = makeWechatNotificationWorker({
    store: opts.workbench.notificationStore,
    eligible: notice => opts.workbench.notificationEligible(notice),
    send: (notice, signal) => {
      // This check deliberately stays synchronous and adjacent to transport.
      // Awaiting between eligibility and send would let a resolved request,
      // mute, owner change, or account rebind become stale in the gap.
      if (!opts.workbench.notificationEligible(notice)) {
        return Promise.resolve({ status: 'blocked', reason: 'ineligible' })
      }
      if (typeof opts.ilink.chatAccountId !== 'function' || opts.ilink.chatAccountId(notice.ownerChatId) !== notice.accountId) {
        return Promise.resolve({ status: 'blocked', reason: 'binding_changed' })
      }
      if (typeof opts.ilink.sendWorkbenchNotice !== 'function') {
        return Promise.resolve({ status: 'blocked', reason: 'transport_unavailable' })
      }
      return opts.ilink.sendWorkbenchNotice(notice, signal)
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
