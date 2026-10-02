import { describe, it, expect } from 'vitest'
import { initialBridgeState, mergeIntent, recentContact, RECENT_CONTACT_MS } from './runtime-events.js'

const T0 = Date.parse('2026-09-05T10:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
// 够得着的 presence 自带 lit(presence-map.js);拉不到的是 unlit + sleep。
const presenceIdle = { form: 'lit' as const, behavior: 'idle' as const, props: [], badge: 0, hint: null, oneShots: [] }
const presenceDown = { form: 'unlit' as const, behavior: 'sleep' as const, props: [], badge: 0, hint: 'daemon 没起', oneShots: [] }
const turn = (over: Record<string, unknown> = {}) => ({ owner_last_contact_at: null, turn: { phase: 'idle' as const, since: null }, last_done_at: null, pending_permissions: [], ...over }) as any

describe('mergeIntent', () => {
  it('端点没接线 → 原样透传 presence', () => {
    const r = mergeIntent({ presence: presenceIdle, turn: null, state: initialBridgeState(), nowMs: T0 })
    expect(r.intent).toEqual(presenceIdle); expect(r.permission).toBeNull(); expect(r.state.initialized).toBe(false)
  })
  it('明暗只看 presence(够得着 = lit),不看多久没说话:20 分钟以上没联系照样亮', () => {
    const r = mergeIntent({ presence: presenceIdle, turn: turn({ owner_last_contact_at: iso(T0 - 3 * RECENT_CONTACT_MS) }), state: initialBridgeState(), nowMs: T0 })
    expect(r.intent.form).toBe('lit')
    const never = mergeIntent({ presence: presenceIdle, turn: turn(), state: r.state, nowMs: T0 + 10 })
    expect(never.intent.form).toBe('lit')
    const down = mergeIntent({ presence: presenceDown, turn: turn({ owner_last_contact_at: iso(T0) }), state: r.state, nowMs: T0 + 20 })
    expect(down.intent.form).toBe('unlit'); expect(down.intent.behavior).toBe('sleep')
  })
  it('首次只记不播;之后联系前进 → receive + micro-light', () => {
    const r1 = mergeIntent({ presence: presenceIdle, turn: turn({ owner_last_contact_at: iso(T0 - 60_000) }), state: initialBridgeState(), nowMs: T0 })
    expect(r1.intent.oneShots).toEqual([]); expect(r1.state).toMatchObject({ lastContactMs: T0 - 60_000, initialized: true })
    const r2 = mergeIntent({ presence: presenceIdle, turn: turn({ owner_last_contact_at: iso(T0 + 1000) }), state: r1.state, nowMs: T0 + 2000 })
    expect(r2.intent.form).toBe('lit'); expect(r2.intent.oneShots).toEqual(['receive']); expect(r2.intent.props).toContain('micro-light')
  })
  it('睡着(拉不到 presence)时联系前进也不播 receive,只记下', () => {
    const r1 = mergeIntent({ presence: presenceDown, turn: turn({ owner_last_contact_at: iso(T0) }), state: initialBridgeState(), nowMs: T0 })
    const r2 = mergeIntent({ presence: presenceDown, turn: turn({ owner_last_contact_at: iso(T0 + 1000) }), state: r1.state, nowMs: T0 + 2000 })
    expect(r2.intent.oneShots).toEqual([]); expect(r2.state.lastContactMs).toBe(T0 + 1000)
  })
  it('turn 阶段压过 presence 的 working / companion;presence 的 sleep(down)压过 turn', () => {
    const s = { ...initialBridgeState(), lastContactMs: T0, initialized: true }
    const working = { ...presenceIdle, behavior: 'working' as const, props: ['laptop'] }
    expect(mergeIntent({ presence: working, turn: turn({ owner_last_contact_at: iso(T0), turn: { phase: 'thinking', since: 's' } }), state: s, nowMs: T0 }).intent.behavior).toBe('thinking')
    expect(mergeIntent({ presence: working, turn: turn({ owner_last_contact_at: iso(T0), turn: { phase: 'permission', since: 's' }, pending_permissions: [{ hash: 'a', prompt: 'p', since: 's', expires_at: 'e' }] }), state: s, nowMs: T0 }).intent.behavior).toBe('permission')
    expect(mergeIntent({ presence: presenceDown, turn: turn({ turn: { phase: 'working', since: 's' } }), state: s, nowMs: T0 }).intent.behavior).toBe('sleep')
  })
  it('done 只在 last_done_at 前进时播一次;首次只记不播;permission 取最早一条 + 计数', () => {
    const r1 = mergeIntent({ presence: presenceIdle, turn: turn({ last_done_at: iso(T0) }), state: initialBridgeState(), nowMs: T0 })
    expect(r1.intent.oneShots).toEqual([])
    const r2 = mergeIntent({ presence: presenceIdle, turn: turn({ last_done_at: iso(T0 + 5000) }), state: r1.state, nowMs: T0 + 6000 })
    expect(r2.intent.oneShots).toEqual(['done'])
    const r3 = mergeIntent({ presence: presenceIdle, turn: turn({ last_done_at: iso(T0 + 5000) }), state: r2.state, nowMs: T0 + 8000 })
    expect(r3.intent.oneShots).toEqual([])
    const p = [{ hash: 'a', prompt: 'p1', since: '1', expires_at: 'e' }, { hash: 'b', prompt: 'p2', since: '2', expires_at: 'e' }]
    const r4 = mergeIntent({ presence: presenceIdle, turn: turn({ turn: { phase: 'permission', since: '1' }, pending_permissions: p }), state: r3.state, nowMs: T0 })
    expect(r4.permission?.hash).toBe('a'); expect(r4.permissionCount).toBe(2)
  })
  it('lastContactMs 是单调高水位:daemon 重启吐出更早的联系时间不算前进,不误播 receive', () => {
    const r1 = mergeIntent({ presence: presenceIdle, turn: turn({ owner_last_contact_at: iso(T0 + 60_000) }), state: initialBridgeState(), nowMs: T0 + 60_000 })
    expect(r1.state.lastContactMs).toBe(T0 + 60_000)
    const r2 = mergeIntent({ presence: presenceIdle, turn: turn({ owner_last_contact_at: iso(T0) }), state: r1.state, nowMs: T0 + 60_000 })
    expect(r2.intent.oneShots).toEqual([]); expect(r2.state.lastContactMs).toBe(T0 + 60_000)
    const r3 = mergeIntent({ presence: presenceIdle, turn: turn({ owner_last_contact_at: iso(T0 + 60_000) }), state: r2.state, nowMs: T0 + 60_000 })
    expect(r3.intent.oneShots).toEqual([]); expect(r3.state.lastContactMs).toBe(T0 + 60_000)
  })
  it('lastDoneMs 是单调高水位:更早的 last_done_at 重现不算前进,不误播第二次 done', () => {
    const r1 = mergeIntent({ presence: presenceIdle, turn: turn({ last_done_at: iso(T0 + 5000) }), state: initialBridgeState(), nowMs: T0 })
    expect(r1.state.lastDoneMs).toBe(T0 + 5000)
    const r2 = mergeIntent({ presence: presenceIdle, turn: turn({ last_done_at: iso(T0) }), state: r1.state, nowMs: T0 })
    expect(r2.intent.oneShots).toEqual([]); expect(r2.state.lastDoneMs).toBe(T0 + 5000)
    const r3 = mergeIntent({ presence: presenceIdle, turn: turn({ last_done_at: iso(T0 + 5000) }), state: r2.state, nowMs: T0 })
    expect(r3.intent.oneShots).toEqual([]); expect(r3.state.lastDoneMs).toBe(T0 + 5000)
  })
  it('已经初始化过之后拉不到端点:画面照 presence,不播一次性,state 不变', () => {
    const s = { ...initialBridgeState(), lastContactMs: T0, lastDoneMs: T0, initialized: true }
    const r = mergeIntent({ presence: presenceIdle, turn: null, state: s, nowMs: T0 + 2000 })
    expect(r.intent).toEqual(presenceIdle)
    expect(r.state).toEqual(s)
    expect(r.permission).toBeNull(); expect(r.permissionCount).toBe(0)
  })
})

describe('recentContact(只决定轮询快慢,不管明暗)', () => {
  it('窗口内为真;没有联系 / 超窗为假', () => {
    expect(recentContact({ ...initialBridgeState(), lastContactMs: T0 }, T0 + RECENT_CONTACT_MS)).toBe(true)
    expect(recentContact({ ...initialBridgeState(), lastContactMs: T0 }, T0 + RECENT_CONTACT_MS + 1)).toBe(false)
    expect(recentContact(initialBridgeState(), T0)).toBe(false)
  })
})
