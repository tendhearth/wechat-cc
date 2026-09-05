import { describe, it, expect } from 'vitest'
import { presenceToPet } from './presence-map.js'

const P = (over: Record<string, unknown> = {}) => ({ presence: 'ok', activity: { kind: 'idle', label: '', since: null }, news: { unread: 0, latest_kind: null, latest_title: null }, ...over }) as any

describe('presenceToPet(Phase A:只有处境)', () => {
  it('daemon 没起 → unlit sleep + 提示;offline → unlit sleep,道具保留', () => {
    expect(presenceToPet(null, null)).toEqual({ form: 'unlit', behavior: 'sleep', props: [], badge: 0, hint: 'daemon 没起', oneShots: [] })
    expect(presenceToPet(P({ presence: 'down' }), null).hint).toBe('daemon 没起')
    const off = presenceToPet(P({ presence: 'offline', news: { unread: 2, latest_kind: 'hunt', latest_title: 't' } }), null)
    expect(off).toMatchObject({ form: 'unlit', behavior: 'sleep', props: ['envelope'], badge: 2, hint: null })
  })
  it('degraded:开始时播一次 error 并挂 exclamation;持续时不再播', () => {
    const first = presenceToPet(P({ presence: 'degraded' }), P())
    expect(first).toMatchObject({ behavior: 'idle', props: ['exclamation'], oneShots: ['error'] })
    const again = presenceToPet(P({ presence: 'degraded' }), P({ presence: 'degraded' }))
    expect(again.oneShots).toEqual([])
  })
  it('chatting → lit;其它 → unlit;companion / working 的映射;laptop 只在 working', () => {
    expect(presenceToPet(P({ activity: { kind: 'chatting', label: '在跟你聊', since: null } }), null)).toMatchObject({ form: 'lit', behavior: 'idle' })
    for (const k of ['hosting_human', 'visiting', 'hosting_peer']) expect(presenceToPet(P({ activity: { kind: k, label: '', since: null } }), null).behavior).toBe('companion')
    for (const k of ['foraging', 'working']) expect(presenceToPet(P({ activity: { kind: k, label: '', since: null } }), null)).toMatchObject({ form: 'unlit', behavior: 'working', props: ['laptop'] })
    expect(presenceToPet(P(), null)).toMatchObject({ form: 'unlit', behavior: 'idle', props: [], hint: null })
  })
  it('unread 增加 → oneShots 含 receive;不变 / 减少不含;envelope 带 badge', () => {
    const r = presenceToPet(P({ news: { unread: 3, latest_kind: 'postcard', latest_title: 'x' } }), P({ news: { unread: 1, latest_kind: 'hunt', latest_title: 'y' } }))
    expect(r).toMatchObject({ props: ['envelope'], badge: 3, oneShots: ['receive'] })
    expect(presenceToPet(P({ news: { unread: 3, latest_kind: 'postcard', latest_title: 'x' } }), P({ news: { unread: 3, latest_kind: 'postcard', latest_title: 'x' } })).oneShots).toEqual([])
    expect(presenceToPet(P({ news: { unread: 0, latest_kind: null, latest_title: null } }), P({ news: { unread: 3, latest_kind: 'x', latest_title: 'y' } })).props).toEqual([])
    const both = presenceToPet(P({ presence: 'degraded', news: { unread: 1, latest_kind: 'hunt', latest_title: 't' } }), P())
    expect(both.props).toEqual(['exclamation', 'envelope']); expect(both.oneShots).toEqual(['error', 'receive'])
  })
})
