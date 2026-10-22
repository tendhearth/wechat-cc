import { describe, expect, it } from 'vitest'
import { socialState, socialUnavailableLine } from './social-state'

const on = { social_enabled: true, social_disclosure_policy: 'p' }
const st = (state: 'ok' | 'degraded' | 'off') => [{ name: 'knowledge', state: 'ok' as const }, { name: 'social', state }]

describe('socialState:以开机时模块的状态为准,配置只看开关改过没有(9d 评审 #546)', () => {
  it('开机时 ok ⇒ ok(之后关了开关,重启前照常能用)', () => {
    expect(socialState(st('ok'), on, true)).toBe('ok')
    expect(socialState(st('ok'), {}, true)).toBe('ok')
  })
  it('开机时 degraded ⇒ degraded', () => {
    expect(socialState(st('degraded'), on, false)).toBe('degraded')
  })
  it('**开机时 off、刚被打开 ⇒ pending,不说「没起来」**(状态页上是 off,那里没有原因可看)', () => {
    expect(socialState(st('off'), on, false)).toBe('pending')
    expect(socialUnavailableLine('pending')).toBe('社交刚打开,重启 CC 后才生效。')
  })
  it('开机时 off、开关也没开 ⇒ off', () => {
    expect(socialState(st('off'), {}, false)).toBe('off')
    expect(socialState(st('off'), { social_enabled: true }, false)).toBe('off')   // 缺披露策略也算没开
  })
  it('没有模块状态可读 ⇒ 按配置猜(老接线)', () => {
    expect(socialState(undefined, {}, false)).toBe('off')
    expect(socialState(undefined, on, true)).toBe('ok')
    expect(socialState(undefined, on, false)).toBe('degraded')
  })
  it('不说「空闲时会自己重启」—— 改开关不会触发空闲自动重启', () => {
    for (const s of ['off', 'degraded', 'pending'] as const) expect(socialUnavailableLine(s)).not.toMatch(/自己重启|自动重启/)
  })
})
