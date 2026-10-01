import { describe, expect, it } from 'vitest'
import { buildConnections, redactConnections, cacheConnections, KNOWLEDGE_STALE_MS, WECHAT_SYNC_STALE_MS, type ConnectionsDeps } from './connections'
import type { PluginsHealth } from './plugins/health'

const NOW = Date.UTC(2026, 9, 1, 12)
const health = (over: Partial<PluginsHealth> = {}): PluginsHealth => ({
  bundled_dir: '/Users/nate/app/plugins', via: 'env' as never, pointer_dir: null, pointer_broken: false, expected_missing: [],
  plugins: [
    { name: 'wxvault', source: 'bundled' as never, enabled: true, ready: true },
    { name: 'wxsearch', source: 'bundled' as never, enabled: true, ready: true },
    { name: 'wxmedia', source: 'bundled' as never, enabled: true, ready: false, reason: 'model missing at /Users/nate/x' },
    { name: 'off', source: 'bundled' as never, enabled: false, ready: false },
  ], ...over,
})
const deps = (over: Partial<ConnectionsDeps> = {}): ConnectionsDeps => ({
  plugins: () => health(),
  wechatSyncedAt: () => NOW - 3_600_000,
  knowledge: () => ({ enabled: true, built: true, latestAt: NOW - 3_600_000, syncedAt: NOW - 3_600_000 }),
  computer: () => ({ label: 'Nate-Mac', since: NOW - 7_200_000, version: '1.7.1' }),
  now: () => NOW,
  ...over,
})
const byId = (s: ReturnType<typeof buildConnections>, id: string) => s.sources.find(x => x.id === id)

describe('buildConnections', () => {
  it('一切正常:微信历史 / 知识库 / wxsearch 绿,wxmedia 红,关掉的不列', () => {
    const s = buildConnections(deps())
    expect(s.sources.map(x => [x.id, x.state])).toEqual([
      ['wechat_history', 'ready'], ['knowledge', 'ready'], ['plugin:wxmedia', 'not_loaded'], ['plugin:wxsearch', 'ready'],
    ])
    expect(byId(s, 'wechat_history')).toMatchObject({ syncedAt: NOW - 3_600_000, latestAt: NOW - 3_600_000 })
    expect(s.computers).toEqual([{ id: 'home', label: 'Nate-Mac', online: true, since: NOW - 7_200_000, version: '1.7.1' }])
  })
  it('解密库超过 24 小时没动 ⇒ 微信历史 behind;读不到解密库时间 ⇒ unknown', () => {
    expect(byId(buildConnections(deps({ wechatSyncedAt: () => NOW - WECHAT_SYNC_STALE_MS - 1 })), 'wechat_history')!.state).toBe('behind')
    expect(byId(buildConnections(deps({ wechatSyncedAt: () => null })), 'wechat_history')!.state).toBe('unknown')
  })
  it('wxvault 没加载(真机 09-11 起)⇒ 红,并带原因 / 目录(只在 detail 里)', () => {
    const s = buildConnections(deps({ plugins: () => health({ plugins: [], expected_missing: ['wxvault', 'wxsearch'] }) }))
    expect(byId(s, 'wechat_history')).toMatchObject({ state: 'not_loaded', detail: { reason: 'missing', dir: '/Users/nate/app/plugins' } })
    expect(byId(s, 'plugin:wxsearch')).toMatchObject({ state: 'not_loaded' })
  })
  it('知识库:没开 ⇒ 不出现;开了没建起来 ⇒ 红;超过 72 小时 / 空 ⇒ 琥珀', () => {
    expect(byId(buildConnections(deps({ knowledge: () => ({ enabled: false, built: false, latestAt: null, syncedAt: null }) })), 'knowledge')).toBeUndefined()
    expect(byId(buildConnections(deps({ knowledge: () => ({ enabled: true, built: false, latestAt: null, syncedAt: null }) })), 'knowledge')!.state).toBe('not_loaded')
    expect(byId(buildConnections(deps({ knowledge: () => ({ enabled: true, built: true, latestAt: NOW - 3_600_000, syncedAt: NOW - KNOWLEDGE_STALE_MS - 1 }) })), 'knowledge')!.state).toBe('behind')
    // 安静周末:最新消息很旧,但刚同步过 ⇒ 仍然绿(按同步时间判,不按消息时间)
    expect(byId(buildConnections(deps({ knowledge: () => ({ enabled: true, built: true, latestAt: NOW - 10 * 86_400_000, syncedAt: NOW - 3_600_000 }) })), 'knowledge')!.state).toBe('ready')
    // 空库 / 从没记录过同步时间 ⇒ 不知道,不是琥珀
    expect(byId(buildConnections(deps({ knowledge: () => ({ enabled: true, built: true, latestAt: null, syncedAt: NOW - 3_600_000 }) })), 'knowledge')!.state).toBe('unknown')
    expect(byId(buildConnections(deps({ knowledge: () => ({ enabled: true, built: true, latestAt: NOW - 3_600_000, syncedAt: null }) })), 'knowledge')!.state).toBe('unknown')
  })
  it('插件快照还没出来 ⇒ 不知道(不是绿也不是红)', () => {
    const s = buildConnections(deps({ plugins: () => null }))
    expect(byId(s, 'wechat_history')!.state).toBe('unknown')
    expect(s.sources.filter(x => x.kind === 'plugin')).toEqual([])
    expect(byId(s, 'knowledge')!.state).toBe('unknown')
  })
  it('最近在做 / 成果:按时间取前 3;某件详情抛错就跳过', () => {
    const tasks = [1, 2, 3, 4].map(i => ({ id: `0000000${i}`, title: `t${i}`, phase: 'working', updatedAt: i }))
    const s = buildConnections(deps({ workbench: {
      list: () => ({ tasks }),
      detail: id => { if (id === '00000003') throw new Error('gone'); return { artifacts: [{ name: `${id}.md`, mime: 'text/markdown', createdAt: Number(id) }] } },
    } }))
    expect(s.recent.map(r => r.matterId)).toEqual(['00000004', '00000003', '00000002'])
    expect(s.outputs.map(o => o.name)).toEqual(['00000004.md', '00000002.md', '00000001.md'])
  })
  it('redactConnections:手机拿到的快照里没有路径与原因原文', () => {
    const s = redactConnections(buildConnections(deps({ plugins: () => health({ plugins: [{ name: 'wxmedia', source: 'bundled' as never, enabled: true, ready: false, reason: 'at /Users/nate/x' }], expected_missing: ['wxvault'] }) })))
    const text = JSON.stringify(s)
    expect(text).not.toMatch(/\/Users|\/home|[A-Za-z]:\\\\/)
    expect(s.sources.every(x => !('detail' in x))).toBe(true)
  })
  it('detailLimit caps how many matters get a detail() call', () => {
    let calls = 0
    const tasks = [1, 2, 3, 4, 5].map(i => ({ id: `0000000${i}`, title: `t${i}`, updatedAt: i }))
    const s = buildConnections(deps({ detailLimit: 3, workbench: { list: () => ({ tasks }), detail: () => { calls++; return { artifacts: [] } } } }))
    expect(calls).toBe(3)
    expect(s.recent[0]!.phase).toBe('working')
  })
})

describe('cacheConnections', () => {
  it('ttl 内只算一次;过期重算;抛错不缓存', () => {
    let t = 0, calls = 0, boom = false
    const c = cacheConnections(() => { calls++; if (boom) throw new Error('x'); return { generatedAt: calls, sources: [], computers: [], recent: [], outputs: [] } }, 10_000, () => t)
    expect(c().generatedAt).toBe(1); t = 9_999; expect(c().generatedAt).toBe(1); expect(calls).toBe(1)
    t = 10_000; expect(c().generatedAt).toBe(2)
    t = 25_000; boom = true; expect(() => c()).toThrow(); boom = false; expect(c().generatedAt).toBe(4)
  })
})
