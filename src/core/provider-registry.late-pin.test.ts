/**
 * 2026-10-04:钉死的 cheapEval provider(agy)开机探测一时失败、晚几秒才注册上。
 * 调用方(coordinator 的 haikuEval、social 闸门 …)开机就把 getCheapEval() 的结果缓存了,
 * 所以「回落偏好序」不能焊死在缓存里。
 */
import { describe, expect, it, vi } from 'vitest'
import { createProviderRegistry } from './provider-registry'

const prov = (fn: (p: string) => Promise<string>) => ({ spawn: async () => { throw new Error('x') }, cheapEval: fn }) as never

describe('钉死的 cheapEval provider 晚注册 ⇒ 已缓存的函数自动回到它', () => {
  it('开机时 agy 没注册 ⇒ 先落到别家;agy 注册上之后同一个(缓存住的)函数改走 agy', async () => {
    const logs: string[] = []
    const r = createProviderRegistry({ cheapEvalProvider: () => 'agy', log: (l) => logs.push(l) })
    const openai = vi.fn(async () => 'from-openai')
    const agy = vi.fn(async () => 'from-agy')
    r.register('openai', prov(openai), { displayName: 'O', canResume: () => false })
    const cached = r.getCheapEval()!
    expect(await cached('q')).toBe('from-openai')
    r.register('agy', prov(agy), { displayName: 'A', canResume: () => false })   // 晚注册(重探通过)
    expect(await cached('q')).toBe('from-agy')
    expect(await cached('q')).toBe('from-agy')
    expect(openai).toHaveBeenCalledTimes(1)
    expect(logs.filter(l => l.includes('已注册 — 后台评估回到它'))).toHaveLength(1)
    // 新取的直接就是 agy 本体(钉中时的原有行为不变)。
    expect(r.getCheapEval()).toBe(agy)
  })

  it('钉的没注册、也没有别家 ⇒ 仍然是 null(语义不变)', () => {
    const r = createProviderRegistry({ cheapEvalProvider: 'agy' })
    expect(r.getCheapEval()).toBeNull()
  })

  it('等待期间主人改了钉(/set cheap)⇒ 缓存住的函数跟着新钉走', async () => {
    let pin: string | undefined = 'agy'
    const r = createProviderRegistry({ cheapEvalProvider: () => pin })
    r.register('openai', prov(async () => 'from-openai'), { displayName: 'O', canResume: () => false })
    r.register('claude', prov(async () => 'from-claude'), { displayName: 'C', canResume: () => false })
    const cached = r.getCheapEval()!
    pin = 'claude'
    expect(await cached('q')).toBe('from-claude')
  })

  it('预算跟着走:agy 晚注册后 getCheapEvalBudgetMs 改报 agy 的', () => {
    const r = createProviderRegistry({ cheapEvalProvider: 'agy' })
    r.register('openai', prov(async () => 'o'), { displayName: 'O', canResume: () => false })
    expect(r.getCheapEvalBudgetMs()).toBe(12_000)
    r.register('agy', { spawn: async () => { throw new Error('x') }, cheapEval: async () => 'a', cheapEvalBudgetMs: 30_000 } as never, { displayName: 'A', canResume: () => false })
    expect(r.getCheapEvalBudgetMs()).toBe(30_000)
  })
})
