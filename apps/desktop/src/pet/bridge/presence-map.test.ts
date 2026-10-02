import { describe, it, expect } from 'vitest'
import { presenceToPet } from './presence-map.js'

const P = (over: Record<string, unknown> = {}) => ({ presence: 'ok', activity: { kind: 'idle', label: '', since: null }, news: { unread: 0, latest_kind: null, latest_title: null }, ...over }) as any

describe('presenceToPet', () => {
  it('daemon 没起(拉不到)→ unlit sleep + 提示', () => {
    expect(presenceToPet(null, null)).toEqual({ form: 'unlit', behavior: 'sleep', props: [], badge: 0, hint: 'daemon 没起', oneShots: [] })
    expect(presenceToPet(P({ presence: 'down' }), null)).toMatchObject({ form: 'unlit', behavior: 'sleep', hint: 'daemon 没起' })
  })
  it('够得着 = Light(主人 2026-10-01 拍板,与此刻页同一个信号):ok / degraded / offline 都亮,不只在聊时亮', () => {
    for (const s of ['ok', 'degraded', 'offline']) expect(presenceToPet(P({ presence: s }), null).form).toBe('lit')
    for (const k of ['idle', 'chatting', 'working', 'visiting']) expect(presenceToPet(P({ activity: { kind: k, label: '', since: null } }), null).form).toBe('lit')
  })
  it('offline 指微信外发不通:CC 还在,不睡;挂 exclamation,开始时播一次 error,道具 / 角标保留', () => {
    const off = presenceToPet(P({ presence: 'offline', news: { unread: 2, latest_kind: 'hunt', latest_title: 't' } }), P())
    expect(off).toMatchObject({ form: 'lit', behavior: 'idle', props: ['exclamation', 'envelope'], badge: 2, hint: null, oneShots: ['error', 'receive'] })
    expect(presenceToPet(P({ presence: 'offline' }), P({ presence: 'offline' })).oneShots).toEqual([])
  })
  it('degraded:开始时播一次 error 并挂 exclamation;持续时不再播', () => {
    const first = presenceToPet(P({ presence: 'degraded' }), P())
    expect(first).toMatchObject({ behavior: 'idle', props: ['exclamation'], oneShots: ['error'] })
    const again = presenceToPet(P({ presence: 'degraded' }), P({ presence: 'degraded' }))
    expect(again.oneShots).toEqual([])
  })
  it('companion / working 的映射;working 不叠 laptop(帧自带)', () => {
    for (const k of ['hosting_human', 'visiting', 'hosting_peer']) expect(presenceToPet(P({ activity: { kind: k, label: '', since: null } }), null).behavior).toBe('companion')
    for (const k of ['foraging', 'working']) expect(presenceToPet(P({ activity: { kind: k, label: '', since: null } }), null)).toMatchObject({ behavior: 'working', props: [] })
    expect(presenceToPet(P(), null)).toMatchObject({ behavior: 'idle', props: [], hint: null })
  })
  it('unread 增加 → oneShots 含 receive;不变 / 减少不含;envelope 带 badge', () => {
    const r = presenceToPet(P({ news: { unread: 3, latest_kind: 'postcard', latest_title: 'x' } }), P({ news: { unread: 1, latest_kind: 'hunt', latest_title: 'y' } }))
    expect(r).toMatchObject({ props: ['envelope'], badge: 3, oneShots: ['receive'] })
    expect(presenceToPet(P({ news: { unread: 3, latest_kind: 'postcard', latest_title: 'x' } }), P({ news: { unread: 3, latest_kind: 'postcard', latest_title: 'x' } })).oneShots).toEqual([])
    expect(presenceToPet(P({ news: { unread: 0, latest_kind: null, latest_title: null } }), P({ news: { unread: 3, latest_kind: 'x', latest_title: 'y' } })).props).toEqual([])
    const both = presenceToPet(P({ presence: 'degraded', news: { unread: 1, latest_kind: 'hunt', latest_title: 't' } }), P())
    expect(both.props).toEqual(['exclamation', 'envelope']); expect(both.oneShots).toEqual(['error', 'receive'])
  })
  it('离线也会收到信:offline 下 unread 涨了照样播 receive', () => {
    const off = presenceToPet(
      P({ presence: 'offline', news: { unread: 3, latest_kind: 'postcard', latest_title: 'x' } }),
      P({ presence: 'offline', news: { unread: 2, latest_kind: 'hunt', latest_title: 'y' } }),
    )
    expect(off).toMatchObject({ form: 'lit', props: ['exclamation', 'envelope'], badge: 3, oneShots: ['receive'] })
  })
  it('拉不到(prev 是 down)不算基准:恢复后不凭空播 receive', () => {
    const down = P({ presence: 'down', news: { unread: 0, latest_kind: null, latest_title: null } })
    expect(presenceToPet(P({ news: { unread: 3, latest_kind: 'postcard', latest_title: 'x' } }), down).oneShots).toEqual([])
    expect(presenceToPet(P({ presence: 'offline', news: { unread: 3, latest_kind: 'postcard', latest_title: 'x' } }), down).oneShots).not.toContain('receive')
  })
})
