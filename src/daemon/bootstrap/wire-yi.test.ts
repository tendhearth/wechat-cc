import { describe, it, expect } from 'vitest'
import { createServer } from 'node:net'
import { startModules } from '../modules/container'
import { yiModule } from './wire-yi'
import type { YiHub } from '../../app/yi-hub'

const parts = { a2aRegistry: { verifyBearer: () => null } as any, dispatchDelegate: (async () => '') as any }
/** 起一个只有 yi 的容器:回它提供的 hub、它的状态、容器本身(停它 = 关机)。 */
async function wireYi(configuredAgent: any) {
  const mods = await startModules([yiModule(configuredAgent, parts)], { log: () => {} })
  return { hub: mods.provided<YiHub | undefined>('yi'), state: mods.status()[0]!.state, mods }
}

describe('yiModule', () => {
  it('yi_hub_listen / yi_brain 都没配 ⇒ undefined,supervisor 记 off', async () => {
    const r = await wireYi({})
    expect(r.hub).toBeUndefined()
    expect(r.state).toBe('off')
  })
  it('端口被占 ⇒ degraded、不外抛(boot 继续)', async () => {
    const blocker = createServer()
    await new Promise<void>(r => blocker.listen(0, '127.0.0.1', r))
    const port = (blocker.address() as { port: number }).port
    try {
      const r = await wireYi({ yi_hub_listen: { host: '127.0.0.1', port } })
      expect(r.hub).toBeUndefined()
      expect(r.state).toBe('degraded')
    } finally { blocker.close() }
  })
  it('hub 起来了、hand 侧抛(brain url 畸形)⇒ degraded,且 hub 的端口已经释放(不漏监听)', async () => {
    // 先用一个临时 server 找空闲端口,再让出来给 hub 用。
    const probe = createServer()
    await new Promise<void>(r => probe.listen(0, '127.0.0.1', r))
    const port = (probe.address() as { port: number }).port
    await new Promise<void>(r => probe.close(() => r()))
    const r = await wireYi({ yi_hub_listen: { host: '127.0.0.1', port }, yi_brain: { url: 'not a url', handId: 'h', authToken: 't' } })
    expect(r.hub).toBeUndefined()
    expect(r.state).toBe('degraded')
    // 端口必须能再被绑上 —— 否则 hub 的监听器泄漏在一个 degraded 的子系统后面。
    const again = createServer()
    await expect(new Promise<void>((resolve, reject) => { again.once('error', reject); again.listen(port, '127.0.0.1', () => resolve()) })).resolves.toBeUndefined()
    await new Promise<void>(r => again.close(() => r()))
  })
  it('只配 hand(yi_brain)⇒ 没有 hub 但子系统记 ok,不是 off', async () => {
    const r = await wireYi({ yi_brain: { url: 'ws://127.0.0.1:1', handId: 'h', authToken: 't' } })
    expect(r.hub).toBeUndefined()
    expect(r.state).toBe('ok')
    await r.mods.stopAll()
  })
  it('**hub 起来了 ⇒ 容器停了,端口就放了**(复查 10-21:以前关机不停)', async () => {
    const probe = createServer()
    await new Promise<void>(r => probe.listen(0, '127.0.0.1', r))
    const port = (probe.address() as { port: number }).port
    await new Promise<void>(r => probe.close(() => r()))
    const r = await wireYi({ yi_hub_listen: { host: '127.0.0.1', port } })
    expect(r.hub).toBeDefined()
    await r.mods.stopAll()
    const again = createServer()
    await expect(new Promise<void>((resolve, reject) => { again.once('error', reject); again.listen(port, '127.0.0.1', () => resolve()) })).resolves.toBeUndefined()
    await new Promise<void>(r => again.close(() => r()))
  })
  it('只配 hand ⇒ 出站连接也归容器停', async () => {
    const logs: string[] = []
    const mods = await startModules([yiModule({ yi_brain: { url: 'ws://127.0.0.1:1', handId: 'h', authToken: 't' } } as any, parts)], { log: (_t, l) => logs.push(l) })
    await mods.stopAll()
    expect(logs.some(l => l.startsWith('stopped yi/'))).toBe(true)
  })
})
