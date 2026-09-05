import { describe, it, expect } from 'vitest'
import { createPetBridge } from './pet-bridge.js'

const presence = (unread: number, kind = 'idle') => ({ presence: 'online', activity: { kind }, news: { unread } }) as any
const turnAt = (phase: 'idle' | 'thinking' = 'idle', pending: any[] = [], contact: string | null = null) => ({
  owner_last_contact_at: contact, turn: { phase, since: null }, last_done_at: null, pending_permissions: pending,
}) as any

describe('createPetBridge', () => {
  it('一次性动作只播一次:presence 那拍有 receive,后面的 pet 拍没有', () => {
    const b = createPetBridge({ now: () => 1_000 })
    b.notePresence(presence(0))
    b.tick(null)
    b.notePresence(presence(1))
    expect(b.tick(turnAt()).intent.oneShots).toContain('receive')
    // pet 端点每 2 秒来一拍;presence 还没换,不清 oneShots 的话这里会再播一次。
    expect(b.tick(turnAt()).intent.oneShots).toEqual([])
    expect(b.tick(turnAt()).intent.badge).toBe(1)
  })
  it('拉不到 daemon(down)不当基准:恢复后不凭空播「收到信」', () => {
    const b = createPetBridge({ now: () => 1_000 })
    b.notePresence(presence(2))
    b.tick(null)
    b.notePresence({ presence: 'down', news: { unread: 0 } } as any)
    expect(b.tick(null).intent.behavior).toBe('sleep')
    b.notePresence(presence(2))
    expect(b.tick(null).intent.oneShots).toEqual([])
  })
  it('快档:亮着 / 有轮次 / 有待决权限任一为真', () => {
    const b = createPetBridge({ now: () => 1_000 })
    b.notePresence(presence(0))
    expect(b.tick(turnAt()).fast).toBe(false)
    expect(b.tick(turnAt('thinking')).fast).toBe(true)
    const item = { hash: 'h', prompt: 'p', since: 's', expires_at: 'e' }
    const withPerm = b.tick(turnAt('idle', [item]))
    expect(withPerm.fast).toBe(true)
    expect(withPerm.permission).toEqual(item)
    expect(withPerm.permissionCount).toBe(1)
    // 刚说过话 → lit,端点闲着也保持快档(等着看它动起来)。
    expect(b.tick(turnAt('idle', [], new Date(1_000).toISOString())).fast).toBe(true)
  })
})
