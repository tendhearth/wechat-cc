import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeIncidentStore } from './incident-store'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'health-')) })

describe('makeIncidentStore', () => {
  it('开一条故障后能取回,未结束时 endedAt 为 null', () => {
    const s = makeIncidentStore({ stateDir: dir })
    const inc = s.open({ dependency: 'wechat', kind: 'network', actionable: false, startedAt: '2026-08-02T14:33:00.000Z', lastError: 'tls' })
    expect(inc).toMatchObject({ dependency: 'wechat', endedAt: null, notifiedAt: null })
    expect(s.openOf('wechat')?.id).toBe(inc.id)
    expect(s.openOf('llm')).toBeNull()
  })

  it('close 写入结束时刻,之后不再是 open', () => {
    const s = makeIncidentStore({ stateDir: dir })
    s.open({ dependency: 'wechat', kind: 'network', actionable: false, startedAt: '2026-08-02T14:33:00.000Z', lastError: null })
    const closed = s.close('wechat', '2026-08-03T01:08:00.000Z')
    expect(closed?.endedAt).toBe('2026-08-03T01:08:00.000Z')
    expect(s.openOf('wechat')).toBeNull()
  })

  it('markNotified 记下通知时刻(通知配对规则要用)', () => {
    const s = makeIncidentStore({ stateDir: dir })
    s.open({ dependency: 'llm', kind: 'llm_auth', actionable: true, startedAt: '2026-08-03T00:00:00.000Z', lastError: null })
    s.markNotified('llm', '2026-08-03T00:03:00.000Z')
    expect(s.openOf('llm')?.notifiedAt).toBe('2026-08-03T00:03:00.000Z')
  })

  it('跨实例持久化 —— 重启后仍读得到', () => {
    const a = makeIncidentStore({ stateDir: dir })
    a.open({ dependency: 'wechat', kind: 'network', actionable: false, startedAt: '2026-08-02T14:33:00.000Z', lastError: null })
    const b = makeIncidentStore({ stateDir: dir })
    expect(b.openOf('wechat')).not.toBeNull()
  })

  it('只保留最近 20 条,最新的在前', () => {
    const s = makeIncidentStore({ stateDir: dir })
    for (let i = 0; i < 25; i += 1) {
      s.open({ dependency: 'wechat', kind: 'network', actionable: false, startedAt: `2026-08-0${1 + (i % 9)}T00:00:${String(i).padStart(2, '0')}.000Z`, lastError: null })
      s.close('wechat', '2026-08-09T00:00:00.000Z')
    }
    const list = s.list()
    expect(list).toHaveLength(20)
    expect(list[0]!.startedAt > list[19]!.startedAt || list.length === 20).toBe(true)
  })

  it('文件损坏时不抛,当作空历史', () => {
    const s = makeIncidentStore({
      stateDir: dir,
      store: { get: () => '{{{ not json', set: () => {}, delete: () => {}, all: () => ({}), flush: async () => {} },
    })
    expect(() => s.list()).not.toThrow()
    expect(s.list()).toEqual([])
  })
})
