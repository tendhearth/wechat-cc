import { describe, expect, it, vi } from 'vitest'
import { makeDaemonShutdown } from './shutdown'

describe('daemon shutdown(重构第二批步 6a)', () => {
  it('stops every registered subsystem even when boot failed half-way (did not reach startup)', async () => {
    const order: string[] = []
    const lc = { stopAll: vi.fn(async () => { order.push('lc') }) }
    const shutdown = makeDaemonShutdown({ log: () => {}, stopHeartbeat: () => order.push('heartbeat'), lc, boot: () => null, closeDb: () => order.push('db'), releaseLock: () => order.push('lock') })
    await shutdown()
    expect(lc.stopAll).toHaveBeenCalledOnce()
    expect(order).toEqual(['heartbeat', 'lc', 'db', 'lock'])
  })
  it('runs once; a failing stop does not skip db close and lock release', async () => {
    const closeDb = vi.fn(), releaseLock = vi.fn()
    const shutdown = makeDaemonShutdown({ log: () => {}, stopHeartbeat: () => {}, lc: { stopAll: async () => { throw new Error('x') } }, boot: () => null, closeDb, releaseLock })
    await shutdown(); await shutdown()
    expect(closeDb).toHaveBeenCalledOnce(); expect(releaseLock).toHaveBeenCalledOnce()
  })
})
