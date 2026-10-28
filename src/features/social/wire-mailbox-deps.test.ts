import { describe, it, expect } from 'vitest'
import { wireMailboxDeps } from './wire-mailbox-deps'

const ctx = (configuredAgent: Record<string, unknown>) => ({ stateDir: '/tmp/state', log: () => {}, configuredAgent: configuredAgent as any })
const onLetter = (async () => ({ ok: true })) as any
const registry = {} as any

describe('wireMailboxDeps', () => {
  it('三个门缺任一 ⇒ undefined', () => {
    const reader = () => ({ social_enabled: true }) as any
    expect(wireMailboxDeps(ctx({ social_enabled: false, mailbox_relays: ['r'] }), { a2aRegistry: registry, onMailboxLetter: onLetter, readAgentConfig: reader })).toBeUndefined()
    expect(wireMailboxDeps(ctx({ social_enabled: true, mailbox_relays: [] }), { a2aRegistry: registry, onMailboxLetter: onLetter, readAgentConfig: reader })).toBeUndefined()
    expect(wireMailboxDeps(ctx({ social_enabled: true, mailbox_relays: ['r'] }), { a2aRegistry: registry, onMailboxLetter: undefined, readAgentConfig: reader })).toBeUndefined()
  })
  it('全有 ⇒ 返回 deps;shouldRun 每次重读 agent-config 的 social_enabled', () => {
    let enabled = true
    const d = wireMailboxDeps(ctx({ social_enabled: true, mailbox_relays: ['r1', 'r2'] }), { a2aRegistry: registry, onMailboxLetter: onLetter, readAgentConfig: (() => ({ social_enabled: enabled })) as any })
    expect(d).toBeDefined()
    expect(d!.relays).toEqual(['r1', 'r2'])
    expect(d!.onMailboxLetter).toBe(onLetter)
    expect(d!.shouldRun()).toBe(true)
    enabled = false
    expect(d!.shouldRun()).toBe(false)
  })
})
