import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../ports/agent-provider'
import {
  extractTurnReply, makeTurnTextCollector, parseSilence, buildTurnReply, NO_REPLY_TOKEN,
  silenceAllowed, type TurnAttachment,
} from './turn-reply'

const text = (t: string, extra: Partial<Extract<AgentEvent, { kind: 'text' }>> = {}): AgentEvent => ({ kind: 'text', text: t, ...extra })
const tool = (name: string, server = 'wechat'): AgentEvent => ({ kind: 'tool_call', tool: name, server })
const result: AgentEvent = { kind: 'result', sessionId: 's', numTurns: 1, durationMs: 1 }

describe('extractTurnReply — 最后一段非空文字就是回复(spec §4.1 / 已定 ⑦)', () => {
  it('只有一段文字 ⇒ 它就是回复,没有旁白', () => {
    expect(extractTurnReply([text('你好呀'), result])).toEqual({ finalText: '你好呀', narration: [] })
  })

  it('「让我查一下」→ 工具 →「查到了」:前一段是旁白,后一段是回复', () => {
    const r = extractTurnReply([text('让我查一下'), tool('list_projects'), text('你有两个项目:a 和 b'), result])
    expect(r.finalText).toBe('你有两个项目:a 和 b')
    expect(r.narration).toEqual(['让我查一下'])
  })

  it('「好的我记下了」→ memory_write → 空着结束:取最后一段**非空**的', () => {
    const r = extractTurnReply([text('好的,我记下了。'), tool('memory_write'), result])
    expect(r).toEqual({ finalText: '好的,我记下了。', narration: [] })
  })

  it('只有工具、没有文字 ⇒ 空回复', () => {
    expect(extractTurnReply([tool('memory_read'), tool('memory_write'), result])).toEqual({ finalText: '', narration: [] })
  })

  it('同一段里的多条 text 事件按空行拼起来(多条助理消息 = 多个意思)', () => {
    const r = extractTurnReply([text('第一句'), text('第二句'), result])
    expect(r.finalText).toBe('第一句\n\n第二句')
  })

  it('纯空白段不算一段', () => {
    const r = extractTurnReply([text('  \n'), tool('x'), text('结论'), tool('y'), text('\n\t'), result])
    expect(r).toEqual({ finalText: '结论', narration: [] })
  })

  it('多段旁白按顺序保留', () => {
    const r = extractTurnReply([text('一'), tool('a'), text('二'), tool('b'), text('三'), result])
    expect(r).toEqual({ finalText: '三', narration: ['一', '二'] })
  })

  it('textMode=replace + 同 itemId ⇒ 替换,不追加', () => {
    const r = extractTurnReply([text('草稿', { itemId: 'm1' }), text('定稿', { itemId: 'm1', textMode: 'replace' }), result])
    expect(r.finalText).toBe('定稿')
  })

  it('error 事件的文案永远不进最后的话', () => {
    const r = extractTurnReply([text('先说一句'), { kind: 'error', message: 'Not logged in', code: 'auth_failed' } as AgentEvent])
    expect(r.finalText).toBe('先说一句')
    expect(r.narration).toEqual([])
  })

  it('增量收集器与一次性提取结果一致,并能随时读最近一段旁白', () => {
    const c = makeTurnTextCollector()
    c.push(text('我去查'))
    expect(c.latestSegment()).toBe('我去查')
    c.push(tool('search'))
    c.push(text('查到了'))
    expect(c.parts()).toEqual({ finalText: '查到了', narration: ['我去查'] })
  })

  // 回复交付第 4 步(Codex):每条 agent_message 是一条完整消息、自成一段 —— 两条之间没有工具也不粘。
  it('ownSegment 的文字自成一段:最后的话 = 最后一条非空消息;空消息不算;不带 ownSegment 的照旧同段拼', () => {
    const own = (t: string) => ({ kind: 'text', text: t, ownSegment: true }) as AgentEvent
    expect(extractTurnReply([own('我先想一想。'), own('结论是 X。')])).toEqual({ finalText: '结论是 X。', narration: ['我先想一想。'] })
    expect(extractTurnReply([own('我先查一下。'), tool('list_projects'), own('有两个项目。'), own('')])).toEqual({ finalText: '有两个项目。', narration: ['我先查一下。'] })
    expect(extractTurnReply([own('只有一句。')])).toEqual({ finalText: '只有一句。', narration: [] })
    expect(extractTurnReply([text('第一块'), text('第二块')])).toEqual({ finalText: '第一块\n\n第二块', narration: [] })
  })
})

describe('parseSilence — NO_REPLY 永不出现在主人屏幕上(spec §4.4)', () => {
  it('整段就是令牌(不分大小写、去首尾空白)⇒ silent', () => {
    expect(parseSilence('  NO_REPLY \n')).toEqual({ text: '', silent: true, mixed: false })
    expect(parseSilence('no_reply')).toEqual({ text: '', silent: true, mixed: false })
  })

  it('令牌单独一行夹在别的文字里 ⇒ 去掉这一行,其余照发,mixed', () => {
    expect(parseSilence('今天不打扰你了\nNO_REPLY')).toEqual({ text: '今天不打扰你了', silent: false, mixed: true })
    expect(parseSilence('NO_REPLY\n\n好吧还是说一句')).toEqual({ text: '好吧还是说一句', silent: false, mixed: true })
  })

  it('令牌贴在句尾 / 句首 ⇒ 也剥掉', () => {
    expect(parseSilence('嗯,这次就不发了。NO_REPLY')).toEqual({ text: '嗯,这次就不发了。', silent: false, mixed: true })
    expect(parseSilence('NO_REPLY 先不说')).toEqual({ text: '先不说', silent: false, mixed: true })
  })

  it('代码里讨论这个令牌(行内,非首尾)⇒ 原样保留', () => {
    const t = '把 `NO_REPLY` 当成静默令牌就好,别在私聊里用。'
    expect(parseSilence(t)).toEqual({ text: t, silent: false, mixed: false })
  })

  it('标识符结尾带 NO_REPLY(SKIP_NO_REPLY)不是令牌', () => {
    expect(parseSilence('设成 SKIP_NO_REPLY')).toEqual({ text: '设成 SKIP_NO_REPLY', silent: false, mixed: false })
  })

  it('普通文字 ⇒ 不动', () => {
    expect(parseSilence('你好')).toEqual({ text: '你好', silent: false, mixed: false })
  })

  it('令牌常量就是 NO_REPLY', () => {
    expect(NO_REPLY_TOKEN).toBe('NO_REPLY')
  })
})

describe('buildTurnReply — 场合决定静默算不算数(已定 ②)', () => {
  const voice: TurnAttachment = { kind: 'voice', text: '晚安' }

  it('推送 / /chat / /both 允许静默;私聊不允许', () => {
    expect(silenceAllowed('tick')).toBe(true)
    expect(silenceAllowed('chatroom')).toBe(true)
    expect(silenceAllowed('parallel')).toBe(true)
    expect(silenceAllowed('dm')).toBe(false)
  })

  it('推送里写 NO_REPLY ⇒ silent,不是异常', () => {
    const b = buildTurnReply({ finalText: 'NO_REPLY', narration: [] }, [], 'tick')
    expect(b.reply).toEqual({ text: '', silent: true, attachments: [], narration: [] })
    expect(b.silentInDm).toBe(false)
  })

  it('私聊里写 NO_REPLY ⇒ 照样不显示,但标出 silentInDm(异常记账)', () => {
    const b = buildTurnReply({ finalText: 'NO_REPLY', narration: ['想了想'] }, [], 'dm')
    expect(b.reply.text).toBe('')
    expect(b.reply.silent).toBe(true)
    expect(b.silentInDm).toBe(true)
  })

  it('附件按调用顺序带上;旁白原样保留(不发微信,给 app 显示)', () => {
    const b = buildTurnReply({ finalText: '好', narration: ['查一下'] }, [voice], 'dm')
    expect(b.reply).toEqual({ text: '好', silent: false, attachments: [voice], narration: ['查一下'] })
  })

  it('旁白里的令牌行也剥掉(app 会显示旁白)', () => {
    const b = buildTurnReply({ finalText: '好', narration: ['NO_REPLY'] }, [], 'dm')
    expect(b.reply.narration).toEqual([])
  })
})

describe('buildTurnReply — 聊天型模型:本轮所有文字段按顺序都交付(2026-10-03 修订)', () => {
  it('all_segments:旁白不再丢,按顺序成为 segments;text 是它们拼起来', () => {
    const b = buildTurnReply({ finalText: '第二条和第三条', narration: ['第一条建议'] }, [], 'dm', 'all_segments')
    expect(b.reply.segments).toEqual(['第一条建议', '第二条和第三条'])
    expect(b.reply.text).toBe('第一条建议\n\n第二条和第三条')
    expect(b.reply.narration).toEqual([])
  })

  it('last_segment(缺省,编码型执行者):照旧只取最后一段', () => {
    const b = buildTurnReply({ finalText: '结论', narration: ['我去查'] }, [], 'dm')
    expect(b.reply.segments).toBeUndefined()
    expect(b.reply.text).toBe('结论')
    expect(b.reply.narration).toEqual(['我去查'])
  })

  it('all_segments + 推送:最后一段是 NO_REPLY ⇒ 整轮静默(前面的「我看看记忆」也不发)', () => {
    const b = buildTurnReply({ finalText: 'NO_REPLY', narration: ['我先看看记忆'] }, [], 'tick', 'all_segments')
    expect(b.reply.silent).toBe(true)
    expect(b.reply.text).toBe('')
    expect(b.reply.segments).toEqual([])
  })

  it('all_segments + 私聊:最后一段是 NO_REPLY ⇒ 令牌吞掉、记异常,前面真说过的话照发', () => {
    const b = buildTurnReply({ finalText: 'NO_REPLY', narration: ['好的,我记下了'] }, [], 'dm', 'all_segments')
    expect(b.silentInDm).toBe(true)
    expect(b.reply.silent).toBe(false)
    expect(b.reply.segments).toEqual(['好的,我记下了'])
  })

  it('all_segments:每段里的令牌行都剥掉', () => {
    const b = buildTurnReply({ finalText: '好的', narration: ['先说一句\nNO_REPLY'] }, [], 'dm', 'all_segments')
    expect(b.reply.segments).toEqual(['先说一句', '好的'])
    expect(b.mixed).toBe(true)
  })
})

describe('all_segments:只有标点 / 空白的段不是一句话', () => {
  it('「。」这种段丢掉,不发成一条气泡(第 3 轮闸门 f#2 抓到的)', () => {
    const b = buildTurnReply({ finalText: '。', narration: ['晚安'] }, [], 'dm', 'all_segments')
    expect(b.reply.segments).toEqual(['晚安'])
  })
})

// 2026-10 变异测试第二轮:取「最后的话」的段边界、改写(replace)、自成一段,以及 NO_REPLY 令牌的边界,逐条成表。
describe('makeTurnTextCollector — 段的边界(变异测试第二轮)', () => {
  const parts = (evs: Array<Record<string, unknown>>) => extractTurnReply(evs as never)
  it('非 text 事件带着文字也不进任何一段(error 不许当回复发,#190)', () => {
    expect(parts([{ kind: 'text', text: '在查' }, { kind: 'error', text: '炸了' }, { kind: 'result', text: 'x' }]))
      .toEqual({ finalText: '在查', narration: [] })
  })
  it('text 事件没有字符串 text ⇒ 忽略', () => {
    expect(parts([{ kind: 'text', text: '好' }, { kind: 'text' }])).toEqual({ finalText: '好', narration: [] })
  })
  it('空白的 text 不占一段、不拼进去', () => {
    expect(parts([{ kind: 'text', text: 'a' }, { kind: 'text', text: '  \n' }, { kind: 'text', text: 'b' }]))
      .toEqual({ finalText: 'a\n\nb', narration: [] })
  })
  it('tool_call 前没有字 ⇒ 不起空段;连着两个 tool_call 也只隔一段', () => {
    expect(parts([{ kind: 'tool_call' }, { kind: 'text', text: 'a' }, { kind: 'tool_call' }, { kind: 'tool_call' }, { kind: 'text', text: 'b' }]))
      .toEqual({ finalText: 'b', narration: ['a'] })
  })
  it('同一 itemId 的 replace ⇒ 原地改写那一条;append(不带 replace)⇒ 另起一条', () => {
    expect(parts([{ kind: 'text', text: '草稿', itemId: 'm1' }, { kind: 'text', text: '定稿', itemId: 'm1', textMode: 'replace' }]))
      .toEqual({ finalText: '定稿', narration: [] })
    expect(parts([{ kind: 'text', text: '一', itemId: 'm1' }, { kind: 'text', text: '二', itemId: 'm1' }]))
      .toEqual({ finalText: '一\n\n二', narration: [] })
  })
  it('replace 只认本段见过的 itemId:隔了一个 tool_call 再来 ⇒ 是新的一条,不改写上一段', () => {
    expect(parts([{ kind: 'text', text: '前', itemId: 'm1' }, { kind: 'tool_call' }, { kind: 'text', text: '后', itemId: 'm1', textMode: 'replace' }]))
      .toEqual({ finalText: '后', narration: ['前'] })
  })
  it('隔了 tool_call 的新段里已经有一条了,再来上一段的 itemId replace ⇒ 追加,不覆盖新段那一条', () => {
    expect(parts([{ kind: 'text', text: '前', itemId: 'm1' }, { kind: 'tool_call' }, { kind: 'text', text: '新' }, { kind: 'text', text: '后', itemId: 'm1', textMode: 'replace' }]))
      .toEqual({ finalText: '新\n\n后', narration: ['前'] })
  })
  it('没见过的 itemId 来 replace ⇒ 当新的一条追加', () => {
    expect(parts([{ kind: 'text', text: 'a', itemId: 'x' }, { kind: 'text', text: 'b', itemId: 'y', textMode: 'replace' }]))
      .toEqual({ finalText: 'a\n\nb', narration: [] })
  })
  it('ownSegment(Codex 的 agent_message)自成一段;本段还空着时不多起一段;之后同 itemId 的 replace 改的是新段', () => {
    expect(parts([
      { kind: 'text', text: '先看看', itemId: 'a', ownSegment: true },
      { kind: 'text', text: '结论', itemId: 'b', ownSegment: true },
      { kind: 'text', text: '最终结论', itemId: 'b', textMode: 'replace' },
    ])).toEqual({ finalText: '最终结论', narration: ['先看看'] })
    // 进了新段以后,上一段的 itemId 不再认:replace 'a' 是新的一条
    expect(parts([
      { kind: 'text', text: '一', itemId: 'a', ownSegment: true },
      { kind: 'text', text: '二', itemId: 'b', ownSegment: true },
      { kind: 'text', text: '三', itemId: 'a', textMode: 'replace' },
    ])).toEqual({ finalText: '二\n\n三', narration: ['一'] })
  })
})

describe('parseSilence — 令牌边界(变异测试第二轮)', () => {
  it.each([
    // [原文, 期望]
    ['no_reply', { text: '', silent: true, mixed: false }],
    ['NO_REPLYING', { text: 'NO_REPLYING', silent: false, mixed: false }],
    ['这件事 NO_REPLYING', { text: '这件事 NO_REPLYING', silent: false, mixed: false }],
    ['代码里用 NO_REPLY 这个令牌表示不回', { text: '代码里用 NO_REPLY 这个令牌表示不回', silent: false, mixed: false }],
    ['NO_REPLY，好的', { text: '好的', silent: false, mixed: true }],
    ['好的\nNO_REPLY', { text: '好的', silent: false, mixed: true }],
    ['NO_REPLY\n  no_reply  ', { text: '', silent: true, mixed: false }],
    ['NO_REPLY\n\nNO_REPLY', { text: '', silent: true, mixed: false }],
    ['收到 NO_REPLY', { text: '收到', silent: false, mixed: true }],
    ['先说一句\nNO_REPLY\n再说一句', { text: '先说一句\n再说一句', silent: false, mixed: true }],
  ] as const)('%j', (raw, want) => {
    expect(parseSilence(raw)).toEqual(want)
  })
})

describe('buildTurnReply — 静默与旁白(变异测试第二轮)', () => {
  it('last_segment:旁白里的令牌段整段去掉、空白段去掉,其余原样', () => {
    const r = buildTurnReply({ finalText: '结论', narration: ['NO_REPLY', '  ', '先看看 NO_REPLY'] }, [], 'dm')
    expect(r.reply.narration).toEqual(['先看看'])
  })
  it('不传策略 ⇒ last_segment:前面的段只当旁白', () => {
    const r = buildTurnReply({ finalText: '二', narration: ['一'] }, [], 'dm')
    expect(r.reply).toEqual({ text: '二', silent: false, attachments: [], narration: ['一'] })
  })
  it('all_segments:最后一段 NO_REPLY + 允许静默 ⇒ 整轮不发,附件照带', () => {
    const att = [{ kind: 'file', path: '/a' }] as const
    const r = buildTurnReply({ finalText: 'NO_REPLY', narration: ['我先看看'] }, att, 'tick', 'all_segments')
    expect(r).toEqual({ reply: { text: '', silent: true, attachments: [{ kind: 'file', path: '/a' }], narration: [], segments: [] }, silentInDm: false, mixed: false })
  })
  it('all_segments:私聊里最后一段 NO_REPLY ⇒ 前面说过的照发,不算静默,记 silentInDm', () => {
    const r = buildTurnReply({ finalText: 'NO_REPLY', narration: ['我先看看'] }, [], 'dm', 'all_segments')
    expect(r).toEqual({ reply: { text: '我先看看', silent: false, attachments: [], narration: [], segments: ['我先看看'] }, silentInDm: true, mixed: false })
  })
  it('all_segments:私聊里只有 NO_REPLY ⇒ silent(不显示),记 silentInDm', () => {
    const r = buildTurnReply({ finalText: 'NO_REPLY', narration: [] }, [], 'dm', 'all_segments')
    expect(r.reply).toMatchObject({ text: '', silent: true, segments: [] })
    expect(r.silentInDm).toBe(true)
  })
  it('all_segments:有话照发时附件也带上', () => {
    const r = buildTurnReply({ finalText: '图在这', narration: [] }, [{ kind: 'file', path: '/a.png' }], 'dm', 'all_segments')
    expect(r.reply.attachments).toEqual([{ kind: 'file', path: '/a.png' }])
  })
  it('all_segments:中间一段 NO_REPLY 不算决定(最后一段不是)⇒ 不静默、不记 silentInDm;空白段丢掉', () => {
    const r = buildTurnReply({ finalText: '结论', narration: ['NO_REPLY', '   '] }, [], 'dm', 'all_segments')
    expect(r).toEqual({ reply: { text: '结论', silent: false, attachments: [], narration: [], segments: ['结论'] }, silentInDm: false, mixed: false })
  })
})
