import { describe, it, expect } from 'vitest'
import { derivePresence, ACTIVE_WINDOW_MS, type PresenceInputs } from './companion-presence'

const NOW = Date.parse('2026-09-03T10:00:00.000Z')
const base = (over: Partial<PresenceInputs> = {}): PresenceInputs => ({
  nowMs: NOW,
  ownerChatId: 'owner',
  sessions: [],
  busyLabels: [],
  visit: null,
  outbound: 'ok',
  subsystemsDegraded: 0,
  journal: { unread: 0, latest: null },
  ...over,
})

describe('derivePresence — presence 轴', () => {
  it('一切正常 → ok', () => { expect(derivePresence(base()).presence).toBe('ok') })
  it('外发 degraded → offline(唯一诚实的「微信断了」信号)', () => {
    expect(derivePresence(base({ outbound: 'degraded' })).presence).toBe('offline')
  })
  it('子系统有降级 → degraded;外发 degraded 压过它', () => {
    expect(derivePresence(base({ subsystemsDegraded: 1 })).presence).toBe('degraded')
    expect(derivePresence(base({ subsystemsDegraded: 1, outbound: 'degraded' })).presence).toBe('offline')
  })
  it('outbound unknown / null 不算断 → ok', () => {
    expect(derivePresence(base({ outbound: 'unknown' })).presence).toBe('ok')
    expect(derivePresence(base({ outbound: null })).presence).toBe('ok')
  })
})

describe('derivePresence — activity 轴:每种一条', () => {
  it('什么都没有 → idle,label 空', () => {
    const a = derivePresence(base()).activity
    expect(a).toEqual({ kind: 'idle', label: '', since: null })
  })
  it('主人会话在窗口内 → chatting,since = lastUsedAt', () => {
    const a = derivePresence(base({ sessions: [{ chatId: 'owner', lastUsedAt: NOW - 1000 }] })).activity
    expect(a.kind).toBe('chatting')
    expect(a.label).toBe('在跟你聊')
    expect(a.since).toBe(new Date(NOW - 1000).toISOString())
  })
  it('非主人会话在窗口内 → hosting_human', () => {
    const a = derivePresence(base({ sessions: [{ chatId: 'friend', lastUsedAt: NOW - 1000 }] })).activity
    expect(a.kind).toBe('hosting_human')
    expect(a.label).toBe('家里有客人')
  })
  it('我去串门 → visiting,label 带对方', () => {
    const a = derivePresence(base({ visit: { id: 'v1', peerLabel: '邻居「阿柚」', hosting: false, sinceMs: NOW - 5000 } })).activity
    expect(a.kind).toBe('visiting')
    expect(a.label).toBe('去邻居「阿柚」家串门了')
    expect(a.since).toBe(new Date(NOW - 5000).toISOString())
  })
  it('别人来串门 → hosting_peer', () => {
    const a = derivePresence(base({ visit: { id: 'v1', peerLabel: '第 1 度的朋友', hosting: true, sinceMs: NOW } })).activity
    expect(a.kind).toBe('hosting_peer')
    expect(a.label).toBe('第 1 度的朋友来串门了')
  })
  it('busy 里有 hunt 或 social-forage → foraging', () => {
    expect(derivePresence(base({ busyLabels: ['hunt'] })).activity).toMatchObject({ kind: 'foraging', label: '觅食中', since: null })
    expect(derivePresence(base({ busyLabels: ['social-forage'] })).activity.kind).toBe('foraging')
  })
  it('其它已知 / 未知 label → working', () => {
    expect(derivePresence(base({ busyLabels: ['a2a-delegate'] })).activity).toMatchObject({ kind: 'working', label: '在忙一件事' })
    expect(derivePresence(base({ busyLabels: ['something-new'] })).activity.kind).toBe('working')
  })
})

describe('derivePresence — 过滤与窗口', () => {
  it('api:* 和 companion-* 不是伙伴的活动 → idle', () => {
    const a = derivePresence(base({ busyLabels: ['api:POST /v1/journal/seen', 'companion-push', 'companion-introspect'] })).activity
    expect(a.kind).toBe('idle')
  })
  it('会话超过 ACTIVE_WINDOW_MS → 不算在聊', () => {
    const a = derivePresence(base({ sessions: [{ chatId: 'owner', lastUsedAt: NOW - ACTIVE_WINDOW_MS - 1 }] })).activity
    expect(a.kind).toBe('idle')
  })
  it('刚好在窗口边界内 → 算', () => {
    const a = derivePresence(base({ sessions: [{ chatId: 'owner', lastUsedAt: NOW - ACTIVE_WINDOW_MS }] })).activity
    expect(a.kind).toBe('chatting')
  })
  it('没有 ownerChatId 时所有活跃会话都算客人', () => {
    const a = derivePresence(base({ ownerChatId: null, sessions: [{ chatId: 'x', lastUsedAt: NOW }] })).activity
    expect(a.kind).toBe('hosting_human')
  })
})

describe('derivePresence — 优先级', () => {
  const visiting = { id: 'v', peerLabel: 'P', hosting: false, sinceMs: NOW }
  it('chatting 压 visiting:串门途中回你消息,画面回到玻璃前', () => {
    const a = derivePresence(base({ sessions: [{ chatId: 'owner', lastUsedAt: NOW }], visit: visiting })).activity
    expect(a.kind).toBe('chatting')
  })
  it('hosting_human 压 visiting', () => {
    const a = derivePresence(base({ sessions: [{ chatId: 'f', lastUsedAt: NOW }], visit: visiting })).activity
    expect(a.kind).toBe('hosting_human')
  })
  it('visiting 压 foraging', () => {
    expect(derivePresence(base({ visit: visiting, busyLabels: ['hunt'] })).activity.kind).toBe('visiting')
  })
  it('foraging 压 working', () => {
    expect(derivePresence(base({ busyLabels: ['a2a-delegate', 'hunt'] })).activity.kind).toBe('foraging')
  })
})

describe('derivePresence — news 轴', () => {
  it('原样透传,latest 拆成 kind / title', () => {
    const n = derivePresence(base({ journal: { unread: 3, latest: { kind: 'visit', title: '去阿柚家串门', ts: '2026-09-03T09:00:00.000Z' } } })).news
    expect(n).toEqual({ unread: 3, latest_kind: 'visit', latest_title: '去阿柚家串门' })
  })
  it('空表 → 0 / null / null', () => {
    expect(derivePresence(base()).news).toEqual({ unread: 0, latest_kind: null, latest_title: null })
  })
})
