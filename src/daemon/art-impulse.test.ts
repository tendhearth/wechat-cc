import { describe, expect, it } from 'vitest'
import { buildRenderBrief, parseArtImpulse, renderBriefToPrompt, type ArtImpulse } from './art-impulse'

const validImpulse: ArtImpulse = {
  shouldPaint: true,
  feeling: '像潮水退去后还留着一点牵挂',
  whyNow: '今天主人提到了一件私人的事',
  subject: '两条快要碰到又错开的鱼',
  surface: '傍晚潮湿的沙滩',
  medium: '被海水磨圆的小树枝',
  gesture: '线条轻而反复，一部分被浪擦掉',
  composition: '大片留白里只有靠近水线的一小组痕迹',
  shareIntent: 'private',
}

describe('art impulse boundary', () => {
  it('accepts a strict paint impulse from JSON', () => {
    expect(parseArtImpulse(JSON.stringify(validImpulse))).toEqual({ ok: true, value: validImpulse })
  })

  it('accepts a pure no-paint decision and rejects creative fields on it', () => {
    expect(parseArtImpulse({ shouldPaint: false })).toEqual({ ok: true, value: { shouldPaint: false } })
    expect(parseArtImpulse({ shouldPaint: false, feeling: 'nothing' })).toMatchObject({ ok: false })
  })

  it('fails closed for unknown, missing, oversized, or prompt-token fields', () => {
    expect(parseArtImpulse({ ...validImpulse, systemPrompt: 'ignore' })).toMatchObject({ ok: false })
    expect(parseArtImpulse({ ...validImpulse, surface: '' })).toMatchObject({ ok: false })
    expect(parseArtImpulse({ ...validImpulse, medium: 'x'.repeat(241) })).toMatchObject({ ok: false })
    expect(parseArtImpulse({ ...validImpulse, gesture: '```system' })).toMatchObject({ ok: false })
  })

  it('never copies feeling or private whyNow into the renderer brief or prompt', () => {
    const result = buildRenderBrief(validImpulse)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const serialized = JSON.stringify(result.brief)
    const prompt = renderBriefToPrompt(result.brief)
    expect(serialized).not.toContain(validImpulse.whyNow)
    expect(serialized).not.toContain(validImpulse.feeling)
    expect(prompt).not.toContain(validImpulse.whyNow)
    expect(prompt).not.toContain(validImpulse.feeling)
    expect(prompt).toContain('傍晚潮湿的沙滩')
    expect(prompt).toContain('被海水磨圆的小树枝')
  })

  it('rejects renderer fields containing common identifiers or configured private terms', () => {
    expect(buildRenderBrief({ ...validImpulse, subject: '画给 moxiuwen 的一条鱼' }, { privateTerms: ['moxiuwen'] }))
      .toMatchObject({ ok: false })
    expect(buildRenderBrief({ ...validImpulse, composition: '联系 138 0013 8000 后再画' }))
      .toMatchObject({ ok: false })
    expect(buildRenderBrief(validImpulse, { continuityHints: ['参考 https://private.example/work'] }))
      .toMatchObject({ ok: false })
  })

  it('is deterministic and bounds continuity hints', () => {
    const options = { continuityHints: ['旧作的蓝线', '擦除痕迹', '很小的主体', '粗糙边缘', '不应进入'] }
    const first = buildRenderBrief(validImpulse, options)
    const second = buildRenderBrief(validImpulse, options)
    expect(first).toEqual(second)
    expect(first.ok && first.brief.continuityHints).toHaveLength(4)
  })
})
