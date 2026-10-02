import type { MessageKey } from '../i18n'
import type { PushStatus } from '../push/register'

/** 设置页「通知」一节的状态句。 */
export function notificationNoticeKey(status: PushStatus): MessageKey {
  switch (status) {
    case 'registered': return 'settings.notifOn'
    case 'denied': return 'settings.notifDenied'
    case 'unavailable': return 'settings.notifUnavailable'
    case 'offline': return 'settings.notifOffline'
    case 'failed': return 'settings.notifFailed'
    default: return 'settings.notifPending'
  }
}
