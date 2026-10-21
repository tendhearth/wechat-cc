import { describe, it, expect, vi } from 'vitest'
import { makeMwCommand } from './mw-command'
import { makeCommandRegistry } from '../commands/registry'
import type { InboundCtx } from './types'

const ctx = (text: string): InboundCtx => ({ msg: { chatId: 'c', userId: 'u', text, msgType: 'text', createTimeMs: 0 }, receivedAtMs: 0, requestId: 'r' } as unknown as InboundCtx)

describe('mw-command', () => {
  it('a command handles it ⇒ consumedBy=command and the id is logged; nothing claims ⇒ next', async () => {
    const next = vi.fn(async () => {}), log = vi.fn()
    const registry = makeCommandRegistry([{ id: 'cli', probe: (m) => m.text.startsWith('看 '), handle: async () => true }])
    const mw = makeMwCommand({ registry, log })
    const a = ctx('看 a1b2c3'); await mw(a, next)
    expect(a.consumedBy).toBe('command'); expect(next).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('COMMAND', 'cli consumed from chat=c')
    const b = ctx('hello'); await mw(b, next)
    expect(b.consumedBy).toBeUndefined(); expect(next).toHaveBeenCalledTimes(1)
  })
})
