import { describe, expect, it, vi } from 'vitest'
import { makeTeardown } from '../bootstrap/teardown'
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
  it('bootstrap 的收尾清单在子系统之后、知识库关之前倒序跑;启动半路失败(boot 还是 null)也照跑;一项抛错不挡后面', async () => {
    const order: string[] = []
    const teardown = makeTeardown()
    teardown.add('IDLE_SWEEP', 'timer', () => order.push('idle'))
    teardown.add('KNOWLEDGE', 'adapter timer', () => { order.push('adapter'); throw new Error('boom') })
    teardown.add('YI', 'server', async () => { order.push('yi') })
    const logs: string[] = []
    const knowledge = { store: { close: () => order.push('store') } }
    const shutdown = makeDaemonShutdown({ log: (t, l) => logs.push(`${t} ${l}`), stopHeartbeat: () => {}, lc: { stopAll: async () => { order.push('lc') } }, teardown, boot: () => ({ knowledge }), closeDb: () => order.push('db'), releaseLock: () => {} })
    await shutdown()
    expect(order).toEqual(['lc', 'yi', 'adapter', 'idle', 'store', 'db'])
    expect(logs.some(l => l.includes('KNOWLEDGE adapter timer') && l.includes('boom'))).toBe(true)
    const half: string[] = []
    const t2 = makeTeardown(); t2.add('YI', 'server', () => half.push('yi'))
    await makeDaemonShutdown({ log: () => {}, stopHeartbeat: () => {}, lc: { stopAll: async () => {} }, teardown: t2, boot: () => null, closeDb: () => {}, releaseLock: () => {} })()
    expect(half).toEqual(['yi'])
  })
})
