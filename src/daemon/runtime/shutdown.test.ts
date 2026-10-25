import { describe, expect, it, vi } from 'vitest'
import { makeDaemonShutdown } from './shutdown'

describe('daemon shutdown(重构第二批步 6a)', () => {
  it('stops every registered subsystem even when boot failed half-way (did not reach startup)', async () => {
    const order: string[] = []
    const modules = { stopAll: vi.fn(async () => { order.push('modules') }) }
    const shutdown = makeDaemonShutdown({ log: () => {}, stopHeartbeat: () => order.push('heartbeat'), modules, boot: () => null, closeDb: () => order.push('db'), releaseLock: () => order.push('lock') })
    await shutdown()
    expect(modules.stopAll).toHaveBeenCalledOnce()
    expect(order).toEqual(['heartbeat', 'modules', 'db', 'lock'])
  })
  it('runs once; a failing stop does not skip db close and lock release', async () => {
    const closeDb = vi.fn(), releaseLock = vi.fn()
    const shutdown = makeDaemonShutdown({ log: () => {}, stopHeartbeat: () => {}, modules: { stopAll: async () => { throw new Error('x') } }, boot: () => null, closeDb, releaseLock })
    await shutdown(); await shutdown()
    expect(closeDb).toHaveBeenCalledOnce(); expect(releaseLock).toHaveBeenCalledOnce()
  })
  it('agy 注册过才清它的全局 MCP 配置,在容器停完之后、db 之前;启动半路失败(boot 还是 null)⇒ 不清', async () => {
    const order: string[] = []
    const shutdown = makeDaemonShutdown({ log: () => {}, stopHeartbeat: () => {}, modules: { stopAll: async () => { order.push('modules') } }, boot: () => ({ registry: { has: (id: string) => id === 'agy' } }), removeAgyGlobalMcp: () => order.push('agy'), closeDb: () => order.push('db'), releaseLock: () => {} })
    await shutdown()
    expect(order).toEqual(['modules', 'agy', 'db'])
    const half: string[] = []
    await makeDaemonShutdown({ log: () => {}, stopHeartbeat: () => {}, modules: { stopAll: async () => {} }, boot: () => null, removeAgyGlobalMcp: () => half.push('agy'), closeDb: () => {}, releaseLock: () => {} })()
    expect(half).toEqual([])
  })
})
