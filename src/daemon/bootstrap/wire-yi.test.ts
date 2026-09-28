import { describe, it, expect } from 'vitest'
import { createServer } from 'node:net'
import { SubsystemSupervisor } from '../subsystems'
import { wireYi } from './wire-yi'

const parts = { a2aRegistry: { verifyBearer: () => null } as any, dispatchDelegate: (async () => '') as any }
const state = (sup: SubsystemSupervisor) => sup.statuses().find(s => s.name === 'yi')?.state

describe('wireYi', () => {
  it('yi_hub_listen / yi_brain 都没配 ⇒ undefined,supervisor 记 off', async () => {
    const sup = new SubsystemSupervisor(() => {})
    expect(await wireYi({ sup, log: () => {}, configuredAgent: {} as any }, parts)).toBeUndefined()
    expect(state(sup)).toBe('off')
  })
  it('端口被占 ⇒ degraded、不外抛(boot 继续)', async () => {
    const blocker = createServer()
    await new Promise<void>(r => blocker.listen(0, '127.0.0.1', r))
    const port = (blocker.address() as { port: number }).port
    const sup = new SubsystemSupervisor(() => {})
    try {
      const hub = await wireYi({ sup, log: () => {}, configuredAgent: { yi_hub_listen: { host: '127.0.0.1', port } } as any }, parts)
      expect(hub).toBeUndefined()
      expect(state(sup)).toBe('degraded')
    } finally { blocker.close() }
  })
})
