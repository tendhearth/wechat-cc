import { describe, it, expect } from 'vitest'
import { TIER_PROFILES } from '../../core/user-tier'
import { wireInstructions } from './wire-instructions'

const deps = () => ({ ilink: { companion: { status: () => ({ enabled: false }) } } as any })
const parts = (socialWired: () => boolean) => ({
  plugins: { delegateStdioByProvider: {}, knowledgePluginNames: [] as string[] },
  defaultProviderId: 'claude' as const,
  knowledge: undefined,
  socialWired,
})

describe('wireInstructions', () => {
  it('每次起会话时现问:admin + social 接好 ⇒ 提示词含社交段;guest ⇒ 不含', () => {
    const build = wireInstructions(deps(), parts(() => true))
    expect(build('claude', TIER_PROFILES.admin, 'c')).toContain('替主人交朋友')
    expect(build('claude', TIER_PROFILES.guest, 'c')).not.toContain('替主人交朋友')
  })
  it('social 没起来 / 关着 ⇒ admin 也不含社交段;起来以后下一个会话就含', () => {
    let up = false
    const build = wireInstructions(deps(), parts(() => up))
    expect(build('claude', TIER_PROFILES.admin, 'c')).not.toContain('替主人交朋友')
    up = true
    expect(build('claude', TIER_PROFILES.admin, 'c')).toContain('替主人交朋友')
    up = false
    expect(build('claude', TIER_PROFILES.admin, 'c')).not.toContain('替主人交朋友')
  })
  it('空贴纸库 + 无 memory_write ⇒ 降成 null(不提 search_online_sticker_candidates)', () => {
    const build = wireInstructions({ ...deps(), stickerTagsFor: () => [] }, parts(() => false))
    expect(build('claude', TIER_PROFILES.guest, 'c')).not.toContain('search_online_sticker_candidates')
    expect(build('claude', TIER_PROFILES.admin, 'c')).toContain('search_online_sticker_candidates')
  })
})

describe('wireInstructions × 回复交付(spec 2026-10-03 §4.11)', () => {
  const build = () => wireInstructions(deps(), parts(() => false))

  it('不教 reply,讲「最后的话」;admin 才提 message', () => {
    const admin = build()('openai', TIER_PROFILES.admin, 'c')
    expect(admin).toContain('按顺序发给对方') // openai 是聊天型(all_segments)
    expect(admin).not.toContain('`reply(chat_id, text)`')
    expect(admin).toContain('`message(to, text)`')
    expect(build()('openai', TIER_PROFILES.trusted, 'c')).not.toContain('`message(to, text)`')
  })

})

describe('wireInstructions × 管理员工具段(daemonOpsAvailable)', () => {
  // agy 的 wechat MCP 钉死 trusted(agy-mcp-config.ts),today_digest / calendar_agenda 这些 admin 工具根本没注册 ——
  // 提示词里写着有、实际调不到,执行者会以为工具坏了反复去试,或者跟主人说「查不到」。
  const build = () => wireInstructions(deps(), parts(() => false))
  it('claude admin ⇒ advertises today_digest / calendar_agenda; agy admin ⇒ does not; trusted ⇒ does not', () => {
    expect(build()('claude', TIER_PROFILES.admin, 'c')).toContain('calendar_agenda')
    expect(build()('claude', TIER_PROFILES.admin, 'c')).toContain('today_digest')
    expect(build()('agy', TIER_PROFILES.admin, 'c')).not.toContain('today_digest')
    expect(build()('agy', TIER_PROFILES.admin, 'c')).not.toContain('calendar_agenda')
    expect(build()('claude', TIER_PROFILES.trusted, 'c')).not.toContain('today_digest')
  })
})
