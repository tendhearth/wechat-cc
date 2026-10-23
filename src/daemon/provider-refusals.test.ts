import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeProviderRefusals, PROVIDER_REFUSALS_FILE } from './provider-refusals'

const dir = () => mkdtempSync(join(tmpdir(), 'refusals-'))
const at = Date.parse('2026-10-23T05:00:00Z')

describe('provider-refusals(只看真回合)', () => {
  it('地区不可用 ⇒ 记下;同一家之后一轮真完成 ⇒ 清掉;别家不受影响', () => {
    const r = makeProviderRefusals({ stateDir: dir(), log: () => {} })
    r.onTurn({ provider: 'agy', outcome: 'error', errorCode: 'region_unavailable', endedAt: at })
    expect(r.get('agy')).toEqual({ code: 'region_unavailable', since: '2026-10-23T05:00:00.000Z' })
    r.onTurn({ provider: 'claude', outcome: 'completed', endedAt: at + 1 })
    expect(r.get('agy')).not.toBeNull()
    r.onTurn({ provider: 'agy', outcome: 'completed', endedAt: at + 2 })
    expect(r.get('agy')).toBeNull()
  })
  it('额度、限流、网络、没码的失败不记;超时 / 出错不算恢复', () => {
    const r = makeProviderRefusals({ stateDir: dir(), log: () => {} })
    for (const errorCode of ['quota', 'rate_limited', 'network', undefined]) r.onTurn({ provider: 'agy', outcome: 'error', errorCode, endedAt: at })
    expect(r.all()).toEqual({})
    r.onTurn({ provider: 'agy', outcome: 'error', errorCode: 'region_unavailable', endedAt: at })
    r.onTurn({ provider: 'agy', outcome: 'timeout', endedAt: at + 1 })
    r.onTurn({ provider: 'agy', outcome: 'error', errorCode: 'quota', endedAt: at + 2 })
    expect(r.get('agy')?.since).toBe('2026-10-23T05:00:00.000Z')   // 起始时间不被后来的同码覆盖
  })
  it('重启不忘;文件坏了当没记、不抛', () => {
    const d = dir()
    makeProviderRefusals({ stateDir: d, log: () => {} }).onTurn({ provider: 'agy', outcome: 'error', errorCode: 'region_unavailable', endedAt: at })
    expect(makeProviderRefusals({ stateDir: d, log: () => {} }).get('agy')?.code).toBe('region_unavailable')
    writeFileSync(join(d, PROVIDER_REFUSALS_FILE), '{ broken')
    const logs: string[] = []
    expect(makeProviderRefusals({ stateDir: d, log: (_t, l) => logs.push(l) }).all()).toEqual({})
    expect(logs.join()).toMatch(/unreadable/)
    expect(readFileSync(join(d, PROVIDER_REFUSALS_FILE), 'utf8')).toBe('{ broken')
  })
})
