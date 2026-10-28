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
  it('owner WeChat push window closed (errcode=-2) asks the owner to reply in WeChat; expired login still wins', () => {
    const closed = buildCapabilities(base({ wechat: { outbound: 'ok', expired: 0, ownerWindowClosedSince: '2026-10-14T02:05:21Z' } })).find(r => r.id === 'wechat')
    expect(closed).toMatchObject({ state: 'needs_you', code: 'wechat.window_closed', action: { where: 'wechat' } })
    expect(buildCapabilities(base({ wechat: { outbound: 'ok', expired: 1, ownerWindowClosedSince: '2026-10-14T02:05:21Z' } })).find(r => r.id === 'wechat')?.code).toBe('wechat.expired')
  })
  it('background checks show up only after 3 failures in a row, with the raw error in detail', () => {
    expect(buildCapabilities(base({ background: { failures: 2, lastError: 'x' } })).find(r => r.id === 'background')).toBeUndefined()
    const row = buildCapabilities(base({ background: { failures: 5, lastError: 'invalid model selection' } })).find(r => r.id === 'background')
    expect(row).toMatchObject({ state: 'fallback', code: 'background.failing', params: { n: 5 }, detail: 'invalid model selection' })
    expect(row!.reason).not.toContain('invalid model')
  })
  // 2026-10-23:注册上了、--version 也过了,真回合里却被拒着(agy 地区不可用)⇒ 照实说,不说「在用」
  it('a registered brain that real turns say is region-refused needs the owner, with an honest reason', () => {
    const row = buildCapabilities(base({ brain: { provider: 'agy', name: 'Antigravity', registered: true, retrying: false, refused: { code: 'region_unavailable', since: '2026-10-23T05:00:00.000Z' } } })).find(r => r.id === 'brain')
    expect(row).toMatchObject({ state: 'needs_you', code: 'brain.region_unavailable', params: { name: 'Antigravity' }, action: { where: 'settings' } })
    expect(row!.reason).toMatch(/地区/)
    expect(row!.reason).not.toMatch(/登录(失效|过期)/)
    expect(buildCapabilities(base({ brain: { provider: 'agy', name: 'Antigravity', registered: true, retrying: false, refused: null } })).find(r => r.id === 'brain')).toMatchObject({ state: 'ok' })
  })
  it('an unregistered brain with no retry needs the owner', () => {
    expect(buildCapabilities(base({ brain: { provider: 'cursor', name: 'Cursor', registered: false, retrying: false } })).find(r => r.id === 'brain')).toMatchObject({ state: 'needs_you', action: { where: 'settings' } })
  })
})

describe('终端里的 Claude Code / Codex(2026-10-14)', () => {
  const term = (sources: NonNullable<CapabilityInputs['terminal']>['sources'], sessions7d = 0) => buildCapabilities(base({ terminal: { sources, sessions7d } })).find(r => r.id === 'terminal')
  it('这台机上一家都没有 ⇒ 不出现', () => {
    expect(term([])).toBeUndefined()
    expect(buildCapabilities(base({ terminal: null })).find(r => r.id === 'terminal')).toBeUndefined()
    expect(buildCapabilities(base()).find(r => r.id === 'terminal')).toBeUndefined()
  })
  it('装了没接 ⇒ off + 「接上」(没开不是故障,不进 worst)', () => {
    const r = term([{ source: 'claude', health: 'missing' }, { source: 'codex', health: 'missing' }])!
    expect(r).toMatchObject({ name: '终端里的 Claude Code / Codex', state: 'off', code: 'terminal.not_connected', params: { names: 'Claude Code / Codex' }, action: { label: '接上', where: 'desktop', run: 'cli_hooks_install' } })
    expect(worstCapability([r])).toBeNull()
  })
  it('接线指向不在的位置 ⇒ needs_you + 「修复」,点名坏的那家', () => {
    const r = term([{ source: 'claude', health: 'ok' }, { source: 'codex', health: 'stale' }], 3)!
    expect(r).toMatchObject({ state: 'needs_you', code: 'terminal.stale', params: { names: 'Codex' }, action: { label: '修复', run: 'cli_hooks_install' } })
    expect(worstCapability([r])?.id).toBe('terminal')
  })
  it('接了一部分 ⇒ ok,带「接上」把剩下的接上', () => {
    expect(term([{ source: 'claude', health: 'ok' }, { source: 'codex', health: 'missing' }], 4)).toMatchObject({ state: 'ok', code: 'terminal.partial', params: { n: 4, names: 'Codex' }, reason: '已接上，最近 7 天 4 个终端会话；Codex 还没接上。', action: { label: '接上' } })
  })
  it('都接上 ⇒ ok + 最近 7 天几个会话,没有动作;只装了一家就只说那一家', () => {
    expect(term([{ source: 'claude', health: 'ok' }], 12)).toEqual({ id: 'terminal', name: '终端里的 Claude Code', state: 'ok', code: 'terminal.ok', params: { n: 12 }, reason: '已接上，最近 7 天 12 个终端会话。' })
  })
  it('Cursor 一起列:名字是「Cursor」,没接上的那家点名', () => {
    expect(term([{ source: 'claude', health: 'ok' }, { source: 'codex', health: 'ok' }, { source: 'cursor', health: 'missing' }], 3))
      .toMatchObject({ name: '终端里的 Claude Code / Codex / Cursor', state: 'ok', code: 'terminal.partial', params: { n: 3, names: 'Cursor' }, action: { label: '接上', run: 'cli_hooks_install' } })
    expect(term([{ source: 'cursor', health: 'stale' }])).toMatchObject({ name: '终端里的 Cursor', state: 'needs_you', code: 'terminal.stale', params: { names: 'Cursor' } })
  })
})

describe('手机:老中继退休(F4)', () => {
  const base = { wechat: { outbound: 'ok' as const, expired: 0 }, brain: { provider: 'claude', name: 'Claude', registered: true, retrying: false }, guard: null, fullDiskAccess: null, knowledge: null, memory: null, subsystems: [] }
  it('配置里只有老中继(没有 relay_v2_url)⇒ needs_you,一句「换新中继、重新配对」,指向连接手机', () => {
    const phone = buildCapabilities({ ...base, phone: { relay: false, devices: 2, legacyRelay: true } }).find(c => c.id === 'phone')!
    expect(phone).toMatchObject({ state: 'needs_you', code: 'phone.relay_retired', reason: '手机连接要换新中继，在「连接手机」里重新配对。', action: { where: 'desktop' } })
  })
  it('没有老配置 ⇒ 照旧「没开手机连接」;设了 relay_v2_url ⇒ 老配置不算', () => {
    expect(buildCapabilities({ ...base, phone: { relay: false, devices: 0 } }).find(c => c.id === 'phone')).toMatchObject({ state: 'off', code: 'phone.relay_off' })
    expect(buildCapabilities({ ...base, phone: { relay: true, devices: 1, legacyRelay: false } }).find(c => c.id === 'phone')).toMatchObject({ state: 'ok' })
  })
})
