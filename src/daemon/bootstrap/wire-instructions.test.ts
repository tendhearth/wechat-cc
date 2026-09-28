import { describe, it, expect } from 'vitest'
import { Ref } from '../../lib/lifecycle'
import { TIER_PROFILES } from '../../core/user-tier'
import { wireInstructions } from './wire-instructions'

const deps = () => ({ ilink: { companion: { status: () => ({ enabled: false }) } } as any })
const parts = (socialWired: Ref<boolean>) => ({
  plugins: { delegateStdioByProvider: {}, knowledgePluginNames: [] as string[] },
  defaultProviderId: 'claude' as const,
  knowledge: undefined,
  socialWired,
})

describe('wireInstructions', () => {
  it('social 未接线就要提示词 ⇒ 抛(fail-fast,不是静默 false)', () => {
    const build = wireInstructions(deps(), parts(new Ref<boolean>('socialWired')))
    expect(() => build('claude', TIER_PROFILES.admin, 'c')).toThrow(/socialWired/)
  })
  it('set 之后按值:admin + social 接好 ⇒ 提示词含社交段;guest ⇒ 不含', () => {
    const ref = new Ref<boolean>('socialWired'); ref.set(true)
    const build = wireInstructions(deps(), parts(ref))
    expect(build('claude', TIER_PROFILES.admin, 'c')).toContain('替主人交朋友')
    expect(build('claude', TIER_PROFILES.guest, 'c')).not.toContain('替主人交朋友')
  })
  it('social 接线了但没起来(set(false))⇒ admin 也不含社交段', () => {
    const ref = new Ref<boolean>('socialWired'); ref.set(false)
    const build = wireInstructions(deps(), parts(ref))
    expect(build('claude', TIER_PROFILES.admin, 'c')).not.toContain('替主人交朋友')
  })
  it('空贴纸库 + 无 memory_write ⇒ 降成 null(不提 search_online_sticker_candidates)', () => {
    const ref = new Ref<boolean>('socialWired'); ref.set(false)
    const build = wireInstructions({ ...deps(), stickerTagsFor: () => [] }, parts(ref))
    expect(build('claude', TIER_PROFILES.guest, 'c')).not.toContain('search_online_sticker_candidates')
    expect(build('claude', TIER_PROFILES.admin, 'c')).toContain('search_online_sticker_candidates')
  })
})
