import { describe, expect, it } from 'vitest'
import { tierEnforcement, KNOWN_TIER_GAPS, TIER_ENFORCEMENT_TABLE } from './tier-enforcement'
import { KNOWN_PROVIDER_IDS } from './capability-matrix'

// 架构审查 #462 第一批(主人 10-20 拍板):同一条安全判断散在三层(翻译函数 / 逐工具 gate / 派发时拒),
// 没有一处能证明它们一致。这张表把每家每档「靠哪一层守住」写出来;新接一家执行者不归类就红。
describe('provider × tier enforcement', () => {
  it('every registered provider is classified for guest and trusted', () => {
    for (const p of KNOWN_PROVIDER_IDS) for (const t of ['guest', 'trusted'] as const) expect(tierEnforcement(p, t), `${p}/${t}`).toBeTruthy()
  })
  it('guests are never a gap: either every tool call is gated, or the provider is refused at dispatch', () => {
    for (const p of KNOWN_PROVIDER_IDS) expect(['per-tool', 'dispatch-deny'], p).toContain(tierEnforcement(p, 'guest').how)
  })
  it('a trusted gap must be written down with its reason; a listed gap that is no longer a gap is stale and fails', () => {
    for (const p of KNOWN_PROVIDER_IDS) {
      const e = tierEnforcement(p, 'trusted')
      if (e.how === 'gap') expect(KNOWN_TIER_GAPS[p]?.trusted, `${p}: 新的 trusted 缺口要写进 KNOWN_TIER_GAPS 并说明`).toBeTruthy()
      else expect(KNOWN_TIER_GAPS[p]?.trusted, `${p}: 已经不是缺口了,删掉这条`).toBeUndefined()
    }
    for (const p of Object.keys(KNOWN_TIER_GAPS)) expect(KNOWN_PROVIDER_IDS, p).toContain(p)
  })
  it('the table is what the code does today', () => {
    expect(TIER_ENFORCEMENT_TABLE()).toEqual({
      claude: { guest: 'per-tool', trusted: 'per-tool' },
      openai: { guest: 'per-tool', trusted: 'per-tool' },
      gemini: { guest: 'per-tool', trusted: 'per-tool' },
      codex: { guest: 'dispatch-deny', trusted: 'gap' },
      cursor: { guest: 'dispatch-deny', trusted: 'gap' },
      agy: { guest: 'dispatch-deny', trusted: 'gap' },
    })
  })
})
