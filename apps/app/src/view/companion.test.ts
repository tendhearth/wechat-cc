import { describe, it, expect } from 'vitest'
import { FeedEvent } from '@wechat-cc/protocol'
import type { FeedEventT } from '../backend/types'
import { COMPANION_FRESH_MS, companionCard, companionSignature, companionStatus } from './companion'

const NOW = Date.parse('2026-10-18T12:00:00.000Z')
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const ev = (o: Partial<FeedEventT> & Pick<FeedEventT, 'id' | 'kind'>): FeedEventT => FeedEvent.parse({ ts: iso(60_000), title: 'A find', note: null, day: '2026-10-18', hhmm: '11:59', ...o })

describe('CC 下面那一行:没信号 ⇒ 不说', () => {
  it('不是真的 / 现在的数据 ⇒ 无论 activity 是什么都不说', () => {
    for (const activity of ['chatting', 'working', 'foraging', 'idle', null]) expect(companionStatus({ known: false, activity, running: 3 })).toBeNull()
  })
  it('歇着 / 没 presence / 认不出的 kind(比如以前演示里的 waiting、原型链上的键)⇒ 不说', () => {
    for (const activity of ['idle', null, undefined, 'waiting', 'constructor', 'toString']) expect(companionStatus({ known: true, activity, running: 0 })).toBeNull()
  })
  it('每种真 activity 各有一句', () => {
    expect(companionStatus({ known: true, activity: 'chatting', running: 0 })).toBe('companion.chatting')
    expect(companionStatus({ known: true, activity: 'hosting_human', running: 0 })).toBe('companion.hostingHuman')
    expect(companionStatus({ known: true, activity: 'visiting', running: 0 })).toBe('companion.visiting')
    expect(companionStatus({ known: true, activity: 'hosting_peer', running: 0 })).toBe('companion.hostingPeer')
    expect(companionStatus({ known: true, activity: 'foraging', running: 0 })).toBe('companion.foraging')
    expect(companionStatus({ known: true, activity: 'working', running: 0 })).toBe('companion.busy')
  })
  it('执行者正在写(running > 0)⇒「在帮你做事」;但正在跟人说话优先', () => {
    expect(companionStatus({ known: true, activity: 'idle', running: 2 })).toBe('companion.working')
    expect(companionStatus({ known: true, activity: 'foraging', running: 1 })).toBe('companion.working')
    expect(companionStatus({ known: true, activity: 'working', running: 1 })).toBe('companion.working')
    expect(companionStatus({ known: true, activity: 'chatting', running: 1 })).toBe('companion.chatting')
    expect(companionStatus({ known: true, activity: 'hosting_human', running: 1 })).toBe('companion.hostingHuman')
  })
})

describe('带回来的那张卡', () => {
  const hunt = ev({ id: 'journal:1', kind: 'hunt', title: '**An essay**', note: 'Worth a read', ref: { url: 'https://example.com/a', image_svg: null, status: 'new' } })
  it('取最新一张打猎 / 明信片;想法、聊天日摘要、串门跳过', () => {
    const events = [ev({ id: 'thought:x', kind: 'thought', ts: iso(1000) }), ev({ id: 'chat_day:d', kind: 'chat_day', ts: iso(2000) }), ev({ id: 'journal:v', kind: 'visit', ts: iso(3000) }), hunt]
    expect(companionCard(events, null, NOW)).toEqual({ id: 'journal:1', kind: 'hunt', ts: hunt.ts, at: Date.parse(hunt.ts), title: 'An essay', note: 'Worth a read', url: 'https://example.com/a' })
    expect(companionCard([ev({ id: 'journal:p', kind: 'postcard', title: 'From Mia' })], null, NOW)).toMatchObject({ kind: 'postcard', title: 'From Mia', url: null, note: null })
  })
  it('没有动态 / 只有别的种类 ⇒ 不出现', () => {
    expect(companionCard(undefined, null, NOW)).toBeNull()
    expect(companionCard([], null, NOW)).toBeNull()
    expect(companionCard([ev({ id: 'thought:x', kind: 'thought' })], null, NOW)).toBeNull()
  })
  it('电脑上的水位已过它 ⇒ 不出现;更旧的也不翻出来', () => {
    const older = ev({ id: 'journal:0', kind: 'postcard', ts: iso(10 * 60_000) })
    expect(companionCard([hunt, older], hunt.ts, NOW)).toBeNull()
    expect(companionCard([hunt, older], iso(30_000), NOW)).toBeNull()
    expect(companionCard([hunt, older], iso(5 * 60_000), NOW)?.id).toBe('journal:1')
  })
  it('本机刚点过(电脑还没回话)也算看过', () => {
    expect(companionCard([hunt], null, NOW, hunt.ts)).toBeNull()
    expect(companionCard([hunt], null, NOW, iso(5 * 60_000))?.id).toBe('journal:1')
  })
  it('水位从没设过时,太旧的不算新;设过水位就按水位', () => {
    const old = ev({ id: 'journal:old', kind: 'hunt', ts: iso(COMPANION_FRESH_MS + 1000) })
    expect(companionCard([old], null, NOW)).toBeNull()
    expect(companionCard([old], iso(COMPANION_FRESH_MS * 2), NOW)?.id).toBe('journal:old')
  })
  it('只认 http(s) 链接;标题读成纯文本,读空的跳过', () => {
    const bad = ev({ id: 'journal:2', kind: 'hunt', ref: { url: 'javascript:alert(1)', image_svg: null, status: 'new' } })
    expect(companionCard([bad], null, NOW)?.url).toBeNull()
    expect(companionCard([ev({ id: 'journal:3', kind: 'hunt', title: '   ' }), hunt], null, NOW)?.id).toBe('journal:1')
  })
})

describe('首屏什么时候重拉', () => {
  it('只看未读数和最新游标;CC 在干什么变了不重拉(状态行直接读主题)', () => {
    const a = companionSignature({ unread: 1, nextCursor: 'c1' })
    expect(companionSignature(undefined)).toBeNull()
    expect(companionSignature({ unread: 2, nextCursor: 'c1' })).not.toBe(a)
    expect(companionSignature({ unread: 1, nextCursor: 'c2' })).not.toBe(a)
    expect(companionSignature({ unread: 1, nextCursor: 'c1', presenceState: { level: 'ok', activity: 'working' } } as never)).toBe(a)
  })
})
