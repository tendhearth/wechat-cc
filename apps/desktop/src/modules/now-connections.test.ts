// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { connectionsView, mountNowConnections } from './now-connections.js'

const NOW = new Date(2026, 9, 1, 12).getTime()
type St = 'ready' | 'behind' | 'not_loaded' | 'unknown'
const src = (id: string, state: St, latestAt: number | null = null, kind = 'plugin') => ({ id, kind, name: id, state, latestAt, syncedAt: null })
const snap = (sources: any[], extra: any = {}) => ({ generatedAt: NOW, sources, computers: [{ id: 'home', label: 'Mac', online: true, since: new Date(2026, 8, 30, 9).getTime(), version: '1.7.1' }], recent: [], outputs: [], ...extra })

describe('connectionsView(与手机 /connections 同一套规则)', () => {
  it('颜色与文字;微信历史的日期是最新消息', () => {
    const v = connectionsView(snap([src('wechat_history', 'behind', new Date(2026, 8, 8, 12).getTime(), 'wechat_history'), src('wxsearch', 'ready'), src('wxmedia', 'not_loaded'), src('x', 'unknown'), src('kb', 'ready', new Date(2026, 8, 30, 9).getTime(), 'knowledge')]))
    expect(v.sources.map(s => [s.name, s.dot, s.label])).toEqual([
      ['微信聊天记录', 'warn', '有一阵没同步 · 最新消息 9月8日'], ['wxsearch', 'ok', '已连上'], ['wxmedia', 'bad', '没加载'], ['x', 'unknown', '不知道'], ['知识库', 'ok', '最新消息 9月30日'],
    ])
    expect(v.headline).toEqual({ dot: 'bad', text: '1 项没加载' })
  })
  it('全绿才说都连着;有不知道 ⇒ 灰,绝不默认绿;没有来源也是灰', () => {
    expect(connectionsView(snap([src('a', 'ready')])).headline).toEqual({ dot: 'ok', text: '都连着' })
    expect(connectionsView(snap([src('a', 'ready'), src('b', 'unknown')])).headline).toEqual({ dot: 'unknown', text: '暂时不知道连接情况' })
    expect(connectionsView(snap([])).headline).toEqual({ dot: 'unknown', text: '暂时不知道连接情况' })
    expect(connectionsView(snap([src('a', 'behind'), src('b', 'behind'), src('c', 'unknown')])).headline).toEqual({ dot: 'warn', text: '2 项有点旧' })
  })
  it('「还在启动」只在 daemon 说 starting 时', () => {
    expect(connectionsView(snap([src('w', 'unknown')], { starting: true })).headline.text).toBe('电脑还在启动，暂时不知道')
    expect(connectionsView(snap([src('w', 'unknown')], { starting: false })).headline.text).toBe('暂时不知道连接情况')
  })
  it('电脑不在线并进最坏的严重度', () => {
    const off = { computers: [{ id: 'home', label: 'Mac', online: false, since: null, version: null }] }
    expect(connectionsView(snap([src('a', 'ready')], off)).headline).toEqual({ dot: 'bad', text: '1 台电脑不在线' })
    expect(connectionsView(snap([src('a', 'not_loaded')], off)).headline).toEqual({ dot: 'bad', text: '1 项没加载' })
    expect(connectionsView(snap([src('a', 'ready')], off)).computers[0]).toEqual({ id: 'home', label: 'Mac', dot: 'bad', detail: '不在线' })
  })
  it('电脑、最近、成果;stale ⇒ 所有点变灰、电脑不说「在线」', () => {
    const s = snap([src('a', 'ready')], {
      recent: [{ matterId: 'm1', title: '作品集', phase: 'working', at: new Date(2026, 8, 29, 9).getTime() }],
      outputs: [{ matterId: 'm1', name: 'a.png', mime: 'image/png', at: new Date(2026, 8, 28, 9).getTime() }],
    })
    const v = connectionsView(s)
    expect(v.computers[0]).toEqual({ id: 'home', label: 'Mac', dot: 'ok', detail: '在线 · 自 9月30日' })
    expect(v.recent).toEqual([{ matterId: 'm1', title: '作品集', when: '9月29日' }])
    expect(v.outputs).toEqual([{ matterId: 'm1', name: 'a.png', when: '9月28日' }])
    const st = connectionsView(s, { stale: true })
    expect([st.headline.dot, ...st.sources.map(x => x.dot), ...st.computers.map(x => x.dot)]).toEqual(['unknown', 'unknown', 'unknown'])
    expect(st.computers[0]!.detail).toBe('上次连上时在线')
  })
})

describe('mountNowConnections', () => {
  const host = () => { document.body.innerHTML = '<div id="h"></div>'; return document.getElementById('h') as HTMLElement }
  it('还没拿到数据 ⇒ 灰点 + 不知道', async () => {
    const h = host(); const c = mountNowConnections({ host: h, call: vi.fn().mockRejectedValue(new Error('x')), now: () => NOW })
    await c.refresh()
    expect(h.querySelector('.nc-headline .dot')!.className).toContain('unknown')
    expect(h.querySelector('.nc-headline')!.textContent).toContain('暂时不知道连接情况')
    expect(h.querySelector('.dot.ok')).toBeNull()
  })
  it('拿到数据 ⇒ 每个来源一行;读失败后保留上次所知但不再有绿点', async () => {
    const h = host()
    const call = vi.fn().mockResolvedValueOnce(snap([src('wechat_history', 'ready', new Date(2026, 8, 30, 9).getTime(), 'wechat_history'), src('<b>x</b>', 'ready')])).mockRejectedValueOnce(new Error('down'))
    const c = mountNowConnections({ host: h, call, now: () => NOW })
    await c.refresh()
    expect(call).toHaveBeenCalledWith('GET', '/v1/connections')
    expect(h.querySelectorAll('.nc-source')).toHaveLength(2)
    expect(h.textContent).toContain('微信聊天记录')
    expect(h.textContent).toContain('最新消息 9月30日')
    expect(h.querySelector('b')).toBeNull()
    expect(h.querySelectorAll('.dot.ok').length).toBeGreaterThan(0)
    await c.refresh()
    expect(h.querySelectorAll('.dot.ok')).toHaveLength(0)
    expect(h.querySelector('.nc-stale')!.textContent).toContain('12:00')
    expect(h.textContent).toContain('微信聊天记录')
  })
  it('重新打开时上次拉取超过 30 秒 ⇒ 先压灰(不显示旧的绿),拉到新的再按真数据(终审 M2)', async () => {
    const h = host()
    let t = NOW
    let release: (v: unknown) => void = () => {}
    const call = vi.fn()
      .mockResolvedValueOnce(snap([src('a', 'ready')]))
      .mockImplementationOnce(() => new Promise(r => { release = r }))
      .mockResolvedValueOnce(snap([src('a', 'ready')]))
    const c = mountNowConnections({ host: h, call, now: () => t })
    await c.open()
    expect(h.querySelectorAll('.dot.ok').length).toBeGreaterThan(0)
    t = NOW + 31_000
    const pending = c.open()
    expect(h.querySelectorAll('.dot.ok')).toHaveLength(0)
    expect(h.querySelector('.nc-stale')!.textContent).toContain('正在更新')
    release(snap([src('a', 'ready')]))
    await pending
    expect(h.querySelectorAll('.dot.ok').length).toBeGreaterThan(0)
    expect(h.querySelector('.nc-stale')).toBeNull()
    // 30 秒内再打开:直接按刚拿到的显示
    t = NOW + 40_000
    const again = c.open()
    expect(h.querySelectorAll('.dot.ok').length).toBeGreaterThan(0)
    await again
  })
})
