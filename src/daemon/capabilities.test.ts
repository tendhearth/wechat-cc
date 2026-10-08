import { describe, expect, it } from 'vitest'
import { buildCapabilities, worstCapability, type CapabilityInputs } from './capabilities'

const base = (over: Partial<CapabilityInputs> = {}): CapabilityInputs => ({
  wechat: { outbound: 'ok', expired: 0 },
  brain: { provider: 'claude', name: 'Claude', registered: true, retrying: false },
  guard: null, fullDiskAccess: null, knowledge: null, memory: null,
  phone: { relay: true, devices: 1 },
  subsystems: [],
  ...over,
})

describe('buildCapabilities (2026-10-06)', () => {
  it('all good: only applicable rows, all ok, no worst', () => {
    const rows = buildCapabilities(base())
    expect(rows.map(r => [r.id, r.state])).toEqual([['wechat', 'ok'], ['brain', 'ok'], ['phone', 'ok']])
    expect(worstCapability(rows)).toBeNull()
  })
  it('owner-fixable problems are needs_you with one action; raw errors only in detail', () => {
    const rows = buildCapabilities(base({
      wechat: { outbound: 'degraded', expired: 1, lastError: 'errcode=-14' },
      fullDiskAccess: { granted: false, settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles' },
      guard: { safe: false, paused: false, detail: 'bx down' },
    }))
    const by = Object.fromEntries(rows.map(r => [r.id, r]))
    expect(by.wechat).toMatchObject({ state: 'needs_you', action: { label: '重新扫码绑定' } })
    expect(by.disk).toMatchObject({ state: 'needs_you', action: { url: expect.stringContaining('Privacy_AllFiles') } })
    expect(by.guard).toMatchObject({ state: 'needs_you', detail: 'bx down' })
    expect(rows.every(r => !r.reason.includes('errcode') && !r.reason.includes('bx down'))).toBe(true)
    expect(worstCapability(rows)?.state).toBe('needs_you')
  })
  it('running on a fallback is told apart from ok', () => {
    const rows = buildCapabilities(base({
      knowledge: { built: true, embed: 'js_fell_back' },
      brain: { provider: 'codex', name: 'Codex', registered: false, retrying: true, lastError: 'spawn ENOENT' },
      memory: { failures: 3, firstRunDone: true },
      subsystems: [{ name: 'reminders', state: 'degraded', error: 'boom' }, { name: 'social', state: 'ok' }],
      phone: { relay: true, devices: 0 },
    }))
    const by = Object.fromEntries(rows.map(r => [r.id, r]))
    expect(by.knowledge).toMatchObject({ state: 'fallback', reason: expect.stringContaining('Python') })
    expect(by.brain).toMatchObject({ state: 'fallback', detail: 'spawn ENOENT' })
    expect(by.memory).toMatchObject({ state: 'fallback' })
    expect(by['subsystem:reminders']).toMatchObject({ name: '提醒', state: 'fallback', detail: 'boom' })
    expect(by['subsystem:social']).toBeUndefined()
    expect(by.phone).toMatchObject({ state: 'off' })
    expect(worstCapability(rows)?.state).toBe('fallback')
  })
  it('an unregistered brain with no retry needs the owner', () => {
    expect(buildCapabilities(base({ brain: { provider: 'cursor', name: 'Cursor', registered: false, retrying: false } })).find(r => r.id === 'brain')).toMatchObject({ state: 'needs_you', action: { where: 'settings' } })
  })
})
