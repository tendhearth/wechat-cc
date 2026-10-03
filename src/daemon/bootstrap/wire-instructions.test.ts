import { describe, it, expect, vi, afterEach } from 'vitest'
import * as capabilityMatrix from '../../core/capability-matrix'
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

describe('wireInstructions × 回复交付(spec 2026-10-03 §4.11)', () => {
  afterEach(() => vi.restoreAllMocks())
  const build = () => { const ref = new Ref<boolean>('socialWired'); ref.set(false); return wireInstructions(deps(), parts(ref)) }

  it('provider 走 daemon ⇒ final_text 版(不教 reply,讲「最后的话」);admin 才提 message', () => {
    vi.spyOn(capabilityMatrix, 'replyDeliveryFor').mockImplementation(p => p === 'openai' ? 'daemon' : 'legacy')
    const admin = build()('openai', TIER_PROFILES.admin, 'c')
    expect(admin).toContain('最后写下的那段话就是发给对方的回复')
    expect(admin).not.toContain('`reply(chat_id, text)`')
    expect(admin).toContain('`message(to, text)`')
    expect(build()('openai', TIER_PROFILES.trusted, 'c')).not.toContain('`message(to, text)`')
  })

  it('legacy / shadow ⇒ 照旧教 reply', () => {
    vi.spyOn(capabilityMatrix, 'replyDeliveryFor').mockReturnValue('shadow')
    expect(build()('openai', TIER_PROFILES.admin, 'c')).toContain('`reply(chat_id, text)`')
  })
})
