import { describe, it, expect } from 'vitest'
import {
  shouldNotifyDown, shouldNotifyRecovery,
  NOTIFY_ACTIONABLE_MS, NOTIFY_NON_ACTIONABLE_MS, REPEAT_ACTIONABLE_MS,
} from './notify-policy'
import type { Incident } from './incident-store'

const T0 = Date.parse('2026-08-02T14:33:00.000Z')
function incident(over: Partial<Incident> = {}): Incident {
  return {
    id: 'i', dependency: 'wechat', kind: 'network', actionable: false,
    startedAt: new Date(T0).toISOString(), endedAt: null, notifiedAt: null, lastError: null,
    ...over,
  }
}

describe('shouldNotifyDown', () => {
  it('不可操作的要等 30 分钟 —— 短故障不打扰(阈值按 49 天实测分布校准)', () => {
    const inc = incident()
    expect(shouldNotifyDown(inc, T0 + NOTIFY_NON_ACTIONABLE_MS - 1)).toBe(false)
    expect(shouldNotifyDown(inc, T0 + NOTIFY_NON_ACTIONABLE_MS)).toBe(true)
  })

  it('可操作的 3 分钟就说 —— 不说就永远不会好', () => {
    const inc = incident({ actionable: true, kind: 'login_taken_over' })
    expect(shouldNotifyDown(inc, T0 + NOTIFY_ACTIONABLE_MS - 1)).toBe(false)
    expect(shouldNotifyDown(inc, T0 + NOTIFY_ACTIONABLE_MS)).toBe(true)
  })

  it('不可操作的通知过一次就不再重复 —— 你已经知道且无能为力', () => {
    const inc = incident({ notifiedAt: new Date(T0 + NOTIFY_NON_ACTIONABLE_MS).toISOString() })
    expect(shouldNotifyDown(inc, T0 + 10 * 3600_000)).toBe(false)
  })

  it('可操作的每 6 小时提醒一次(自上一条通知起算)', () => {
    const notifiedAt = T0 + NOTIFY_ACTIONABLE_MS
    const inc = incident({ actionable: true, notifiedAt: new Date(notifiedAt).toISOString() })
    expect(shouldNotifyDown(inc, notifiedAt + REPEAT_ACTIONABLE_MS - 1)).toBe(false)
    expect(shouldNotifyDown(inc, notifiedAt + REPEAT_ACTIONABLE_MS)).toBe(true)
  })

  it('已结束的故障不再发 down', () => {
    const inc = incident({ endedAt: new Date(T0 + 1000).toISOString() })
    expect(shouldNotifyDown(inc, T0 + 10 * 3600_000)).toBe(false)
  })
})

describe('shouldNotifyRecovery', () => {
  it('通知过"坏了"才通知"恢复"', () => {
    expect(shouldNotifyRecovery(incident({ endedAt: 'x', notifiedAt: 'y' }))).toBe(true)
  })

  it('没通知过就别冒出一句"已恢复" —— 会让人莫名其妙', () => {
    expect(shouldNotifyRecovery(incident({ endedAt: 'x', notifiedAt: null }))).toBe(false)
  })

  it('还没结束的不发恢复', () => {
    expect(shouldNotifyRecovery(incident({ endedAt: null, notifiedAt: 'y' }))).toBe(false)
  })
})
