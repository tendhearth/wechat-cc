import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SubsystemSupervisor } from '../subsystems'
import { wireKnowledge } from './wire-knowledge'

const base = () => ({ sup: new SubsystemSupervisor(() => {}), log: () => {}, stateDir: mkdtempSync(join(tmpdir(), 'wk-')) })
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
    } finally { k?.store.close() }
  })
  it('store 打不开 ⇒ degraded,不外抛', async () => {
    const ctx = base()
    writeFileSync(join(ctx.stateDir, 'knowledge'), 'not a dir')   // 占住目录名,openKnowledge 建目录失败
    const k = await wireKnowledge({ ...ctx, configuredAgent: { knowledge_enabled: true } as any }, [])
    expect(k).toBeUndefined()
    expect(state(ctx.sup)).toBe('degraded')
  })
})
