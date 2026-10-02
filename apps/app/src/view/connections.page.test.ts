import { describe, expect, it } from 'vitest'
import { connectionsPage } from './connections'
import { ccPresence } from './presence'
import { demoConnections } from '../backend/demo-data'

const NOW = new Date(2026, 9, 1, 12).getTime()
const snap = (state: 'ready' | 'behind' | 'not_loaded' | 'unknown', online = true) => ({
  generatedAt: NOW, sources: [{ id: 'a', kind: 'plugin' as const, name: 'a', state, latestAt: null, syncedAt: null }],
  computers: [{ id: 'home', label: 'Mac', online, since: null, version: null }], recent: [], outputs: [],
})
const dots = (v: NonNullable<ReturnType<typeof connectionsPage>['view']>) => [v.headline.dot, ...v.sources.map(s => s.dot), ...v.computers.map(c => c.dot)]

describe('连接页(终审 I1 / M8):演示不冒充真电脑;顶上一行与桌面卡同义', () => {
  it('演示:所有圆点灰,电脑写成「演示电脑 · 示例」,绝不说在线', () => {
    for (const lang of ['zh-Hans', 'en'] as const) {
      const p = connectionsPage({ data: demoConnections(lang, NOW) }, 'online', NOW, lang, { demo: true })
      expect(p.view).not.toBeNull()
      expect(new Set(dots(p.view!))).toEqual(new Set(['unknown']))
      const pc = p.view!.computers[0]!
      expect(pc.label).toBe(lang === 'zh-Hans' ? '演示电脑' : 'Demo computer')
      expect(pc.detail).toBe(lang === 'zh-Hans' ? '示例' : 'Example')
      expect(`${pc.label} ${pc.detail}`).not.toMatch(/在线|Online/)
    }
  })
  it('真连接 live:顶上一行按最坏的说(与桌面同一套 key);stale:压灰', () => {
    const live = connectionsPage({ data: snap('ready') }, 'online', NOW, 'zh-Hans')
    expect(live.trust).toBe('live')
    expect(live.headline).toEqual({ dot: 'ok', text: '都连着' })
    const bad = connectionsPage({ data: snap('not_loaded') }, 'online', NOW, 'zh-Hans')
    expect(bad.headline).toEqual({ dot: 'bad', text: '1 项没加载' })
    const stale = connectionsPage({ data: snap('ready') }, 'offline', NOW, 'en')
    expect(stale.trust).toBe('stale')
    expect(stale.headline).toEqual({ dot: 'unknown', text: 'All connected' })
    expect(new Set(dots(stale.view!))).toEqual(new Set(['unknown']))
  })
  it('没数据 ⇒ 没有顶行也没有视图', () => {
    expect(connectionsPage({}, 'online', NOW, 'en')).toEqual({ trust: 'none', view: null, headline: null })
  })
})

describe('演示里 CC 是暗的(只有真信号才亮)', () => {
  it('demo ⇒ away,哪怕演示后端说在线', () => {
    expect(ccPresence({ state: 'online', lastSyncedAt: null, epoch: 1 }, { demo: true })).toBe('away')
    expect(ccPresence({ state: 'online', lastSyncedAt: 1, epoch: 1 })).toBe('here')
  })
})
