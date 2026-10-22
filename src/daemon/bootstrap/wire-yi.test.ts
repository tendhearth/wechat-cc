import { describe, it, expect } from 'vitest'
import { createServer } from 'node:net'
import { SubsystemSupervisor } from '../subsystems'
import { makeTeardown } from './teardown'
import { wireYi } from './wire-yi'

const parts = { a2aRegistry: { verifyBearer: () => null } as any, dispatchDelegate: (async () => '') as any }
const state = (sup: SubsystemSupervisor) => sup.statuses().find(s => s.name === 'yi')?.state

describe('wireYi', () => {
  it('yi_hub_listen / yi_brain 都没配 ⇒ undefined,supervisor 记 off', async () => {
    const sup = new SubsystemSupervisor(() => {})
    expect(await wireYi({ sup, log: () => {}, teardown: makeTeardown(), configuredAgent: {} as any }, parts)).toBeUndefined()
    expect(state(sup)).toBe('off')
  })
  it('端口被占 ⇒ degraded、不外抛(boot 继续)', async () => {
    const blocker = createServer()
    await new Promise<void>(r => blocker.listen(0, '127.0.0.1', r))
    const port = (blocker.address() as { port: number }).port
    const sup = new SubsystemSupervisor(() => {})
    try {
      const hub = await wireYi({ sup, log: () => {}, teardown: makeTeardown(), configuredAgent: { yi_hub_listen: { host: '127.0.0.1', port } } as any }, parts)
      expect(hub).toBeUndefined()
      expect(state(sup)).toBe('degraded')
    } finally { blocker.close() }
  })
  it('hub 起来了、hand 侧抛(brain url 畸形)⇒ degraded,且 hub 的端口已经释放(不漏监听)', async () => {
    // 先用一个临时 server 找空闲端口,再让出来给 hub 用。
    const probe = createServer()
    await new Promise<void>(r => probe.listen(0, '127.0.0.1', r))
    const port = (probe.address() as { port: number }).port
    await new Promise<void>(r => probe.close(() => r()))
    const sup = new SubsystemSupervisor(() => {})
    const hub = await wireYi({
      sup, log: () => {}, teardown: makeTeardown(),
      configuredAgent: { yi_hub_listen: { host: '127.0.0.1', port }, yi_brain: { url: 'not a url', handId: 'h', authToken: 't' } } as any,
    }, parts)
    expect(hub).toBeUndefined()
    expect(state(sup)).toBe('degraded')
    // 端口必须能再被绑上 —— 否则 hub 的监听器泄漏在一个 degraded 的子系统后面。
    const again = createServer()
    await expect(new Promise<void>((resolve, reject) => { again.once('error', reject); again.listen(port, '127.0.0.1', () => resolve()) })).resolves.toBeUndefined()
    await new Promise<void>(r => again.close(() => r()))
  })
  it('只配 hand(yi_brain)⇒ 没有 hub 但子系统记 ok,不是 off', async () => {
    const sup = new SubsystemSupervisor(() => {})
    const hub = await wireYi({ sup, log: () => {}, teardown: makeTeardown(), configuredAgent: { yi_brain: { url: 'ws://127.0.0.1:1', handId: 'h', authToken: 't' } } as any }, parts)
    expect(hub).toBeUndefined()
    expect(state(sup)).toBe('ok')
  })
  it('**hub 起来了 ⇒ 在收尾清单里登记停服务端;跑一遍收尾,端口就放了**(复查 10-21:以前关机不停)', async () => {
    const probe = createServer()
    await new Promise<void>(r => probe.listen(0, '127.0.0.1', r))
    const port = (probe.address() as { port: number }).port
    await new Promise<void>(r => probe.close(() => r()))
    const sup = new SubsystemSupervisor(() => {})
    const teardown = makeTeardown()
    const hub = await wireYi({ sup, log: () => {}, teardown, configuredAgent: { yi_hub_listen: { host: '127.0.0.1', port } } as any }, parts)
    expect(hub).toBeDefined()
    // 第三批 3b 第 2 步:yi 是一个模块,收尾清单里登记的是整组的 stopAll(先登记、再起);里面再按逆序停
    expect(teardown.steps().map(t => `${t.tag}:${t.what}`)).toEqual(['MODULES:yi group'])
    for (const t of teardown.steps()) await t.stop()
    const again = createServer()
    await expect(new Promise<void>((resolve, reject) => { again.once('error', reject); again.listen(port, '127.0.0.1', () => resolve()) })).resolves.toBeUndefined()
    await new Promise<void>(r => again.close(() => r()))
  })
  it('只配 hand ⇒ 登记停出站连接', async () => {
    const teardown = makeTeardown()
    await wireYi({ sup: new SubsystemSupervisor(() => {}), log: () => {}, teardown, configuredAgent: { yi_brain: { url: 'ws://127.0.0.1:1', handId: 'h', authToken: 't' } } as any }, parts)
    // 第三批 3b 第 2 步:yi 是一个模块,收尾清单里登记的是整组的 stopAll(先登记、再起);里面再按逆序停
    expect(teardown.steps().map(t => `${t.tag}:${t.what}`)).toEqual(['MODULES:yi group'])
    for (const t of teardown.steps()) await t.stop()
  })
})
