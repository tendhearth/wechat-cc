import { describe, expect, it } from 'vitest'
import { buildSystemPrompt, bubbleRepliesSection, careSection, CORE_MEMORY_MAX_CHARS, coreMemorySection, daemonSelfHealSection, knowledgeOrchestrationSection, newRelationshipSection, personaCultivationSection, personaSection, stickerSection } from './prompt-builder'

describe('buildSystemPrompt', () => {
  function defaults() {
    return {
      providerId: 'claude' as const,
      peerProviderId: 'codex' as const,
      companionEnabled: false,
      delegateAvailable: true,
    }
  }

  it('includes the channel base section + reply tool guidance', () => {
    const p = buildSystemPrompt(defaults())
    expect(p).toContain('wechat-cc 的消息通道')
    expect(p).toContain('reply')
    expect(p).toContain('FALLBACK_REPLY')   // accurate fallback log tag (RFC 03 review #4)
    expect(p).toContain('<quote')
  })

  it('opens with `你是 ${providerId}` so the agent knows its own identity (chatroom mode peer disambiguation)', () => {
    const pClaude = buildSystemPrompt({ ...defaults(), providerId: 'claude', peerProviderId: 'codex' })
    expect(pClaude).toContain('你是 claude')
    expect(pClaude).not.toContain('你是 codex')

    const pCodex = buildSystemPrompt({ ...defaults(), providerId: 'codex', peerProviderId: 'claude' })
    expect(pCodex).toContain('你是 codex')
    expect(pCodex).not.toContain('你是 claude')
  })

  it('mentions a2a_send tool and [A2A:<id>] prefix convention', () => {
    const p = buildSystemPrompt(defaults())
    expect(p).toContain('a2a_send')
    expect(p).toContain('[A2A:')
    // Make sure the agent knows agent_id comes from the prefix
    expect(p).toMatch(/agent_id.*前缀|前缀.*agent_id/)
  })

  it('lists every wechat-mcp tool surface (no v0.x staleness regression)', () => {
    const p = buildSystemPrompt(defaults())
    // The original v0.x prompt missed these. Verify they're back.
    for (const t of ['reply', 'reply_voice', 'send_file', 'edit_message', 'broadcast',
                     'list_projects', 'switch_project', 'add_project', 'remove_project',
                     'set_user_name',
                     'voice_config_status', 'save_voice_config',
                     'share_page', 'resurface_page',
                     'memory_read', 'memory_write', 'memory_list',
                     'companion_status', 'companion_enable', 'companion_disable', 'companion_snooze']) {
      expect(p, `missing tool: ${t}`).toContain(t)
    }
  })

  it('omits the daemon self-heal section by default (non-admin / flag absent)', () => {
    const p = buildSystemPrompt(defaults())
    expect(p).not.toContain('自我诊断')
    expect(p).not.toContain('diagnostic_health')
    expect(p).not.toContain('daemon_restart')
  })

  it('includes the daemon self-heal section when daemonOpsAvailable=true', () => {
    const p = buildSystemPrompt({ ...defaults(), daemonOpsAvailable: true })
    expect(p).toContain('自我诊断')
    expect(p).toContain('diagnostic_health')
    expect(p).toContain('diagnostic_turns')
    expect(p).toContain('session_release')
    expect(p).toContain('model_set')
    expect(p).toContain('daemon_restart')
  })

  it('daemonSelfHealSection mentions when-to-use cues, not just tool names', () => {
    const s = daemonSelfHealSection()
    expect(s).toContain('自我诊断')
    // "when to use" framing — a runtime-symptom cue, so the agent connects a
    // vague complaint to a diagnosis rather than only apologising.
    expect(s).toMatch(/卡住|不回|变慢|没反应/)
  })

  it('mentions delegate_codex when this is the claude session (delegateAvailable=true)', () => {
    const p = buildSystemPrompt({ ...defaults(), providerId: 'claude', peerProviderId: 'codex' })
    expect(p).toContain('delegate_codex')
    expect(p).not.toContain('delegate_claude')   // peer-of-claude is codex, not claude
  })

  it('mentions delegate_claude when this is the codex session (mirror)', () => {
    const p = buildSystemPrompt({ ...defaults(), providerId: 'codex', peerProviderId: 'claude' })
    expect(p).toContain('delegate_claude')
    expect(p).not.toContain('delegate_codex')
  })

  it('omits delegate section when delegateAvailable=false (e.g. bare delegate-mode session)', () => {
    const p = buildSystemPrompt({ ...defaults(), delegateAvailable: false })
    expect(p).not.toContain('delegate_codex')
    expect(p).not.toContain('跨 AI 咨询')
  })

  it('warns about forwarding [image:/path] markers verbatim through delegate (Bug B 2026-05-08)', () => {
    // Symmetric to the chatroom moderator paraphrase fix (commits f7acca0
    // + b69973f): the primary writes the delegate prompt itself, so it
    // can drop attachment markers the same way haiku-4-5 does. The fix
    // here is documentation-only — the prompt instructs the primary to
    // copy markers verbatim instead of paraphrasing.
    const p = buildSystemPrompt({ ...defaults(), providerId: 'claude', peerProviderId: 'codex' })
    expect(p).toContain('附件转发')
    expect(p).toContain('[image:/abs/path]')
    expect(p).toContain('marker')
  })

  it('mentions per-chat mode awareness (RFC 03 P2-P5)', () => {
    const p = buildSystemPrompt(defaults())
    // Core per-chat mode switches are present (compact form since prompt-builder
    // update; full command list is in /help, not the system prompt)
    for (const cmd of ['/cc', '/codex', '/both', '/chat', '/solo', '/stop']) {
      expect(p, `missing slash command in mode awareness: ${cmd}`).toContain(cmd)
    }
    // primary_tool pattern present (compact /<p> + <peer> form)
    expect(p).toContain('/<p> + <peer>')
    // Also tells the agent that chatroom envelopes will explain themselves
    expect(p).toContain('chatroom_round')
    expect(p).toContain('不要调 reply')   // chatroom-specific guidance recap
  })

  it('mentions parallel mode prefix is auto-added (so agent does not double-prefix)', () => {
    const p = buildSystemPrompt(defaults())
    expect(p).toMatch(/parallel.*前缀.*不要/s)
  })

  it('omits Companion proactive-push section when disabled', () => {
    const p = buildSystemPrompt({ ...defaults(), companionEnabled: false })
    // The full proactive-tick section (with "已开启" marker + scheduler details) is omitted.
    expect(p).not.toContain('已开启')
    expect(p).not.toContain('定时 tick')
    // companion tool names still listed in tool-surface section though — that's invariant.
    expect(p).toContain('companion_status')
  })

  it('includes Companion proactive-push section when enabled', () => {
    const p = buildSystemPrompt({ ...defaults(), companionEnabled: true })
    expect(p).toContain('Companion 主动推送（已开启）')
    expect(p).toContain('companion_snooze')
    expect(p).toContain('companion_disable')
    // agenda-driven model: companion authors dated follow-ups, system wakes it to fulfil them
    expect(p).toContain('agenda.md')
    expect(p).toContain('due:YYYY-MM-DD')
  })

  it('Companion agenda-tick guidance: default is to send, only skip if expired or user already reported', () => {
    const p = buildSystemPrompt({ ...defaults(), companionEnabled: true })
    // New model: "默认就是发" — send by default, only suppress when expired or already resolved
    expect(p).toContain('默认就是发')
    expect(p).toContain('不产生 assistant text')
  })

  it('memory section is always present (memory is provider-agnostic)', () => {
    const p1 = buildSystemPrompt(defaults())
    const p2 = buildSystemPrompt({ ...defaults(), companionEnabled: true })
    expect(p1).toContain('memory_read')
    expect(p2).toContain('memory_read')
  })

  it('produces deterministic output (no Date.now or env reads)', () => {
    const a = buildSystemPrompt(defaults())
    const b = buildSystemPrompt(defaults())
    expect(a).toBe(b)
  })

  it('declares the envelope ts authoritative for date reasoning', () => {
    const out = buildSystemPrompt({
      providerId: 'claude', companionEnabled: false, delegateAvailable: false,
      peerProviderId: 'codex',
    })
    expect(out).toContain('以 `ts` 为准')
    expect(out).toContain("Today's date")
  })

  it('handles unknown / future providerId pairs without crashing', () => {
    expect(() => buildSystemPrompt({
      providerId: 'gemini' as const, peerProviderId: 'mistral' as const,
      companionEnabled: false, delegateAvailable: true,
    })).not.toThrow()
    const p = buildSystemPrompt({
      providerId: 'gemini' as const, peerProviderId: 'mistral' as const,
      companionEnabled: false, delegateAvailable: true,
    })
    expect(p).toContain('delegate_mistral')
  })
})

describe('bubble-replies prompt section', () => {
  const base = { providerId: 'claude' as const, peerProviderId: 'codex' as const, companionEnabled: false, delegateAvailable: false }

  it('bubbleRepliesSection() instructs sending the first thought immediately, caps at 2-4 bubbles, keeps code whole, and warns against splitting for its own sake', () => {
    const s = bubbleRepliesSection()
    expect(s).toContain('先')
    expect(s).toContain('发出去')
    expect(s).toContain('2-4')
    expect(s).toContain('代码要完整')
    expect(s).toContain('别为拆而拆')
  })

  it('buildSystemPrompt includes the bubble-replies section when bubbleReplies=true', () => {
    const p = buildSystemPrompt({ ...base, bubbleReplies: true })
    expect(p).toContain('气泡式回复')
    expect(p).toContain('2-4')
  })

  it('buildSystemPrompt is byte-identical whether bubbleReplies is false or simply absent, and omits the section', () => {
    const withFalse = buildSystemPrompt({ ...base, bubbleReplies: false })
    const withoutKey = buildSystemPrompt({ ...base })
    expect(withFalse).toBe(withoutKey)
    expect(withoutKey).not.toContain('气泡式回复')
  })
})

describe('file-locate prompt section', () => {
  const base = { providerId: 'claude' as const, peerProviderId: 'codex' as const, companionEnabled: false, delegateAvailable: false }
  it('includes the locate section + locations.md guidance when fileLocateAvailable', () => {
    const p = buildSystemPrompt({ ...base, fileLocateAvailable: true })
    expect(p).toContain('locate_file')
    expect(p).toContain('locations.md')
  })
  it('omits it otherwise', () => {
    const p = buildSystemPrompt({ ...base })
    expect(p).not.toContain('locate_file')
    expect(p).not.toContain('locations.md')
  })
})

describe('care prompt section', () => {
  const base = { providerId: 'claude' as const, peerProviderId: 'codex' as const, companionEnabled: false, delegateAvailable: false }

  it('careSection() instructs authoring care intentions into agenda.md with the due: format, and adjusting via set_chat_pref', () => {
    const s = careSection()
    expect(s).toContain('agenda.md')
    expect(s).toContain('due:')
    expect(s).toContain('set_chat_pref')
  })

  it('buildSystemPrompt includes the care section when careEnabled=true', () => {
    const p = buildSystemPrompt({ ...base, careEnabled: true })
    expect(p).toContain('agenda.md')
    expect(p).toContain('set_chat_pref')
  })

  it('buildSystemPrompt is byte-identical whether careEnabled is false or simply absent, and omits the care section', () => {
    const withFalse = buildSystemPrompt({ ...base, careEnabled: false })
    const withoutKey = buildSystemPrompt({ ...base })
    expect(withFalse).toBe(withoutKey)
    expect(withoutKey).not.toContain('set_chat_pref')
  })
})

describe('new-relationship prompt section', () => {
  const base = { providerId: 'claude' as const, peerProviderId: 'codex' as const, companionEnabled: false, delegateAvailable: false }

  it('newRelationshipSection() instructs light, at-most-one-question curiosity and warns against interrogation', () => {
    const s = newRelationshipSection()
    expect(s).toContain('刚认识')
    expect(s).toContain('一次最多一个问题')
    expect(s).toContain('别像查户口')
  })

  it('buildSystemPrompt includes the new-relationship section when newRelationship=true', () => {
    const p = buildSystemPrompt({ ...base, newRelationship: true })
    expect(p).toContain('刚认识')
    expect(p).toContain('一次最多一个问题')
  })

  it('buildSystemPrompt is byte-identical whether newRelationship is false or simply absent, and omits the section', () => {
    const withFalse = buildSystemPrompt({ ...base, newRelationship: false })
    const withoutKey = buildSystemPrompt({ ...base })
    expect(withFalse).toBe(withoutKey)
    expect(withoutKey).not.toContain('刚认识')
  })
})

describe('sticker prompt section', () => {
  const base = { providerId: 'claude' as const, peerProviderId: 'codex' as const, companionEnabled: false, delegateAvailable: false }

  it('stickerSection() mentions send_sticker + lists the given tags', () => {
    const s = stickerSection(['happy', 'sad', 'party'])
    expect(s).toContain('send_sticker')
    expect(s).toContain('happy')
    expect(s).toContain('sad')
    expect(s).toContain('party')
  })

  it('stickerSection() caps the rendered list at 30 tags and drops any tag containing a newline', () => {
    const many = Array.from({ length: 35 }, (_, i) => `tag${i}`)
    const s = stickerSection([...many, 'bad\ntag'])
    expect(s).not.toContain('bad\ntag')
    expect(s).not.toContain('tag34')
    expect(s).toContain('tag29')
  })

  it('stickerSection() filters out tags containing spaces', () => {
    const s = stickerSection(['good', 'bad tag', 'also-good'])
    expect(s).toContain('good')
    expect(s).not.toContain('bad tag')
    expect(s).toContain('also-good')
  })

  it('stickerSection() filters out tags longer than 20 characters', () => {
    const s = stickerSection(['ok', 'tooshort', 'a'.repeat(21)])
    expect(s).toContain('ok')
    expect(s).toContain('tooshort')
    expect(s).not.toContain('a'.repeat(21))
  })

  it('buildSystemPrompt includes the sticker section when stickerTags is non-empty', () => {
    const p = buildSystemPrompt({ ...base, stickerTags: ['happy', 'sad'] })
    expect(p).toContain('send_sticker')
    expect(p).toContain('happy')
    expect(p).toContain('sad')
  })

  it('buildSystemPrompt is byte-identical whether stickerTags is absent or an empty array, and omits the sticker section', () => {
    const withoutKey = buildSystemPrompt({ ...base })
    const withEmpty = buildSystemPrompt({ ...base, stickerTags: [] })
    expect(withEmpty).toBe(withoutKey)
    expect(withoutKey).not.toContain('send_sticker')
  })
})

describe('persona prompt section', () => {
  const base = { providerId: 'claude' as const, peerProviderId: 'codex' as const, companionEnabled: false, delegateAvailable: false }

  it('personaSection() includes the 人设 heading + the given content', () => {
    const s = personaSection('说话像个话痨,喜欢用叠词')
    expect(s).toContain('人设')
    expect(s).toContain('说话像个话痨,喜欢用叠词')
  })

  it('personaSection() caps content at 4000 chars', () => {
    const long = 'x'.repeat(5000)
    const s = personaSection(long)
    expect(s.length).toBeLessThan(4200)
    expect(s).not.toContain('x'.repeat(4001))
  })

  it('personaCultivationSection() mentions persona.md, memory_write, and 克制', () => {
    const s = personaCultivationSection()
    expect(s).toContain('persona.md')
    expect(s).toContain('memory_write')
    expect(s).toContain('克制')
  })

  it('buildSystemPrompt includes the persona section when persona is a non-empty string', () => {
    const p = buildSystemPrompt({ ...base, persona: '喜欢用颜文字' })
    expect(p).toContain('喜欢用颜文字')
    expect(p).toContain('人设')
  })

  it('buildSystemPrompt is byte-identical whether persona is absent or whitespace-only, and omits the persona section', () => {
    const withoutKey = buildSystemPrompt({ ...base })
    const withWhitespace = buildSystemPrompt({ ...base, persona: '  ' })
    expect(withWhitespace).toBe(withoutKey)
    expect(withoutKey).not.toContain('你的人设')
  })

  it('buildSystemPrompt includes the persona cultivation section when personaCultivate=true', () => {
    const p = buildSystemPrompt({ ...base, personaCultivate: true })
    expect(p).toContain('人设养成')
    expect(p).toContain('memory_write')
  })

  it('buildSystemPrompt is byte-identical whether personaCultivate is false or simply absent, and omits the cultivation section', () => {
    const withFalse = buildSystemPrompt({ ...base, personaCultivate: false })
    const withoutKey = buildSystemPrompt({ ...base })
    expect(withFalse).toBe(withoutKey)
    expect(withoutKey).not.toContain('人设养成')
  })

  it('both persona sections appear together when both are enabled', () => {
    const p = buildSystemPrompt({ ...base, persona: '话风活泼', personaCultivate: true })
    expect(p).toContain('你的人设')
    expect(p).toContain('人设养成')
  })

  it('buildSystemPrompt includes the empty-persona seed nudge when personaCultivate=true and personaEmpty=true', () => {
    const p = buildSystemPrompt({ ...base, personaCultivate: true, personaEmpty: true })
    expect(p).toContain('人设养成')
    expect(p).toContain('现在还是空的')
    expect(p).toContain('有想对标的人也行')
  })

  it('buildSystemPrompt includes the cultivation section but NOT the nudge, byte-identical to cultivate-only output, when personaEmpty is false or absent', () => {
    const cultivateOnly = buildSystemPrompt({ ...base, personaCultivate: true })
    const withFalse = buildSystemPrompt({ ...base, personaCultivate: true, personaEmpty: false })
    expect(withFalse).toBe(cultivateOnly)
    expect(cultivateOnly).toContain('人设养成')
    expect(cultivateOnly).not.toContain('现在还是空的')
  })

  it('buildSystemPrompt omits the cultivation section entirely when personaEmpty=true but personaCultivate is false/absent (nudge is nested)', () => {
    const p = buildSystemPrompt({ ...base, personaEmpty: true })
    expect(p).not.toContain('人设养成')
    expect(p).not.toContain('现在还是空的')
  })
})

describe('core-memory prompt section', () => {
  const base = { providerId: 'claude' as const, peerProviderId: 'codex' as const, companionEnabled: false, delegateAvailable: false }

  it('coreMemorySection() includes the 核心记忆 heading + the given content', () => {
    const s = coreMemorySection('喜欢猫,养了一只叫豆豆的橘猫')
    expect(s).toContain('核心记忆')
    expect(s).toContain('喜欢猫,养了一只叫豆豆的橘猫')
  })

  it('coreMemorySection() slices content over CORE_MEMORY_MAX_CHARS and appends a truncation note', () => {
    const long = 'x'.repeat(2000)
    const s = coreMemorySection(long)
    expect(s).not.toContain('x'.repeat(CORE_MEMORY_MAX_CHARS + 1))
    expect(s).toContain('x'.repeat(CORE_MEMORY_MAX_CHARS))
    expect(s).toContain('核心记忆已截断')
    expect(s).toContain('memory_read')
  })

  it('coreMemorySection() does NOT truncate content under the cap', () => {
    const content = 'y'.repeat(1400)
    const s = coreMemorySection(content)
    expect(s).toContain(content)
    expect(s).not.toContain('核心记忆已截断')
  })

  it('buildSystemPrompt includes the core-memory section when coreMemory is a non-empty string', () => {
    const p = buildSystemPrompt({ ...base, coreMemory: '这个人叫小明,喜欢徒步' })
    expect(p).toContain('核心记忆')
    expect(p).toContain('这个人叫小明,喜欢徒步')
  })

  it('buildSystemPrompt is byte-identical whether coreMemory is absent or whitespace-only, and omits the section', () => {
    const withoutKey = buildSystemPrompt({ ...base })
    const withWhitespace = buildSystemPrompt({ ...base, coreMemory: '  ' })
    expect(withWhitespace).toBe(withoutKey)
    expect(withoutKey).not.toContain('核心记忆')
  })

  it('places the core-memory section immediately after the persona section, before the tools section', () => {
    const personaOnly = buildSystemPrompt({ ...base, persona: '话风活泼' })
    const personaPlusCore = buildSystemPrompt({ ...base, persona: '话风活泼', coreMemory: '喜欢猫' })

    expect(personaOnly).not.toContain('核心记忆')

    const personaIdx = personaPlusCore.indexOf('你的人设')
    const coreIdx = personaPlusCore.indexOf('核心记忆')
    const toolsIdx = personaPlusCore.indexOf('可用 wechat 工具')
    expect(personaIdx).toBeGreaterThan(-1)
    expect(coreIdx).toBeGreaterThan(personaIdx)
    expect(coreIdx).toBeLessThan(toolsIdx)

    // Nothing else shifted: personaPlusCore is personaOnly with exactly the
    // core-memory section (+ join separator) spliced in right after persona.
    const expected = `${personaOnly.slice(0, personaIdx + '你的人设'.length)}`
    expect(expected).toBe(personaOnly.slice(0, personaIdx + '你的人设'.length))
    const withoutCoreSpliced = personaPlusCore.slice(0, personaIdx) + personaPlusCore.slice(toolsIdx)
    const toolsIdxInPersonaOnly = personaOnly.indexOf('可用 wechat 工具')
    expect(withoutCoreSpliced).toBe(personaOnly.slice(0, personaIdx) + personaOnly.slice(toolsIdxInPersonaOnly))
  })

  it('buildSystemPrompt is byte-identical across a fuller config when coreMemory is absent vs explicitly undefined (no other section shifted)', () => {
    const configA = { ...base, companionEnabled: true, careEnabled: true, stickerTags: ['a'], persona: '话风活泼' }
    const withoutKey = buildSystemPrompt(configA)
    const withUndefined = buildSystemPrompt({ ...configA, coreMemory: undefined })
    expect(withUndefined).toBe(withoutKey)
  })
})

describe('knowledge-orchestration prompt section', () => {
  const base = { providerId: 'claude' as const, peerProviderId: 'codex' as const, companionEnabled: false, delegateAvailable: false }

  it('knowledgeOrchestrationSection() includes the heading + compose framing + name-resolution note', () => {
    const s = knowledgeOrchestrationSection(['wxgraph'])
    expect(s).toContain('知识编排')
    expect(s).toContain('把你的看法 + 关系 + 事实拼起来')
    expect(s).toContain('用人名找人')
    expect(s).toContain('同名可能对不准')
  })

  it('renders only bullets for known plugins that are present: wxgraph+wxsearch includes those two, not facts/media', () => {
    const s = knowledgeOrchestrationSection(['wxgraph', 'wxsearch'])
    expect(s).toContain('关系画像')
    expect(s).toContain('消息检索')
    expect(s).not.toContain('结构化事实')
    expect(s).not.toContain('语音/图片转出的文字')
  })

  it('renders only the facts bullet when only wxfacts is present', () => {
    const s = knowledgeOrchestrationSection(['wxfacts'])
    expect(s).toContain('结构化事实')
    expect(s).not.toContain('关系画像')
    expect(s).not.toContain('消息检索')
    expect(s).not.toContain('语音/图片转出的文字')
  })

  it('adds the person_brief "一步到位" lead only when wxperson is present', () => {
    const withPerson = knowledgeOrchestrationSection(['wxperson', 'wxgraph'])
    expect(withPerson).toContain('person_brief(名字)')
    expect(withPerson).toContain('一步到位')
    // wxperson alone still renders the section (lead, no source bullets)
    const personOnly = knowledgeOrchestrationSection(['wxperson'])
    expect(personOnly).toContain('person_brief(名字)')
    expect(personOnly).not.toContain('contact_profile')   // no wxgraph source bullet
    // no wxperson ⇒ no person_brief pointer
    expect(knowledgeOrchestrationSection(['wxgraph'])).not.toContain('person_brief')
  })

  it('adds the obligation→agenda flow-back only when wxfacts is present', () => {
    const withFacts = knowledgeOrchestrationSection(['wxfacts'])
    expect(withFacts).toContain('未了义务 → 主动')
    expect(withFacts).toContain('find_facts(kind=obligation)')
    expect(withFacts).toContain('agenda.md')
    // no wxfacts ⇒ no flow-back line
    expect(knowledgeOrchestrationSection(['wxgraph'])).not.toContain('未了义务 → 主动')
  })

  it('wxperson counts as a known plugin: buildSystemPrompt renders the section for wxperson alone', () => {
    const p = buildSystemPrompt({ ...base, knowledgePlugins: ['wxperson'] })
    expect(p).toContain('知识编排')
    expect(p).toContain('person_brief(名字)')
  })

  it('buildSystemPrompt includes the section when a known knowledge plugin is present', () => {
    const p = buildSystemPrompt({ ...base, knowledgePlugins: ['wxgraph'] })
    expect(p).toContain('知识编排')
    expect(p).toContain('关系画像')
  })

  it('buildSystemPrompt is byte-identical whether knowledgePlugins is absent, empty, or all-unknown (section omitted)', () => {
    const withoutKey = buildSystemPrompt({ ...base })
    const withEmpty = buildSystemPrompt({ ...base, knowledgePlugins: [] })
    const withUnknown = buildSystemPrompt({ ...base, knowledgePlugins: ['some-unknown-plugin'] })
    expect(withEmpty).toBe(withoutKey)
    expect(withUnknown).toBe(withoutKey)
    expect(withoutKey).not.toContain('知识编排')
  })

  it('places the knowledge section immediately after the memory section, no other section shifted', () => {
    const withoutKnowledge = buildSystemPrompt({ ...base })
    const withKnowledge = buildSystemPrompt({ ...base, knowledgePlugins: ['wxgraph'] })

    const memoryIdx = withKnowledge.indexOf('长期记忆')
    const knowledgeIdx = withKnowledge.indexOf('知识编排')
    const multiModeIdx = withKnowledge.indexOf('模式感知')
    expect(memoryIdx).toBeGreaterThan(-1)
    expect(knowledgeIdx).toBeGreaterThan(memoryIdx)
    expect(knowledgeIdx).toBeLessThan(multiModeIdx)

    // Nothing else shifted: withKnowledge is withoutKnowledge with exactly the
    // knowledge section (+ join separator) spliced in right after memory.
    const multiModeIdxWithout = withoutKnowledge.indexOf('模式感知')
    const withoutKnowledgeSpliced = withKnowledge.slice(0, memoryIdx) + withKnowledge.slice(multiModeIdx)
    expect(withoutKnowledgeSpliced).toBe(withoutKnowledge.slice(0, memoryIdx) + withoutKnowledge.slice(multiModeIdxWithout))
  })
})
