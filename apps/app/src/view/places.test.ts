import { describe, expect, it } from 'vitest'
import type { PlaceT } from '@wechat-cc/protocol'
import { inPlace, placeHref, placeLine, placeTime } from './places'

const NOW = new Date('2026-11-18T16:10:00').getTime()
const place = (extra: Partial<PlaceT> = {}): PlaceT => ({ key: 'p:0000000000000001', name: 'rici', line: '菜谱导入', status: 'done', waiting: null, moving: false, unseen: false, updatedAt: NOW - 30 * 60_000, matterIds: ['m1'], messageIds: ['msg1'], sessionIds: [], ...extra })

describe('places view', () => {
  it('时间:在干 = 现在;分钟;今天钟点;昨天;一周内星期;更早日子', () => {
    expect(placeTime(place({ moving: true }), NOW, 'zh-Hans')).toBe('现在')
    expect(placeTime(place(), NOW, 'zh-Hans')).toBe('30 分钟前')
    expect(placeTime(place({ updatedAt: new Date('2026-11-17T22:00:00').getTime() }), NOW, 'zh-Hans')).toBe('昨天')
    expect(placeTime(place({ updatedAt: new Date('2026-11-14T10:00:00').getTime() }), NOW, 'en')).toBe('Sat')
    expect(placeTime(place({ updatedAt: null }), NOW, 'en')).toBe('')
  })

  it('现状不用状态词', () => {
    expect(placeLine(place({ status: 'working' }), 'zh-Hans')).toBe('菜谱导入…')
    expect(placeLine(place({ status: 'failed' }), 'zh-Hans')).toBe('菜谱导入(没做成)')
    expect(placeLine(place({ status: 'waiting', line: '删旧表?', waiting: { itemKey: 'k', kind: 'permission', summary: '删旧表?', count: 1 } }), 'en')).toBe('删旧表?')
  })

  it('「›」打开:等你的那件 > 最近的事 > 最近的会话', () => {
    expect(placeHref(place({ waiting: { itemKey: 'k', kind: 'terminal', sessionId: 's/1', summary: 's', count: 1 } }))).toBe('/terminal/s%2F1')
    expect(placeHref(place({ waiting: { itemKey: 'k', kind: 'question', matterId: 'w1', summary: 's', count: 1 } }))).toBe('/matter/w1')
    expect(placeHref(place())).toBe('/matter/m1')
    expect(placeHref(place({ matterIds: [], sessionIds: ['s2'] }))).toBe('/terminal/s2')
    expect(placeHref(place({ matterIds: [] }))).toBeNull()
  })

  it('筛说话:那几件事、分出它们的那句、它们的回复、挂着的终端;在路上的照留;没选 = 全部', () => {
    const bubble = (key: string, extra: any = {}) => ({ key, at: 1, bubble: { key, side: 'me', text: key, at: 1, source: 'phone', state: 'sent', truncated: false, ...extra } }) as any
    const p = place({ sessionIds: ['s9'] })
    expect(inPlace(bubble('msg1'), p)).toBe(true)
    expect(inPlace(bubble('reply', { matterId: 'm1' }), p)).toBe(true)
    expect(inPlace(bubble('other'), p)).toBe(false)
    expect(inPlace(bubble('sending', { state: 'thinking' }), p)).toBe(true)
    expect(inPlace({ key: 'ref:matter:m1', at: 1, row: { id: 'm1', source: 'matter' } } as any, p)).toBe(true)
    expect(inPlace({ key: 'ref:terminal:s9', at: 1, row: { id: 's9', source: 'terminal' } } as any, p)).toBe(true)
    expect(inPlace({ key: 'ref:matter:x', at: 1, row: { id: 'x', source: 'matter' } } as any, p)).toBe(false)
    expect(inPlace(bubble('other'), null)).toBe(true)
  })
})
