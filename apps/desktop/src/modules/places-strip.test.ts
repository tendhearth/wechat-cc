// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { mountPlacesStrip, placeLine, placeTime, renderPlacesHtml } from './places-strip.js'

const NOW = new Date('2026-11-18T16:10:00').getTime()
const MIN = 60_000
const place = (name: string, extra: any = {}) => ({
  key: `p:${name.padEnd(16, '0').slice(0, 16)}`, name, line: `${name} 的事`, status: 'done', waiting: null, moving: false, unseen: false,
  updatedAt: NOW - 30 * MIN, matterIds: [`${name}-m1`], messageIds: [`${name}-msg`], sessionIds: [], ...extra,
})
let strip: ReturnType<typeof mountPlacesStrip> | undefined
afterEach(() => { strip?.destroy(); strip = undefined })

it('时间:在干 = 现在;分钟;今天钟点;昨天;一周内星期;更早日子', () => {
  expect(placeTime(place('a', { moving: true }), NOW)).toBe('现在')
  expect(placeTime(place('a', { updatedAt: NOW - 20_000 }), NOW)).toBe('刚刚')
  expect(placeTime(place('a', { updatedAt: NOW - 4 * MIN }), NOW)).toBe('4 分钟前')
  expect(placeTime(place('a', { updatedAt: new Date('2026-11-18T09:05:00').getTime() }), NOW)).toBe('09:05')
  expect(placeTime(place('a', { updatedAt: new Date('2026-11-17T22:00:00').getTime() }), NOW)).toBe('昨天')
  expect(placeTime(place('a', { updatedAt: new Date('2026-11-14T10:00:00').getTime() }), NOW)).toBe('周六')
  expect(placeTime(place('a', { updatedAt: new Date('2026-10-28T10:00:00').getTime() }), NOW)).toBe('10 月 28 日')
  expect(placeTime(place('a', { updatedAt: null }), NOW)).toBe('')
})

it('现状不用状态词:在干补省略号,没做成 / 停了补一句', () => {
  expect(placeLine(place('a', { status: 'working', line: '画第二张图' }))).toBe('画第二张图…')
  expect(placeLine(place('a', { status: 'failed', line: '迁移' }))).toBe('迁移(没做成)')
  expect(placeLine(place('a', { status: 'stopped', line: '迁移' }))).toBe('迁移(停了)')
  expect(placeLine(place('a', { status: 'waiting', line: '删旧表?', waiting: { kind: 'permission', summary: '删旧表?', count: 1, itemKey: 'k' } }))).toBe('删旧表?')
  expect(placeLine(place('a', { line: null, status: null }))).toBe('')
})

it('等批准的在行上直接答;问题 / 终端是「去回答」;还有几件', () => {
  const html = renderPlacesHtml([
    place('1in8b', { waiting: { itemKey: 'matter:x', kind: 'permission', matterId: 'aaaa0001', requestId: 'r', summary: 's', count: 2 } }),
    place('bx', { waiting: { itemKey: 'terminal:s', kind: 'terminal', sessionId: 's', summary: 's', count: 1 } }),
  ], { selected: null, stale: false, now: NOW })
  expect(html).toContain('data-place-decision="allow"')
  expect(html).toContain('还有 1 件')
  expect(html).toContain('data-place-open')
  expect(html).not.toContain('<script>')
})

it('空 / 连不上:一句说明,不画空表格;名字转义', () => {
  expect(renderPlacesHtml([], { selected: null, stale: false, now: NOW })).toContain('按项目一行一行排在这里')
  expect(renderPlacesHtml([], { selected: null, stale: true, now: NOW })).toContain('暂时连不上')
  expect(renderPlacesHtml([place('<b>')], { selected: null, stale: false, now: NOW })).not.toContain('<b>')
})

function mount(response: any, extra: any = {}) {
  document.body.innerHTML = '<div id="p"></div>'
  const calls: any[] = []
  const call = vi.fn(async (...args: any[]) => { calls.push(args); return typeof response === 'function' ? response(args) : response })
  const onSelect = vi.fn(), onOpen = vi.fn()
  strip = mountPlacesStrip({ root: document.getElementById('p')!, call, onSelect, onOpen, now: () => NOW, intervalMs: 60_000, ...extra })
  return { call, calls, onSelect, onOpen }
}

it('点一行 = 选中并把说话筛成它;再点一次回到全部;没看过的记成看过', async () => {
  const data = { places: [place('rici', { unseen: true }), place('melu')], version: 'v1' }
  const { onSelect, calls } = mount(data)
  await strip!.refresh()
  const row = () => document.querySelector<HTMLButtonElement>('[data-place-key="p:rici000000000000"] .place-row')!
  row().click()
  expect(onSelect).toHaveBeenLastCalledWith(data.places[0])
  expect(row().getAttribute('aria-pressed')).toBe('true')
  expect(calls.some(c => c[1] === '/v1/matter/seen' && c[2]?.id === 'rici-m1')).toBe(true)
  row().click()
  expect(onSelect).toHaveBeenLastCalledWith(null)
})

it('刷新拿到同一个选中地方、它带的 id 没变 ⇒ 不再通知说话', async () => {
  let version = 'v1'
  const { onSelect } = mount(() => ({ places: [place('rici', { line: version })], version }))
  await strip!.refresh()
  document.querySelector<HTMLButtonElement>('.place-row')!.click()
  const n = onSelect.mock.calls.length
  version = 'v2'; await strip!.refresh()
  expect(onSelect.mock.calls.length).toBe(n)
})

it('选中的地方没了 ⇒ 回到全部', async () => {
  let places = [place('rici')]
  const { onSelect } = mount(() => ({ places, version: String(places.length) }))
  await strip!.refresh()
  document.querySelector<HTMLButtonElement>('.place-row')!.click()
  places = []; await strip!.refresh()
  expect(onSelect).toHaveBeenLastCalledWith(null)
  expect(strip!.selected()).toBeNull()
})

it('行上允许:发给那一件的那一条,然后重新读', async () => {
  const p = place('1in8b', { waiting: { itemKey: 'matter:aaaa0001', kind: 'permission', matterId: 'aaaa0001', requestId: 'req-1', summary: 's', count: 1 } })
  const { calls } = mount({ places: [p], version: 'v1' })
  await strip!.refresh()
  document.querySelector<HTMLButtonElement>('[data-place-decision="allow"]')!.click()
  await vi.waitFor(() => expect(calls.some(c => c[1] === '/v1/matter/permission')).toBe(true))
  expect(calls.find(c => c[1] === '/v1/matter/permission')![2]).toEqual({ id: 'aaaa0001', requestId: 'req-1', decision: 'allow' })
})

it('去回答:有事 id 开那件事,只有会话开那个会话', async () => {
  const { onOpen } = mount({ places: [place('bx', { waiting: { itemKey: 'terminal:s1', kind: 'terminal', sessionId: 's1', summary: 's', count: 1 } })], version: 'v1' })
  await strip!.refresh()
  document.querySelector<HTMLButtonElement>('[data-place-open]')!.click()
  await vi.waitFor(() => expect(onOpen).toHaveBeenCalledWith({ kind: 'terminal', id: 's1' }))
})

it('往下挪 / 收起:发给 daemon', async () => {
  const { calls } = mount({ places: [place('a'), place('b')], version: 'v1' })
  await strip!.refresh()
  document.querySelector<HTMLButtonElement>('[data-place-key="p:a000000000000000"] [data-place-move="down"]')!.click()
  await vi.waitFor(() => expect(calls.some(c => c[1] === '/v1/places/move')).toBe(true))
  expect(calls.find(c => c[1] === '/v1/places/move')![2]).toEqual({ key: 'p:a000000000000000', to: 1 })
  document.querySelector<HTMLButtonElement>('[data-place-key="p:b000000000000000"] [data-place-hide]')!.click()
  await vi.waitFor(() => expect(calls.some(c => c[1] === '/v1/places/hide')).toBe(true))
})
