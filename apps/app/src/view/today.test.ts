import { describe, it, expect } from 'vitest'
import { PHONE_API_SCHEMAS } from '@wechat-cc/protocol'
import type { OverseerTodayT, TodayItemT } from '../backend/types'
import { todayHref, todayRow, todayView, TODAY_DONE_ROWS } from './today'

const NOW = 10_000_000
const item = (over: Partial<TodayItemT> = {}): TodayItemT => ({
  source: 'terminal', id: 'sess/1', code: 'sess1', project: 'blog', agent: 'Claude Code', title: null, summary: '改好了', at: NOW - 5 * 60_000, machine: null, ...over,
})
const today = (over: Partial<OverseerTodayT> = {}): OverseerTodayT => {
  const base: OverseerTodayT = {
    generatedAt: NOW, since: NOW - 86_400_000, windowHours: 24,
    needsYou: [{ ...item({ id: 'w' }), kind: 'permission', count: 1, replyRef: '07' }],
    done: [item(), item({ source: 'together', id: 'a1b2c3d4', code: 'a1b2c3d4', title: '修打包', project: 'melu', agent: 'Codex', summary: null }), item({ id: 's3' }), item({ id: 's4' })],
    running: [item({ id: 'r' })], stuck: [],
    counts: { needsYou: 1, done: 4, running: 1, stuck: 0 }, unavailable: [],
  }
  return { ...base, ...over }
}

describe('今天(手机视图)', () => {
  it('夹具过真 schema', () => {
    expect(PHONE_API_SCHEMAS['GET /m/api/today']!.safeParse({ ok: true, today: today() }).success).toBe(true)
  })
  it('几个数一行;可能卡住为 0 不写;中英文', () => {
    expect(todayView(today(), NOW, 'zh-Hans')!.counts).toBe('1 件等你 · 4 件做完 · 1 件在跑')
    expect(todayView(today({ counts: { needsYou: 0, done: 2, running: 0, stuck: 3 } }), NOW, 'en')!.counts).toBe('0 need you · 2 done · 0 running · 3 may be stuck')
  })
  it('最近做完的前 3 件;点进现成页面:终端 ⇒ /terminal/[id],一起做 ⇒ /matter/[id]', () => {
    const v = todayView(today(), NOW, 'zh-Hans')!
    expect(v.done).toHaveLength(TODAY_DONE_ROWS)
    expect(v.done[0]).toEqual({ key: 'terminal:sess/1', href: '/terminal/sess%2F1', title: 'blog', sub: 'Claude Code · 改好了', ago: '5 分钟前' })
    expect(v.done[1]).toMatchObject({ href: '/matter/a1b2c3d4', title: '修打包', sub: 'Codex' })
    expect(todayHref({ source: 'together', id: 'x' })).toBe('/matter/x')
    expect(todayRow(item({ source: 'together', title: null, project: 'melu' }), NOW, 'en').title).toBe('melu')
  })
  it('没数据 / 什么都没有 ⇒ 不放这一段;有一路读不到 ⇒ 照放并标出来', () => {
    expect(todayView(undefined, NOW, 'en')).toBeNull()
    const empty = today({ needsYou: [], done: [], running: [], counts: { needsYou: 0, done: 0, running: 0, stuck: 0 } })
    expect(todayView(empty, NOW, 'en')).toBeNull()
    const partial = todayView({ ...empty, unavailable: ['terminal'] }, NOW, 'en')!
    expect(partial.partial).toBe(true)
    expect(partial.done).toEqual([])
  })
})
