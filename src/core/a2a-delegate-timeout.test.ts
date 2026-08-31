/**
 * 委派超时的两端耦合 —— brain 端自己的超时必须严格小于 hand 端 Bun 的
 * idleTimeout 上限(255s,Bun 硬上限,抬不动)。否则跑得久的委派任务是
 * 【hand 先掐断连接】,brain 拿到的是网络错误而不是自己那个干净的 timeout,
 * friendlyDelegateReason 会把它说成「连不上那台手」—— 而真相是「那台手还在跑」。
 *
 * 2026-08-31 实测错配:brain 默认 300s > hand 上限 255s,中间 45 秒的任务
 * 必然被误报。这条测试把两个常量钉在一起,防止再次漂移。
 */
import { describe, it, expect } from 'vitest'
import { A2A_EXEC_IDLE_TIMEOUT_S } from './a2a-server'
import { DEFAULT_DELEGATE_TIMEOUT_MS } from './a2a-delegate'

describe('委派超时:brain 默认值 vs hand 的 Bun idleTimeout 上限', () => {
  it('brain 的默认超时严格小于 hand 的连接上限,留出网络/TLS 余量', () => {
    const handCapMs = A2A_EXEC_IDLE_TIMEOUT_S * 1000
    expect(DEFAULT_DELEGATE_TIMEOUT_MS).toBeLessThan(handCapMs)
    // 不只是"小一点":要留够余量,免得握手/传输抖动把 brain 的超时推到上限之后
    expect(handCapMs - DEFAULT_DELEGATE_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000)
  })
})
