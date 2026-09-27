import { describe, it, expect } from 'vitest'
import { buildFeed, chatDayEvents, dayKey, decodeCursor, encodeCursor, hhmmOf, thoughtEvent, FEED_MAX_LIMIT, type TurnLite } from './mobile-feed'
import type { CatchRow } from '../core/journal-store'
import type { PlanLogEntry } from '../core/companion-plan'

const TZ = 'Asia/Shanghai'
const row = (over: Partial<CatchRow> = {}): CatchRow => ({
  id: 'j1', ts: '2026-09-06T02:43:36.412Z', chat_id: 'o', title: '一个好玩的东西', url: 'https://x', note: '', status: 'new', kind: 'hunt', image_svg: null, matter_id: null, ...over,
})
const plan = (over: Partial<PlanLogEntry> = {}): PlanLogEntry => ({
  at: '2026-09-06T03:03:55.347Z', chatId: 'o', candidates: ['visit'], decision: 'none', why: '通讯录里没朋友,先在家歇着。', source: 'model', ...over,
})
const ms = (iso: string) => Date.parse(iso)

describe('dayKey', () => {
  it('按伙伴时区分桶:UTC 16:20 在上海是次日', () => {
    expect(dayKey(ms('2026-09-03T16:20:01.418Z'), TZ)).toBe('2026-09-04')
    expect(dayKey(ms('2026-09-03T15:59:59.000Z'), TZ)).toBe('2026-09-03')
    expect(dayKey(ms('2026-09-03T16:20:01.418Z'), 'UTC')).toBe('2026-09-03')
  })
})

describe('hhmmOf (I3)', () => {
  it('跟 dayKey 用同一个伙伴时区,不是 UTC 也不是本地时区', () => {
    // 2026-09-03T16:20 UTC == 2026-09-04T00:20 Asia/Shanghai —— 跨了一天,
    // 时钟也该跟着分到次日的 00:20,而不是停在 UTC 的 16:20。
    expect(hhmmOf(ms('2026-09-03T16:20:01.418Z'), TZ)).toBe('00:20')
    expect(hhmmOf(ms('2026-09-03T16:20:01.418Z'), 'UTC')).toBe('16:20')
  })
})

describe('thoughtEvent', () => {
  it('model 的 why 是想法;title 随 decision;id 带 chatId', () => {
    expect(thoughtEvent(plan(), TZ)).toMatchObject({ id: 'thought:o:2026-09-06T03:03:55.347Z', kind: 'thought', title: '在家待着', note: '通讯录里没朋友,先在家歇着。', day: '2026-09-06', hhmm: '11:03' })
    expect(thoughtEvent(plan({ decision: 'hunt' }), TZ).title).toBe('出门打猎去了')
    expect(thoughtEvent(plan({ decision: 'visit' }), TZ).title).toBe('去串门了')
    expect(thoughtEvent(plan({ decision: 'gap' }), TZ).title).toBe('gap')
  })
  it('fallback / downgraded 不显示理由', () => {
    expect(thoughtEvent(plan({ decision: 'visit', why: 'fallback:timeout', source: 'fallback' }), TZ)).toMatchObject({ title: '去串门了', note: null })
    expect(thoughtEvent(plan({ source: 'downgraded' }), TZ).note).toBeNull()
  })
  it('(failed) / (skipped) → 想出门没走成,不给理由', () => {
    expect(thoughtEvent(plan({ decision: 'hunt', why: '(failed) 网断了' }), TZ)).toMatchObject({ title: '想出门,没走成', note: null })
    expect(thoughtEvent(plan({ decision: 'visit', why: '(skipped) 在忙' }), TZ)).toMatchObject({ title: '想出门,没走成', note: null })
  })
  it('两个聊天同一毫秒决策 → id 不撞车 (M2)', () => {
    const a = thoughtEvent(plan({ chatId: 'o' }), TZ)
    const b = thoughtEvent(plan({ chatId: 'g1' }), TZ)
    expect(a.id).not.toBe(b.id)
  })
  it('手改坏的 why(非字符串)不抛,当空理由处理 (M1)', () => {
    const bad = { ...plan(), why: undefined } as unknown as PlanLogEntry
    expect(() => thoughtEvent(bad, TZ)).not.toThrow()
    expect(thoughtEvent(bad, TZ)).toMatchObject({ title: '在家待着', note: null })
  })
})

describe('chatDayEvents', () => {
  const t = (chatId: string, iso: string, over: Partial<TurnLite> = {}): TurnLite =>
    ({ chatId, endedAt: ms(iso), outcome: 'completed', mode: 'solo', startedAt: ms(iso), ...over })
  it('一天一条,只算 completed,ts 取当天最后一回合', () => {
    const ev = chatDayEvents([
      t('o', '2026-09-05T01:00:00.000Z'), t('o', '2026-09-05T02:00:00.000Z'), t('o', '2026-09-05T03:00:00.000Z', { outcome: 'error' }),
    ], 'o', TZ)
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ id: 'chat_day:2026-09-05', kind: 'chat_day', title: '和主人聊了 2 回', ts: '2026-09-05T02:00:00.000Z', day: '2026-09-05', note: null })
  })
  it('三种 title:只主人 / 主人+客人 / 只客人;主人未知时全算客人', () => {
    const turns = [t('o', '2026-09-05T01:00:00.000Z'), t('g1', '2026-09-05T01:10:00.000Z'), t('g2', '2026-09-05T01:20:00.000Z'), t('g2', '2026-09-05T01:30:00.000Z')]
    expect(chatDayEvents(turns, 'o', TZ)[0]!.title).toBe('和主人聊了 1 回,还和 2 位客人聊了 3 回')
    expect(chatDayEvents(turns.slice(1), 'o', TZ)[0]!.title).toBe('和 2 位客人聊了 3 回')
    expect(chatDayEvents(turns, null, TZ)[0]!.title).toBe('和 3 位客人聊了 4 回')
  })
  it('跨 UTC 日界按伙伴时区分开', () => {
    const ev = chatDayEvents([t('o', '2026-09-05T15:00:00.000Z'), t('o', '2026-09-05T17:00:00.000Z')], 'o', TZ)
    expect(ev.map(e => e.day).sort()).toEqual(['2026-09-05', '2026-09-06'])
  })
  it('没有 completed 的天不出条目', () => {
    expect(chatDayEvents([t('o', '2026-09-05T01:00:00.000Z', { outcome: 'timeout' })], 'o', TZ)).toEqual([])
  })
  it('chatroom 模式整段跳过 —— 一个主人回合不该被轮数放大 (I1)', () => {
    const turns = [
      t('o', '2026-09-05T01:00:00.000Z'),
      t('o', '2026-09-05T01:01:00.000Z', { mode: 'chatroom' }),
      t('o', '2026-09-05T01:02:00.000Z', { mode: 'chatroom' }),
      t('o', '2026-09-05T01:03:00.000Z', { mode: 'chatroom' }),
    ]
    expect(chatDayEvents(turns, 'o', TZ)[0]!.title).toBe('和主人聊了 1 回')
  })
  it('parallel 模式同一 (chatId, startedAt) 折叠成一条 (I1)', () => {
    const started = ms('2026-09-05T01:00:00.000Z')
    const turns: TurnLite[] = [
      { chatId: 'o', startedAt: started, endedAt: started + 500, outcome: 'completed', mode: 'parallel' },
      { chatId: 'o', startedAt: started, endedAt: started + 800, outcome: 'completed', mode: 'parallel' },
      { chatId: 'o', startedAt: started, endedAt: started + 1200, outcome: 'completed', mode: 'parallel' },
    ]
    expect(chatDayEvents(turns, 'o', TZ)[0]!.title).toBe('和主人聊了 1 回')
  })
  it('parallel:不同 startedAt 各算一次', () => {
    const s1 = ms('2026-09-05T01:00:00.000Z')
    const s2 = ms('2026-09-05T02:00:00.000Z')
    const turns: TurnLite[] = [
      { chatId: 'o', startedAt: s1, endedAt: s1 + 500, outcome: 'completed', mode: 'parallel' },
      { chatId: 'o', startedAt: s1, endedAt: s1 + 800, outcome: 'completed', mode: 'parallel' },
      { chatId: 'o', startedAt: s2, endedAt: s2 + 500, outcome: 'completed', mode: 'parallel' },
    ]
    expect(chatDayEvents(turns, 'o', TZ)[0]!.title).toBe('和主人聊了 2 回')
  })
})

describe('cursor', () => {
  it('往返;坏串 → null', () => {
    const c = encodeCursor('2026-09-06T02:43:36.412Z', 'journal:j1')
    expect(decodeCursor(c)).toEqual({ ts: '2026-09-06T02:43:36.412Z', id: 'journal:j1' })
    expect(decodeCursor('not-base64!')).toBeNull()
    expect(decodeCursor(Buffer.from('no-separator').toString('base64url'))).toBeNull()
  })
})

describe('journal image_svg 读侧再消毒 (I6)', () => {
  const SAFE_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="1" cy="1" r="1"/></svg>'
  it('合规 SVG 原样透传', () => {
    const r = buildFeed({ journal: [row({ image_svg: SAFE_SVG })], thoughts: [], turns: [] }, { ownerChatId: 'o', timezone: TZ })
    expect(r.events[0]!.ref!.image_svg).toBe(SAFE_SVG)
  })
  it('手改坏的 svg(不合白名单)读侧被拦成 null', () => {
    const r = buildFeed({ journal: [row({ image_svg: '<svg onload="alert(1)"></svg>' })], thoughts: [], turns: [] }, { ownerChatId: 'o', timezone: TZ })
    expect(r.events[0]!.ref!.image_svg).toBeNull()
  })
})

describe('buildFeed', () => {
  const src = () => ({
    journal: [row(), row({ id: 'j2', ts: '2026-09-03T16:20:01.418Z', kind: 'visit', title: '去了小飞家', note: '见闻一段', url: null, image_svg: null })],
    thoughts: [plan(), plan({ at: '2026-09-06T02:43:36.412Z', decision: 'hunt', why: '去转转' })],
    turns: [{ chatId: 'o', endedAt: ms('2026-09-05T01:00:00.000Z'), outcome: 'completed', mode: 'solo', startedAt: ms('2026-09-05T01:00:00.000Z') }],
  })
  it('三源合并、ts 降序、同 ts 按 id 升序;journal 带 ref', () => {
    const r = buildFeed(src(), { ownerChatId: 'o', timezone: TZ })
    expect(r.events.map(e => e.id)).toEqual([
      'thought:o:2026-09-06T03:03:55.347Z', 'journal:j1', 'thought:o:2026-09-06T02:43:36.412Z', 'chat_day:2026-09-05', 'journal:j2',
    ])
    expect(r.events[1]).toMatchObject({ kind: 'hunt', ref: { url: 'https://x', image_svg: null, status: 'new' }, day: '2026-09-06' })
    expect(r.events[4]!.ref).toEqual({ url: null, image_svg: null, status: 'new' })
    expect(r.sources_degraded).toEqual([])
    expect(r.next_cursor).toBeNull()
  })
  it('分页:limit 切、next_cursor 接得上、同 ts 不丢不重', () => {
    const s = { journal: [row({ id: 'a', ts: '2026-09-06T02:43:36.412Z' }), row({ id: 'b', ts: '2026-09-06T02:43:36.412Z' }), row({ id: 'c', ts: '2026-09-06T02:43:36.412Z' })], thoughts: [], turns: [] }
    const p1 = buildFeed(s, { ownerChatId: 'o', timezone: TZ, limit: 2 })
    expect(p1.events.map(e => e.id)).toEqual(['journal:a', 'journal:b'])
    expect(p1.next_cursor).not.toBeNull()
    const p2 = buildFeed(s, { ownerChatId: 'o', timezone: TZ, limit: 2, cursor: p1.next_cursor })
    expect(p2.events.map(e => e.id)).toEqual(['journal:c'])
    expect(p2.next_cursor).toBeNull()
  })
  it('limit 夹到 [1, FEED_MAX_LIMIT]', () => {
    const s = { journal: Array.from({ length: 120 }, (_, i) => row({ id: `r${String(i).padStart(3, '0')}` })), thoughts: [], turns: [] }
    expect(buildFeed(s, { ownerChatId: 'o', timezone: TZ, limit: 999 }).events).toHaveLength(FEED_MAX_LIMIT)
    expect(buildFeed(s, { ownerChatId: 'o', timezone: TZ, limit: 0 }).events).toHaveLength(1)
  })
  it('unread 三源都算,按整个窗口而不是当前页', () => {
    const r = buildFeed(src(), { ownerChatId: 'o', timezone: TZ, limit: 1, seenUntil: '2026-09-05T12:00:00.000Z' })
    expect(r.unread).toBe(3)
    expect(buildFeed(src(), { ownerChatId: 'o', timezone: TZ, seenUntil: null }).unread).toBe(5)
  })
  it('某源为 null → 记 degraded,其余照给', () => {
    const r = buildFeed({ ...src(), thoughts: null }, { ownerChatId: 'o', timezone: TZ })
    expect(r.sources_degraded).toEqual(['thought'])
    expect(r.events.some(e => e.kind === 'thought')).toBe(false)
    expect(r.events).toHaveLength(3)
    const all = buildFeed({ journal: null, thoughts: null, turns: null }, { ownerChatId: 'o', timezone: TZ })
    expect(all.sources_degraded).toEqual(['journal', 'thought', 'chat_day'])
    expect(all.events).toEqual([])
  })
})
