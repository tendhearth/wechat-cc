import { describe, it, expect } from 'vitest'
import { initialBridgeState, mergeIntent, LIT_DIM_MS } from './runtime-events.js'

const T0 = Date.parse('2026-09-05T10:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
const presenceIdle = { form: 'unlit' as const, behavior: 'idle' as const, props: [], badge: 0, hint: null, oneShots: [] }
const turn = (over: Record<string, unknown> = {}) => ({ owner_last_contact_at: null, turn: { phase: 'idle' as const, since: null }, last_done_at: null, pending_permissions: [], ...over }) as any

describe('mergeIntent', () => {
  it('端点没接线 → 原样透传 presence', () => {
    const r = mergeIntent({ presence: presenceIdle, turn: null, state: initialBridgeState(), nowMs: T0 })
    expect(r.intent).toEqual(presenceIdle); expect(r.permission).toBeNull(); expect(r.state.initialized).toBe(false)
  })
  it('首次:按联系时间直接算 form,不播一次性;之后联系前进 → unlit 亮起 / lit 只 receive + micro-light', () => {
    const s0 = initialBridgeState()
    const r1 = mergeIntent({ presence: presenceIdle, turn: turn({ owner_last_contact_at: iso(T0 - 60_000) }), state: s0, nowMs: T0 })
    expect(r1.intent.form).toBe('lit'); expect(r1.intent.oneShots).toEqual([]); expect(r1.state).toMatchObject({ form: 'lit', initialized: true })
    const r2 = mergeIntent({ presence: presenceIdle, turn: turn({ owner_last_contact_at: iso(T0 + 1000) }), state: r1.state, nowMs: T0 + 2000 })
    expect(r2.intent.form).toBe('lit'); expect(r2.intent.oneShots).toEqual(['receive']); expect(r2.intent.props).toContain('micro-light')
    const old = mergeIntent({ presence: presenceIdle, turn: turn({ owner_last_contact_at: iso(T0 - 3 * LIT_DIM_MS) }), state: s0, nowMs: T0 })
    expect(old.intent.form).toBe('unlit')
    const lit = mergeIntent({ presence: presenceIdle, turn: turn({ owner_last_contact_at: iso(T0) }), state: old.state, nowMs: T0 + 10 })
    expect(lit.intent.form).toBe('lit'); expect(lit.intent.oneShots).toEqual([])   // 亮起靠 setForm 的转场,不加 receive
  })
  it('退潮:lit 超过 LIT_DIM_MS 无联系且 turn idle 且无权限 → unlit;在飞或有权限则不退', () => {
    const s = { ...initialBridgeState(), form: 'lit' as const, lastContactMs: T0 - LIT_DIM_MS - 1, initialized: true }
    expect(mergeIntent({ presence: presenceIdle, turn: turn({ owner_last_contact_at: iso(T0 - LIT_DIM_MS - 1) }), state: s, nowMs: T0 }).intent.form).toBe('unlit')
    expect(mergeIntent({ presence: presenceIdle, turn: turn({ owner_last_contact_at: iso(T0 - LIT_DIM_MS - 1), turn: { phase: 'thinking', since: 's' } }), state: s, nowMs: T0 }).intent.form).toBe('lit')
    expect(mergeIntent({ presence: presenceIdle, turn: turn({ owner_last_contact_at: iso(T0 - LIT_DIM_MS - 1), pending_permissions: [{ hash: 'a', prompt: 'p', since: 's', expires_at: 'e' }] }), state: s, nowMs: T0 }).intent.form).toBe('lit')
  })
  it('turn 阶段压过 presence 的 working / companion;presence 的 sleep(offline / down)压过 turn', () => {
    const s = { ...initialBridgeState(), form: 'lit' as const, lastContactMs: T0, initialized: true }
    const working = { ...presenceIdle, behavior: 'working' as const, props: ['laptop'] }
    expect(mergeIntent({ presence: working, turn: turn({ owner_last_contact_at: iso(T0), turn: { phase: 'thinking', since: 's' } }), state: s, nowMs: T0 }).intent.behavior).toBe('thinking')
    expect(mergeIntent({ presence: working, turn: turn({ owner_last_contact_at: iso(T0), turn: { phase: 'permission', since: 's' }, pending_permissions: [{ hash: 'a', prompt: 'p', since: 's', expires_at: 'e' }] }), state: s, nowMs: T0 }).intent.behavior).toBe('permission')
    const sleeping = { ...presenceIdle, behavior: 'sleep' as const, hint: 'daemon 没起' }
    expect(mergeIntent({ presence: sleeping, turn: turn({ turn: { phase: 'working', since: 's' } }), state: s, nowMs: T0 }).intent.behavior).toBe('sleep')
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
    expect(r1.intent.form).toBe('lit'); expect(r1.state.lastContactMs).toBe(T0 + 60_000)
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
})
