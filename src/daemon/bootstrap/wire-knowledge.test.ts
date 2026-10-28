import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startModules } from '../modules/container'
import { knowledgeModule } from './wire-knowledge'
import { openTestDb } from '../../lib/db'
import type { Bootstrap } from './types'

const base = () => ({ log: () => {}, stateDir: mkdtempSync(join(tmpdir(), 'wk-')), db: openTestDb() })
async function run(ctx: ReturnType<typeof base> & { configuredAgent: never }) {
  const mods = await startModules([knowledgeModule(ctx, [])], { log: () => {} })
  return { k: mods.provided<Bootstrap['knowledge']>('knowledge'), state: mods.status()[0]!.state, mods }
}

describe('knowledgeModule', () => {
  it('knowledge_enabled 未设 ⇒ off,不提供', async () => {
    const r = await run({ ...base(), configuredAgent: {} as never })
    expect(r.k).toBeUndefined()
    expect(r.state).toBe('off')
  })
  it('开着、没有 wxsearch 插件 ⇒ store/graph/facts/person 齐,embedder 缺席;容器停 ⇒ store 只关一次', async () => {
    const r = await run({ ...base(), configuredAgent: { knowledge_enabled: true } as never })
    const k = r.k
    try {
      expect(k?.store).toBeDefined()
      expect(k?.graph).toBeDefined()
      expect(k?.facts).toBeDefined()
      expect(k?.person).toBeDefined()
      expect(k?.embedder).toBeUndefined()
      expect(k?.embedQuery).toBeUndefined()
      expect(r.state).toBe('ok')
      const realClose = k!.store.close.bind(k!.store)
      let closes = 0
      k!.store.close = () => { closes++; realClose() }
      await r.mods.stopAll(); await r.mods.stopAll()
      expect(closes).toBe(1)
    } catch (err) { k?.store.close(); throw err }
  })
  it('store 打不开 ⇒ degraded,不外抛', async () => {
    const ctx = base()
    writeFileSync(join(ctx.stateDir, 'knowledge'), 'not a dir')   // 占住目录名,openKnowledge 建目录失败
    const r = await run({ ...ctx, configuredAgent: { knowledge_enabled: true } as never })
    expect(r.k).toBeUndefined()
    expect(r.state).toBe('degraded')
  })
})
