import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SubsystemSupervisor } from '../subsystems'
import { makeTeardown } from './teardown'
import { wireSocialGroup, INERT_SOCIAL } from './social-module'
import type { SocialDeps } from './wire-social'

function setup(agent: Record<string, unknown>) {
  const stateDir = mkdtempSync(join(tmpdir(), 'social-module-'))
  const sup = new SubsystemSupervisor(() => {})
  const teardown = makeTeardown()
  const logs: string[] = []
  const ctx = { sup, teardown, stateDir, log: (_t: string, l: string) => logs.push(l), configuredAgent: agent as never }
  // 只够走到 wireSocial 的便宜模型那一道判断(之前它只解构入参)
  const deps = { configuredAgent: agent, log: ctx.log, registry: { getCheapEval: () => undefined, getCheapEvalBudgetMs: () => 12_000 } } as unknown as SocialDeps
  const parts = { a2aRegistry: {} as never, readAgentConfig: () => agent as never }
  return { ctx, deps, parts, sup, teardown, logs }
}
const states = (sup: SubsystemSupervisor) => Object.fromEntries(sup.statuses().map(s => [s.name, [s.state, s.error]]))

describe('社交一组(第三批 3b 第 3 步):开关就是 social_enabled', () => {
  it('social_enabled 没开 ⇒ social 和笔友信箱都 off;下游拿到 INERT_SOCIAL', async () => {
    const s = setup({ mailbox_relays: ['wss://relay'] })
    const w = await wireSocialGroup(s.ctx, s.deps, s.parts)
    expect(w).toBe(INERT_SOCIAL)
    expect(states(s.sup)).toEqual({ social: ['off', undefined], 'mailbox-poller': ['off', undefined] })
  })
  it('**开着却没有便宜模型 ⇒ degraded,写明原因**(以前记 off —— off 是「主人关的」,那是假话);笔友信箱跟着,写明是上游没起', async () => {
    const s = setup({ social_enabled: true, social_disclosure_policy: 'p', mailbox_relays: ['wss://relay'] })
    const w = await wireSocialGroup(s.ctx, s.deps, s.parts)
    expect(w).toBe(INERT_SOCIAL)
    expect(states(s.sup)).toEqual({
      social: ['degraded', 'no cheap-eval model available from any registered provider'],
      'mailbox-poller': ['degraded', 'upstream social not running'],
    })
  })
  it('开着、没配中继 ⇒ 笔友信箱 off(不算坏)', async () => {
    const s = setup({ social_enabled: true, social_disclosure_policy: 'p' })
    await wireSocialGroup(s.ctx, s.deps, s.parts)
    expect(states(s.sup)['mailbox-poller']).toEqual(['off', undefined])
  })
  it('先登记 stopAll 再起:收尾清单里是这一组', async () => {
    const s = setup({})
    await wireSocialGroup(s.ctx, s.deps, s.parts)
    expect(s.teardown.steps().map(t => `${t.tag}:${t.what}`)).toEqual(['MODULES:social group'])
  })
})
