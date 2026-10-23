import { describe, it, expect } from 'vitest'
import { judgeSoak, formatSoak } from './self-soak'

const H = 3_600_000
const T0 = Date.parse('2026-10-23T02:00:00.000Z')
const at = (h: number, rest: string) => `${new Date(T0 + h * H).toISOString()} ${rest}`
const deploy = at(0, '[NOTIFY] skip startup notify: planned restart (self-deploy)')
const healthy = { ok: true, heartbeat_fresh: true, polling: { eligible: 1, started: 1 }, subsystems: [{ name: 'social', state: 'ok' as const }], version: { head: 'abc12345ef', boot_at: '' } }
const base = { health: healthy, minHours: 4, minRestarts: 0 }

describe('judgeSoak', () => {
  it('部署后够时长、信号干净 ⇒ 绿', () => {
    const r = judgeSoak({ ...base, log: [at(-5, '[DAEMON] old'), deploy, at(1, '[DAEMON] started pid=1')].join('\n'), now: T0 + 5 * H })
    expect(r.verdict).toBe('green')
    expect(r.since).toBe('2026-10-23T02:00:00.000Z')
  })
  it('从最后一次部署算起:更早的异常不算', () => {
    const log = [at(-3, '[NOTIFY] skip startup notify: planned restart (self-deploy)'), at(-2, '[NOTIFY] unplanned restart detected: downtime=5s'), deploy].join('\n')
    expect(judgeSoak({ ...base, log, now: T0 + 5 * H }).verdict).toBe('green')
  })
  it.each([
    ['[NOTIFY] unplanned restart detected: downtime=12s recent=1/30min pid=9', '意外重启'],
    ['[MODULES] stop workbench/stop failed: boom', '模块'],
    ['[MODULES] internal-api degraded at start: EADDRINUSE', '模块'],
    ['[DAEMON] uncaughtException: TypeError: x', 'uncaughtException'],
    ['[DAEMON] startup failed mid-init: nope', '开机失败'],
    ['[DAEMON] SIGTERM during shutdown — forcing exit', '被迫退出'],
  ])('部署后出现「%s」⇒ 红', (line, label) => {
    const r = judgeSoak({ ...base, log: [deploy, at(2, line)].join('\n'), now: T0 + 5 * H })
    expect(r.verdict).toBe('red')
    expect(r.problems.join()).toContain(label)
  })
  it('[MODULES] 的正常停机行不算', () => {
    const r = judgeSoak({ ...base, log: [deploy, at(2, '[MODULES] stopped workbench/stop')].join('\n'), now: T0 + 5 * H })
    expect(r.verdict).toBe('green')
  })
  it('不够时长 ⇒ 还没到', () => {
    const r = judgeSoak({ ...base, log: deploy, now: T0 + 1 * H })
    expect(r.verdict).toBe('not_yet')
    expect(r.notes.join()).toMatch(/才跑了 1\.0 小时/)
  })
  it('要求至少优雅重启过一次:没走过 ⇒ 还没到;走过 ⇒ 绿', () => {
    const now = T0 + 5 * H
    expect(judgeSoak({ ...base, minRestarts: 1, log: deploy, now }).verdict).toBe('not_yet')
    const log = [deploy, at(3, '[NOTIFY] skip startup notify: planned restart (shutdown:SIGTERM)')].join('\n')
    const r = judgeSoak({ ...base, minRestarts: 1, log, now })
    expect(r.verdict).toBe('green')
    expect(r.restarts).toBe(1)
  })
  it('健康接口:不通 / 子系统降级 / 心跳旧 / 拉消息没全起 ⇒ 红', () => {
    const now = T0 + 5 * H
    expect(judgeSoak({ ...base, health: null, log: deploy, now }).verdict).toBe('red')
    expect(judgeSoak({ ...base, health: { ...healthy, subsystems: [{ name: 'social', state: 'degraded', error: 'x' }] }, log: deploy, now }).problems.join()).toContain('social')
    expect(judgeSoak({ ...base, health: { ...healthy, heartbeat_fresh: false }, log: deploy, now }).verdict).toBe('red')
    expect(judgeSoak({ ...base, health: { ...healthy, polling: { eligible: 2, started: 1 } }, log: deploy, now }).verdict).toBe('red')
  })
  it('日志里找不到部署记录 ⇒ 红,要 --since;给了 --since 就照它算', () => {
    const now = T0 + 5 * H
    expect(judgeSoak({ ...base, log: at(1, '[DAEMON] x'), now }).problems.join()).toMatch(/--since/)
    expect(judgeSoak({ ...base, log: at(1, '[DAEMON] x'), now, since: T0 }).verdict).toBe('green')
  })
  it('人读版:绿 / 红各一句头', () => {
    expect(formatSoak(judgeSoak({ ...base, log: deploy, now: T0 + 5 * H }))).toMatch(/^✓/)
    expect(formatSoak(judgeSoak({ ...base, health: null, log: deploy, now: T0 + 5 * H }))).toMatch(/^✗/)
  })
})
