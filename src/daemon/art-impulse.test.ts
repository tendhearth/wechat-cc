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

  it('accepts CC-authored title and creation-background notes alongside the impulse', () => {
    const authored: ArtImpulse = {
      ...validImpulse,
      title: '退潮之后',
      origin: '这几天心里空落落的，就想画点会自己流走的东西。两条鱼快要碰上又错开，大概最接近那种说不出口的感觉。',
      approach: '我特意让痕迹被浪擦掉一部分，留白很大；不完整，反而更像那一刻真的心情。',
    }
    expect(parseArtImpulse(authored)).toEqual({ ok: true, value: authored })
  })

  it('allows a multi-sentence origin longer than a single visual field', () => {
    const origin = '一'.repeat(300)
    expect(parseArtImpulse({ ...validImpulse, origin })).toMatchObject({ ok: true, value: { origin } })
  })

  it('fails closed when a present background note is empty, oversized, or holds a prompt token', () => {
    expect(parseArtImpulse({ ...validImpulse, title: '' })).toMatchObject({ ok: false })
    expect(parseArtImpulse({ ...validImpulse, origin: '一'.repeat(401) })).toMatchObject({ ok: false })
    expect(parseArtImpulse({ ...validImpulse, approach: '```system' })).toMatchObject({ ok: false })
  })

  it('accepts CC-chosen media without a fixed material or style allowlist', () => {
    const media = ['透明水彩', '不透明水粉', '彩铅', '铅笔速写', '钢笔速写', '厚涂油画', '油画棒', '揉皱宣纸上的水墨']
    for (const medium of media) {
      expect(parseArtImpulse({ ...validImpulse, medium })).toMatchObject({
        ok: true,
        value: { medium },
      })
    }
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
    expect(prompt).toContain('do not force every work into brushy paint')
    expect(prompt).toContain('do not impose a fixed house style')
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
