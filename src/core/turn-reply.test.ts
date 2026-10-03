import { describe, expect, it } from 'vitest'
import type { AgentEvent } from './agent-provider'
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
