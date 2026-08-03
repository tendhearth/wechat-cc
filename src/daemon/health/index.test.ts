import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeHealthRuntime } from './index'
import { SUSPEND_AFTER_MS } from './connection-health'
import { NOTIFY_NON_ACTIONABLE_MS } from './notify-policy'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'health-rt-')) })

function setup() {
  const t = { ms: Date.parse('2026-08-02T14:33:00.000Z') }
  const notes: Array<{ title: string; body: string }> = []
  const rt = makeHealthRuntime({
    stateDir: dir,
    now: () => t.ms,
    log: () => {},
    notify: n => { notes.push({ title: n.title, body: n.body }) },
  })
  return { t, notes, rt }
}

describe('makeHealthRuntime', () => {
  it('复刻 2026-08-02 那次:10.5 小时故障只产生 2 条通知', () => {
    const { t, notes, rt } = setup()
    const start = t.ms
    // 每 60 秒一次失败,持续 10.5 小时
    for (let elapsed = 0; elapsed <= 10.5 * 3600_000; elapsed += 60_000) {
      t.ms = start + elapsed
      rt.onFailure('wechat', new Error('unknown certificate verification error'))
    }
    expect(notes).toHaveLength(1)          // 15 分钟时那一条
    expect(notes[0]!.title).toMatch(/网络/)

    t.ms = start + 10.5 * 3600_000 + 60_000
    rt.onSuccess('wechat')
    expect(notes).toHaveLength(2)          // 恢复
    expect(notes[1]!.body).toMatch(/恢复/)
  })

  it('30 秒抖动:一条都不发,也不算故障', () => {
    const { t, notes, rt } = setup()
    const start = t.ms
    rt.onFailure('wechat', new Error('ECONNRESET'))
    t.ms = start + 30_000
    rt.onFailure('wechat', new Error('ECONNRESET'))
    t.ms = start + 31_000
    rt.onSuccess('wechat')
    expect(notes).toEqual([])
    expect(rt.health.get('wechat').status).toBe('healthy')
  })

  it('可操作故障 3 分钟就通知', () => {
    const { t, notes, rt } = setup()
    const start = t.ms
    for (let e = 0; e <= 200_000; e += 20_000) {
      t.ms = start + e
      rt.onFailure('wechat', new Error('ilink/getupdates errcode=-14: replaced'))
    }
    expect(notes).toHaveLength(1)
    expect(notes[0]!.title).toMatch(/微信登录/)
  })

  it('degraded 之前不开故障记录 —— 60 秒确认期内不算数', () => {
    const { t, rt } = setup()
    rt.onFailure('wechat', new Error('boom'))
    t.ms += SUSPEND_AFTER_MS - 1
    rt.onFailure('wechat', new Error('boom'))
    expect(rt.health.shouldSuspend('wechat')).toBe(false)
  })

  it('notify 抛异常不会把上报打断 —— 保护机制不能成为新故障源', () => {
    const t = { ms: Date.parse('2026-08-02T14:33:00.000Z') }
    const rt = makeHealthRuntime({
      stateDir: dir, now: () => t.ms, log: () => {},
      notify: () => { throw new Error('desktop not running') },
    })
    const start = t.ms
    expect(() => {
      for (let e = 0; e <= NOTIFY_NON_ACTIONABLE_MS + 60_000; e += 60_000) {
        t.ms = start + e
        rt.onFailure('wechat', new Error('tls'))
      }
    }).not.toThrow()
  })
})
