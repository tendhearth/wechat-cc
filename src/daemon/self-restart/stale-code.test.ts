import { describe, it, expect } from 'vitest'
import { shouldSelfRestart, BOOT_GRACE_MS, MIN_RESTART_INTERVAL_MS } from './stale-code'

const BOOT = 1_000_000
function input(over: Partial<Parameters<typeof shouldSelfRestart>[0]> = {}) {
  return {
    loadedHead: 'aaa111',
    currentHead: 'bbb222',        // 默认:磁盘上更新了
    idle: true,
    nowMs: BOOT + BOOT_GRACE_MS,  // 默认:刚过宽限期
    bootAtMs: BOOT,
    lastRestartAtMs: null,
    ...over,
  }
}

describe('shouldSelfRestart', () => {
  it('代码变了 + 空闲 + 过了宽限期 ⇒ 重启', () => {
    expect(shouldSelfRestart(input())).toBe(true)
  })

  it('代码没变 ⇒ 不重启(重启后天然不再成立,所以不会循环)', () => {
    expect(shouldSelfRestart(input({ currentHead: 'aaa111' }))).toBe(false)
  })

  it('不空闲 ⇒ 不重启', () => {
    expect(shouldSelfRestart(input({ idle: false }))).toBe(false)
  })

  it('宽限期内 ⇒ 不重启', () => {
    expect(shouldSelfRestart(input({ nowMs: BOOT + BOOT_GRACE_MS - 1 }))).toBe(false)
  })

  it('距上次自我重启不足最小间隔 ⇒ 不重启', () => {
    const now = BOOT + BOOT_GRACE_MS + 1
    expect(shouldSelfRestart(input({ nowMs: now, lastRestartAtMs: now - MIN_RESTART_INTERVAL_MS + 1 }))).toBe(false)
    expect(shouldSelfRestart(input({ nowMs: now, lastRestartAtMs: now - MIN_RESTART_INTERVAL_MS }))).toBe(true)
  })

  it('任一 head 读不到 ⇒ 不重启(失败方向必须是不动作)', () => {
    expect(shouldSelfRestart(input({ currentHead: null }))).toBe(false)
    expect(shouldSelfRestart(input({ loadedHead: null }))).toBe(false)
    expect(shouldSelfRestart(input({ loadedHead: null, currentHead: null }))).toBe(false)
  })
})
