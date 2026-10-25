import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startModules } from '../modules/container'
import { socialModule, mailboxPollerModule, INERT_SOCIAL } from './social-module'
import type { SocialDeps, SocialWiring } from './wire-social'

function setup(agent: Record<string, unknown>) {
  const stateDir = mkdtempSync(join(tmpdir(), 'social-module-'))
  const logs: string[] = []
  const ctx = { stateDir, log: (_t: string, l: string) => logs.push(l), configuredAgent: agent as never }
  // 只够走到 wireSocial 的便宜模型那一道判断(之前它只解构入参)
  const deps = { configuredAgent: agent, log: ctx.log, registry: { getCheapEval: () => undefined, getCheapEvalBudgetMs: () => 12_000 } } as unknown as SocialDeps
  const parts = { a2aRegistry: {} as never, readAgentConfig: () => agent as never }
  return { ctx, deps, parts, logs }
}
async function run(s: ReturnType<typeof setup>) {
  const mods = await startModules([socialModule(s.deps), mailboxPollerModule(s.ctx, s.parts)], { log: () => {} })
  return { social: mods.provided<SocialWiring>('social') ?? INERT_SOCIAL, states: Object.fromEntries(mods.status().map(x => [x.name, [x.state, x.error]])), mods }
}

describe('社交一组(第三批 3b 第 3 步):开关就是 social_enabled', () => {
  it('social_enabled 没开 ⇒ social 和笔友信箱都 off;下游拿到 INERT_SOCIAL', async () => {
    const r = await run(setup({ mailbox_relays: ['wss://relay'] }))
    expect(r.social).toBe(INERT_SOCIAL)
    expect(r.states).toEqual({ social: ['off', undefined], 'mailbox-poller': ['off', undefined] })
  })
  it('**开着却没有便宜模型 ⇒ degraded,写明原因**(以前记 off —— off 是「主人关的」,那是假话);笔友信箱跟着,写明是上游没起', async () => {
    const r = await run(setup({ social_enabled: true, social_disclosure_policy: 'p', mailbox_relays: ['wss://relay'] }))
    expect(r.social).toBe(INERT_SOCIAL)
    expect(r.states).toEqual({
      social: ['degraded', 'no cheap-eval model available from any registered provider'],
      'mailbox-poller': ['degraded', 'upstream social not running'],
    })
  })
  it('开着、没配中继 ⇒ 笔友信箱 off(不算坏)', async () => {
    const r = await run(setup({ social_enabled: true, social_disclosure_policy: 'p' }))
    expect(r.states['mailbox-poller']).toEqual(['off', undefined])
  })
})
