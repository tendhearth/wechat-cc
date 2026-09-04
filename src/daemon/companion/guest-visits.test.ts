import { describe, it, expect } from 'vitest'
import { dueGuestVisit, guestLabel, GUEST_IDLE_MS } from './guest-visits'

const T0 = Date.parse('2026-09-03T10:00:00.000Z')
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString()
const snap = (overrides: Partial<Parameters<typeof dueGuestVisit>[0]> = {}) => ({
  chatId: 'friend@im.wechat',
  latestInboundTs: iso(-40 * 60_000),
  since: [
    { direction: 'in' as const, text: '在吗', ts: iso(-45 * 60_000) },
    { direction: 'out' as const, text: '在的', ts: iso(-44 * 60_000) },
    { direction: 'in' as const, text: '想问问那个工具', ts: iso(-40 * 60_000) },
  ],
  ...overrides,
})

describe('dueGuestVisit —— 什么算「一次做客结束了」', () => {
  it('客人走了 30 分钟、说了 ≥2 句、还没讲过 → 该讲', () => {
    expect(dueGuestVisit(snap(), { narrated: {} }, T0)).toHaveLength(3)
  })
  it('**还在聊(最后一句不到 30 分钟)→ 不讲**', () => {
    expect(dueGuestVisit(snap({ latestInboundTs: iso(-5 * 60_000) }), { narrated: {} }, T0)).toBeNull()
  })
  it('只说了一句「在吗」→ 不算做客', () => {
    const s = snap({ since: [{ direction: 'in', text: '在吗', ts: iso(-40 * 60_000) }] })
    expect(dueGuestVisit(s, { narrated: {} }, T0)).toBeNull()
  })
  it('讲过了、之后没新消息 → 不重复讲', () => {
    expect(dueGuestVisit(snap(), { narrated: { 'friend@im.wechat': iso(-40 * 60_000) } }, T0)).toBeNull()
  })
  it('讲过一次之后又来聊 → 只讲水位之后的那段', () => {
    const s = snap({
      latestInboundTs: iso(-31 * 60_000),
      since: [
        ...snap().since,
        { direction: 'in', text: '又来了', ts: iso(-33 * 60_000) },
        { direction: 'in', text: '再问一句', ts: iso(-31 * 60_000) },
      ],
    })
    const fresh = dueGuestVisit(s, { narrated: { 'friend@im.wechat': iso(-40 * 60_000) } }, T0)
    expect(fresh!.map(m => m.text)).toEqual(['又来了', '再问一句'])
  })
  it('没有入站 → 否;坏时间戳 → 否', () => {
    expect(dueGuestVisit(snap({ latestInboundTs: null }), { narrated: {} }, T0)).toBeNull()
    expect(dueGuestVisit(snap({ latestInboundTs: 'nope' }), { narrated: {} }, T0)).toBeNull()
  })
  it('GUEST_IDLE_MS 是 30 分钟', () => { expect(GUEST_IDLE_MS).toBe(30 * 60_000) })
})

describe('guestLabel', () => {
  it('有名字用名字;没有就截 chatId 前几位', () => {
    expect(guestLabel('小王', 'x@im.wechat')).toBe('小王')
    expect(guestLabel(null, 'o9cq800sObd3@im.wechat')).toBe('「o9cq80…」那位')
  })
})
