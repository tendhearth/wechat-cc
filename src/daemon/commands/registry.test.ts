import { describe, expect, it, vi } from 'vitest'
import { makeCommandRegistry, fromReplyHandler } from './registry'

const msg = (text: string, chatId = 'owner') => ({ chatId, userId: chatId, text, msgType: 'text', createTimeMs: 0 }) as never

describe('CommandRegistry(重构第二批步 2)', () => {
  it('probe is read-only; handle runs the first command whose probe claims AND handles it', async () => {
    const a = { id: 'a', probe: vi.fn((m: { text: string }) => m.text === 'x'), handle: vi.fn(async () => false) }
    const b = { id: 'b', probe: vi.fn((m: { text: string }) => m.text.startsWith('x')), handle: vi.fn(async () => true) }
    const c = { id: 'c', probe: vi.fn(() => true), handle: vi.fn(async () => true) }
    const r = makeCommandRegistry([a, b, c])
    expect(r.probe(msg('x'))).toBe(true)
    expect(a.handle).not.toHaveBeenCalled()
    expect(await r.handle(msg('x'))).toEqual({ id: 'b', group: 'command' })   // a 认领但没处理 ⇒ 交给下一个认领的
    expect(c.handle).not.toHaveBeenCalled()
  })
  it('nothing claims ⇒ probe false, handle null; ids are unique (duplicate throws at build)', async () => {
    const r = makeCommandRegistry([{ id: 'a', probe: () => false, handle: async () => true }])
    expect(r.probe(msg('hi'))).toBe(false)
    expect(await r.handle(msg('hi'))).toBeNull()
    expect(() => makeCommandRegistry([{ id: 'a', probe: () => false, handle: async () => true }, { id: 'a', probe: () => false, handle: async () => true }])).toThrow('duplicate command id: a')
  })
  it('a probe that throws counts as not claiming (one broken command cannot take the inbox down)', () => {
    const r = makeCommandRegistry([{ id: 'boom', probe: () => { throw new Error('x') }, handle: async () => true }, { id: 'ok', probe: () => true, handle: async () => true }])
    expect(r.probe(msg('hi'))).toBe(true)
    expect(r.ids).toEqual(['boom', 'ok'])
  })
  it('fromReplyHandler adapts the old (text, chatId) handlers', async () => {
    const h = { probe: (t: string, c: string) => t === '定时' && c === 'owner', handle: async () => true }
    const cmd = fromReplyHandler('jobs', h)
    expect(cmd.probe(msg('定时'))).toBe(true)
    expect(cmd.probe(msg('定时', 'guest'))).toBe(false)
    expect(await cmd.handle(msg('定时'))).toBe(true)
  })
})

describe('CommandRegistry · 3b:group 与 /词 的归属', () => {
  it('handle reports the group (old consumedBy label); default group is command', async () => {
    const r = makeCommandRegistry([{ id: 'admin', group: 'admin', probe: (m) => m.text === '/health', handle: async () => true }, { id: 'jobs', probe: (m) => m.text === '定时', handle: async () => true }])
    expect(await r.handle(msg('/health'))).toEqual({ id: 'admin', group: 'admin' })
    expect(await r.handle(msg('定时'))).toEqual({ id: 'jobs', group: 'command' })
  })
  it('a /word a later command owns is placed before the slash catch-all; the order is visible in ids (order = priority, no look-ahead)', async () => {
    const mode = { id: 'mode', group: 'mode', slashCatchAll: true as const, probe: (m: { text: string }) => m.text.startsWith('/'), handle: vi.fn(async () => true) }
    const cli = { id: 'cli', ownsSlash: (m: { text: string }) => m.text === '/cli', probe: (m: { text: string }) => m.text === '/cli' || m.text === '终端', handle: vi.fn(async () => true) }
    const onboarding = { id: 'onboarding', group: 'onboarding', probe: () => true, handle: vi.fn(async () => true) }
    const r = makeCommandRegistry([mode, onboarding, cli])
    expect(r.ids).toEqual(['cli:slash', 'mode', 'onboarding', 'cli'])
    expect(await r.handle(msg('/cli'))).toEqual({ id: 'cli:slash', group: 'command' })
    expect(await r.handle(msg('/cc'))).toEqual({ id: 'mode', group: 'mode' })
    expect(await r.handle(msg('终端'))).toEqual({ id: 'onboarding', group: 'onboarding' })   // 非斜杠的写法留在原位
  })
})
