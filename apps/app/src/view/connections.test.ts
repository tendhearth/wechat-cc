import { describe, expect, it } from 'vitest'
import { connectionsView, shortDate } from './connections'
import { t } from '../i18n'
const NOW = new Date(2026, 9, 1, 12).getTime()
const src = (id: string, state: 'ready' | 'behind' | 'not_loaded' | 'unknown', latestAt: number | null = null, kind: 'wechat_history' | 'knowledge' | 'plugin' = 'plugin') => ({ id, kind, name: id, state, latestAt, syncedAt: null })
const snap = (sources: ReturnType<typeof src>[]) => ({ generatedAt: NOW, sources, computers: [{ id: 'home', label: 'Mac', online: true, since: NOW - 3_600_000, version: '1.7.1' }], recent: [], outputs: [] })
describe('connectionsView', () => {
  it('颜色与文字:绿 / 琥珀 / 红 / 灰都有字', () => {
    const v = connectionsView(snap([src('wechat_history', 'behind', new Date(2026, 8, 8, 12).getTime(), 'wechat_history'), src('wxsearch', 'ready'), src('wxmedia', 'not_loaded'), src('x', 'unknown')]), NOW, 'zh-Hans')
    expect(v.sources.map(s => [s.dot, s.label])).toEqual([['warn', '有一阵没同步 · 最新消息 9月8日'], ['ok', '已连上'], ['bad', '没加载'], ['unknown', '不知道']])
    expect(v.sources[0]!.name).toBe('微信聊天记录')
    expect(v.headline).toEqual({ dot: 'bad', key: 'links.headlineBad', n: 1 })
  })
  it('全绿 ⇒ headline ok;英文日期', () => {
    expect(connectionsView(snap([src('a', 'ready')]), NOW, 'en').headline).toEqual({ dot: 'ok', key: 'links.headlineOk', n: 1 })
    expect(shortDate(new Date(2026, 8, 8, 12).getTime(), 'en')).toBe('Sep 8')
  })
  it('没琥珀没红但有不知道 ⇒ headline unknown,绝不默认绿;没有任何来源也是 unknown', () => {
    expect(connectionsView(snap([src('a', 'ready'), src('b', 'unknown')]), NOW, 'en').headline).toEqual({ dot: 'unknown', key: 'links.headlineUnknown', n: 1 })
    expect(connectionsView(snap([]), NOW, 'en').headline).toEqual({ dot: 'unknown', key: 'links.headlineUnknown', n: 0 })
    expect(connectionsView(snap([src('a', 'behind'), src('b', 'behind'), src('c', 'unknown')]), NOW, 'en').headline).toEqual({ dot: 'warn', key: 'links.headlineWarn', n: 2 })
  })
  it('名称、带日期的 ready、电脑、最近、成果', () => {
    const s = { ...snap([src('kb', 'ready', new Date(2026, 8, 30, 9).getTime(), 'knowledge'), src('wxsearch', 'behind')]),
      computers: [{ id: 'home', label: 'Mac', online: true, since: new Date(2026, 8, 30, 9).getTime(), version: null }, { id: 'w', label: 'Win', online: false, since: null, version: null }],
      recent: [{ matterId: 'm1', title: '作品集', phase: 'working', at: new Date(2026, 8, 29, 9).getTime() }],
      outputs: [{ matterId: 'm1', name: 'a.png', mime: 'image/png', at: new Date(2026, 8, 28, 9).getTime() }] }
    const v = connectionsView(s, NOW, 'zh-Hans')
    expect(v.sources).toEqual([{ id: 'kb', name: '知识库', dot: 'ok', label: '最新消息 9月30日' }, { id: 'wxsearch', name: 'wxsearch', dot: 'warn', label: '有一阵没更新了' }])
    expect(v.computers).toEqual([{ id: 'home', label: 'Mac', dot: 'ok', detail: '在线 · 自 9月30日' }, { id: 'w', label: 'Win', dot: 'bad', detail: '不在线' }])
    expect(v.recent).toEqual([{ matterId: 'm1', title: '作品集', when: '9月29日' }])
    expect(v.outputs).toEqual([{ matterId: 'm1', name: 'a.png', when: '9月28日' }])
  })
  it('电脑不在线 ⇒ headline 不能说「都连上了」:并进最坏的严重度', () => {
    const s = { ...snap([src('a', 'ready')]), computers: [{ id: 'home', label: 'Mac', online: false, since: null, version: null }] }
    expect(connectionsView(s, NOW, 'en').headline).toEqual({ dot: 'bad', key: 'links.headlineOffline', n: 1 })
    // 来源本身就有红的 ⇒ 仍按来源的红说
    const s2 = { ...snap([src('a', 'not_loaded')]), computers: [{ id: 'home', label: 'Mac', online: false, since: null, version: null }] }
    expect(connectionsView(s2, NOW, 'en').headline).toEqual({ dot: 'bad', key: 'links.headlineBad', n: 1 })
    // 没有任何来源、电脑也不在线 ⇒ 红,不是「还在启动」
    const s3 = { ...snap([]), computers: [{ id: 'home', label: 'Mac', online: false, since: null, version: null }] }
    expect(connectionsView(s3, NOW, 'zh-Hans').headline).toEqual({ dot: 'bad', key: 'links.headlineOffline', n: 1 })
  })
  it('「电脑还在启动」只在 daemon 说 starting 时(终审 M3);别的不知道用中性措辞', () => {
    const unk = snap([src('wechat_history', 'unknown', null, 'wechat_history')])
    expect(connectionsView({ ...unk, starting: true }, NOW, 'zh-Hans').headline.key).toBe('links.headlineStarting')
    expect(connectionsView({ ...unk, starting: false }, NOW, 'zh-Hans').headline.key).toBe('links.headlineUnknown')
    expect(connectionsView(unk, NOW, 'zh-Hans').headline.key).toBe('links.headlineUnknown')
    expect(t('zh-Hans', 'links.headlineUnknown')).not.toContain('启动')
    expect(t('en', 'links.headlineUnknown')).not.toMatch(/start/i)
  })
  it('微信历史行的日期标成「最新消息」,不是同步时间(终审 M4)', () => {
    const v = connectionsView(snap([src('wechat_history', 'ready', new Date(2026, 8, 8, 12).getTime(), 'wechat_history')]), NOW, 'en')
    expect(v.sources[0]!.label).toBe('Latest message Sep 8')
  })
  it('页面是旧的(连不上电脑)⇒ 电脑那行不能还说「在线」(终审 M2)', () => {
    const v = connectionsView(snap([src('a', 'ready')]), NOW, 'zh-Hans', { stale: true })
    expect(v.computers[0]!.detail).not.toContain('在线 ·')
    expect(v.computers[0]!.detail).toBe('上次连上时在线')
    expect(connectionsView(snap([src('a', 'ready')]), NOW, 'en', { stale: true }).computers[0]!.detail).toBe('Online when last reached')
    expect(connectionsView(snap([src('a', 'ready')]), NOW, 'zh-Hans').computers[0]!.detail).toContain('在线 · 自')
  })
})
