import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SubsystemSupervisor } from '../subsystems'
import { makeTeardown } from './teardown'
import { wireKnowledge } from './wire-knowledge'

const base = () => ({ sup: new SubsystemSupervisor(() => {}), log: () => {}, teardown: makeTeardown(), stateDir: mkdtempSync(join(tmpdir(), 'wk-')) })
const state = (sup: SubsystemSupervisor) => sup.statuses().find(s => s.name === 'knowledge')?.state

describe('wireKnowledge', () => {
  it('knowledge_enabled 未设 ⇒ undefined,supervisor 记 off', async () => {
    const ctx = base()
    const k = await wireKnowledge({ ...ctx, configuredAgent: {} as any }, [])
    expect(k).toBeUndefined()
    expect(state(ctx.sup)).toBe('off')
  })
  it('开着、没有 wxsearch 插件 ⇒ store/graph/facts/person 齐,embedder 缺席', async () => {
    const ctx = base()
    const k = await wireKnowledge({ ...ctx, configuredAgent: { knowledge_enabled: true } as any }, [])
    try {
      expect(k?.store).toBeDefined()
      expect(k?.graph).toBeDefined()
      expect(k?.facts).toBeDefined()
      expect(k?.person).toBeDefined()
      expect(k?.embedder).toBeUndefined()
      expect(k?.embedQuery).toBeUndefined()
      expect(state(ctx.sup)).toBe('ok')
      // 第三批 3b 第 2 步:知识库是一个模块,收尾清单里登记的是这一组的 stopAll(先登记、再起)。
      // 跑一遍收尾 ⇒ 适配定时器停掉、store 关掉,而且只关一次(以前 store 由 runtime/shutdown 经 boot() 关)
      expect(ctx.teardown.steps().map(t => `${t.tag}:${t.what}`)).toEqual(['MODULES:knowledge group'])
      const realClose = k!.store.close.bind(k!.store)
      let closes = 0
      k!.store.close = () => { closes++; realClose() }
      for (const t of ctx.teardown.steps()) await t.stop()
      expect(closes).toBe(1)
    } catch (err) { k?.store.close(); throw err }
  })
  it('store 打不开 ⇒ degraded,不外抛', async () => {
    const ctx = base()
    writeFileSync(join(ctx.stateDir, 'knowledge'), 'not a dir')   // 占住目录名,openKnowledge 建目录失败
    const k = await wireKnowledge({ ...ctx, configuredAgent: { knowledge_enabled: true } as any }, [])
    expect(k).toBeUndefined()
    expect(state(ctx.sup)).toBe('degraded')
  })
})
