import { describe, expect, it } from 'vitest'
import { tierEnforcement, KNOWN_TIER_GAPS, TIER_ENFORCEMENT_TABLE, noAskNotice } from './tier-enforcement'
import { KNOWN_PROVIDER_IDS } from './capability-matrix'

// 架构审查 #462 第一批(主人 10-20 拍板):同一条安全判断散在三层(翻译函数 / 逐工具 gate / 派发时拒),
// 没有一处能证明它们一致。这张表把每家每档「靠哪一层守住」写出来;新接一家执行者不归类就红。
describe('provider × tier enforcement', () => {
  it('every registered provider is classified for guest, trusted and admin', () => {
    for (const p of KNOWN_PROVIDER_IDS) for (const t of ['guest', 'trusted', 'admin'] as const) expect(tierEnforcement(p, t), `${p}/${t}`).toBeTruthy()
  })
  it('guests are never a gap: either every tool call is gated, or the provider is refused at dispatch', () => {
    for (const p of KNOWN_PROVIDER_IDS) expect(['per-tool', 'dispatch-deny'], p).toContain(tierEnforcement(p, 'guest').how)
  })
  // 3c Policy 第 2 步:admin 也核。以前只核 trusted,admin 在 strict 下「要问」的几类(删东西、删记忆、动 daemon)
  // 在 codex / agy 上悄悄不问,没人登记过。
  it.each(['trusted', 'admin'] as const)('a %s gap must be written down with its reason; a listed gap that is no longer a gap is stale and fails', (tier) => {
    for (const p of KNOWN_PROVIDER_IDS) {
      const e = tierEnforcement(p, tier)
      if (e.how === 'gap') expect(KNOWN_TIER_GAPS[p]?.[tier], `${p}: 新的 ${tier} 缺口要写进 KNOWN_TIER_GAPS 并说明`).toBeTruthy()
      else expect(KNOWN_TIER_GAPS[p]?.[tier], `${p}: 已经不是缺口了,删掉这条`).toBeUndefined()
    }
    for (const p of Object.keys(KNOWN_TIER_GAPS)) expect(KNOWN_PROVIDER_IDS, p).toContain(p)
  })
  it('the table is what the code does today', () => {
    expect(TIER_ENFORCEMENT_TABLE()).toEqual({
      claude: { guest: 'per-tool', trusted: 'per-tool', admin: 'per-tool' },
      openai: { guest: 'per-tool', trusted: 'per-tool', admin: 'per-tool' },
      gemini: { guest: 'per-tool', trusted: 'per-tool', admin: 'per-tool' },
      codex: { guest: 'dispatch-deny', trusted: 'gap', admin: 'gap' },
      cursor: { guest: 'dispatch-deny', trusted: 'gap', admin: 'gap' },
      agy: { guest: 'dispatch-deny', trusted: 'gap', admin: 'gap' },
    })
  })
  // 准绳(稿 §6):问不了、于是放行的那几家,主人切过去时照实说一句;比档位严的(cursor 直接拒)不用提醒。
  it('the "it will not ask you" notice goes exactly to the executors that let ask-kinds through', () => {
    expect(KNOWN_PROVIDER_IDS.filter(p => noAskNotice(p) !== null).sort()).toEqual(['agy', 'codex'])
    expect(noAskNotice('codex')).toBe('提醒:它不会逐条问你,删东西也不会。')
    expect(noAskNotice('claude')).toBeNull()
    expect(noAskNotice('cursor')).toBeNull()
  })
})
