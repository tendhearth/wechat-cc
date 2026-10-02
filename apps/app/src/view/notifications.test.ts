import { describe, it, expect } from 'vitest'
import { notificationNoticeKey } from './notifications'
import { t } from '../i18n'

describe('设置页的通知状态', () => {
  it('每种状态一句话,两种语言都有', () => {
    for (const s of ['idle', 'registered', 'denied', 'unavailable', 'offline', 'failed'] as const) {
      const k = notificationNoticeKey(s)
      expect(t('en', k).length, s).toBeGreaterThan(0)
      expect(t('zh-Hans', k).length, s).toBeGreaterThan(0)
    }
    expect(notificationNoticeKey('denied')).toBe('settings.notifDenied')
    expect(notificationNoticeKey('unavailable')).toBe('settings.notifUnavailable')
  })
})
