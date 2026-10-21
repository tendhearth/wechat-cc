import { describe, it, expect, vi } from 'vitest'
import { makeMwTrace } from './mw-trace'
import type { InboundCtx } from './types'

const mkCtx = (): InboundCtx => ({
  msg: { chatId: 'c1' } as InboundCtx['msg'],
  receivedAtMs: Date.now(),
  requestId: 'req1',
})

describe('mwTrace', () => {
  it('logs INBOUND with consumed=dispatched when consumedBy unset', async () => {
    const lines: Array<[string, string]> = []
    const mw = makeMwTrace({ log: (t, l) => lines.push([t, l]) })
    await mw(mkCtx(), async () => {})
    expect(lines.some(([t, l]) => t === 'INBOUND' && l.includes('consumed=dispatched'))).toBe(true)
  })

  it('a step that throws is logged consumed=error, not dispatched; the step that had claimed it is kept (#483 评审)', async () => {
    const lines: Array<[string, string]> = []
    const mw = makeMwTrace({ log: (t, l) => lines.push([t, l]) })
    await mw(mkCtx(), async () => { throw new Error('workbench_reply_failed') })
    const ctx = mkCtx()
    await mw(ctx, async () => { ctx.consumedBy = 'workbench'; throw new Error('boom') })
    const inbound = lines.filter(([t]) => t === 'INBOUND').map(([, l]) => l)
    expect(inbound[0]).toContain('consumed=error ')
    expect(inbound[1]).toContain('consumed=error:workbench ')
    expect(inbound.some(l => l.includes('dispatched'))).toBe(false)
  })

  it('logs consumed=<consumedBy> when set', async () => {
    const lines: Array<[string, string]> = []
    const mw = makeMwTrace({ log: (t, l) => lines.push([t, l]) })
    const ctx = mkCtx()
    await mw(ctx, async () => { ctx.consumedBy = 'admin' })
    expect(lines.some(([t, l]) => t === 'INBOUND' && l.includes('consumed=admin'))).toBe(true)
  })

  it('catches inner error, logs INBOUND_ERROR, does not rethrow', async () => {
    const lines: Array<[string, string]> = []
    const mw = makeMwTrace({ log: (t, l) => lines.push([t, l]) })
    await expect(mw(mkCtx(), async () => { throw new Error('inner-boom') })).resolves.toBeUndefined()
    expect(lines.some(([t, l]) => t === 'INBOUND_ERROR' && l.includes('inner-boom'))).toBe(true)
  })
})
