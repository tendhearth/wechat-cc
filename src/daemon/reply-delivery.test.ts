import { describe, it, expect, vi } from 'vitest'
import { deliverTurnReply, makeReplyDeliveryRuntime, type DeliverDeps, type PendingAttachment } from './reply-delivery'
import type { TurnReply, TurnAttachment } from '../domain/turn-reply'

function harness(over: Partial<DeliverDeps> = {}) {
  const sent: string[] = []
  const logs: string[] = []
  const sleeps: number[] = []
  const deps: DeliverDeps = {
    sendText: vi.fn(async (_c: string, t: string) => { sent.push(t); return { msgId: `m${sent.length}` } }),
    sleep: async (ms) => { sleeps.push(ms) },
    log: (tag, line) => { logs.push(`[${tag}] ${line}`) },
    ...over,
  }
  return { deps, sent, logs, sleeps }
}

const reply = (text: string, over: Partial<TurnReply> = {}): TurnReply => ({ text, silent: false, attachments: [], narration: [], ...over })

function pending(att: TurnAttachment, result: { ok: boolean; error?: string } = { ok: true }, order?: string[]): PendingAttachment {
  return { attachment: att, send: vi.fn(async () => { order?.push(att.kind); return result }) }
}

describe('deliverTurnReply — 微信目标', () => {
  it('按空行分条、条与条之间按 paceMs 停顿、返回 msgIds', async () => {
    const h = harness()
    const r = await deliverTurnReply({ chatId: 'c1', reply: reply('第一条消息的内容在这里\n\n第二条消息的内容在这里'), attachments: [], context: 'dm' }, h.deps)
    expect(h.sent).toEqual(['第一条消息的内容在这里', '第二条消息的内容在这里'])
    expect(h.sleeps).toHaveLength(1)
    expect(r).toMatchObject({ delivery: 'text', target: 'wechat', bubbles: 2, attachmentsSent: 0, failures: [], msgIds: ['m1', 'm2'] })
  })

  it('chatPrefs.split === false ⇒ 一整条', async () => {
    const h = harness({ chatPrefs: () => ({ split: false }) })
    await deliverTurnReply({ chatId: 'c1', reply: reply('第一条消息的内容在这里\n\n第二条消息的内容在这里'), attachments: [], context: 'dm' }, h.deps)
    expect(h.sent).toEqual(['第一条消息的内容在这里\n\n第二条消息的内容在这里'])
  })

  it('旁听收到的是原文(分条之前),只在真的要进微信时', async () => {
    const observe = vi.fn()
    const h = harness({ observe })
    await deliverTurnReply({ chatId: 'c1', reply: reply('第一条消息的内容在这里\n\n第二条消息的内容在这里'), attachments: [], context: 'tick' }, h.deps)
    expect(observe).toHaveBeenCalledTimes(1)
    expect(observe).toHaveBeenCalledWith('c1', '第一条消息的内容在这里\n\n第二条消息的内容在这里')
  })

  it('参与者前缀加在每一条上([名字] 不会在第 2 条丢掉)', async () => {
    const h = harness()
    await deliverTurnReply({ chatId: 'c1', reply: reply('第一条消息的内容在这里\n\n第二条消息的内容在这里'), attachments: [], context: 'parallel', participantLabel: 'Claude' }, h.deps)
    expect(h.sent).toEqual(['[Claude] 第一条消息的内容在这里', '[Claude] 第二条消息的内容在这里'])
  })

  it('/chat(chatroom):一人一条、不分条 —— 多段也只发一条,带前缀(§4.9)', async () => {
    const h = harness()
    await deliverTurnReply({ chatId: 'c1', reply: reply('第一条消息的内容在这里\n\n第二条消息的内容在这里'), attachments: [], context: 'chatroom', participantLabel: 'Claude' }, h.deps)
    expect(h.sent).toEqual(['[Claude] 第一条消息的内容在这里\n\n第二条消息的内容在这里'])
    const g = harness()
    await deliverTurnReply({ chatId: 'c1', reply: reply('甲段内容在这里写着\n\n乙段内容在这里写着', { segments: ['甲段内容在这里写着', '乙段内容在这里写着'] }), attachments: [], context: 'chatroom', participantLabel: 'Qwen' }, g.deps)
    expect(g.sent).toEqual(['[Qwen] 甲段内容在这里写着\n\n乙段内容在这里写着'])
  })

  it('第一条失败就停:剩下的文字和附件都不发,记 REPLY_DELIVERY_FAIL sent=0/2', async () => {
    const att = pending({ kind: 'voice', text: '晚安' })
    const h = harness({ sendText: vi.fn(async () => ({ msgId: '', error: 'errcode=-14' })) })
    const r = await deliverTurnReply({ chatId: 'c1', reply: reply('第一条消息的内容在这里\n\n第二条消息的内容在这里'), attachments: [att], context: 'dm' }, h.deps)
    expect(h.deps.sendText).toHaveBeenCalledTimes(1)
    expect(att.send).not.toHaveBeenCalled()
    expect(r.failures).toEqual(['errcode=-14'])
    expect(r.bubbles).toBe(0)
    expect(h.logs.some(l => l.startsWith('[REPLY_DELIVERY_FAIL]') && l.includes('sent=0/2'))).toBe(true)
  })

  it('sendText 抛异常 ⇒ 同样当失败,不往外抛(绝不因为送达失败再调模型)', async () => {
    const h = harness({ sendText: vi.fn(async () => { throw new Error('boom') }) })
    const r = await deliverTurnReply({ chatId: 'c1', reply: reply('一句话就够了这里'), attachments: [], context: 'dm' }, h.deps)
    expect(r.failures).toEqual(['boom'])
    expect(r.delivery).toBe('empty')
  })

  it('附件在文字之后、按调用顺序发', async () => {
    const order: string[] = []
    const h = harness({ sendText: vi.fn(async () => { order.push('text'); return { msgId: 'm' } }) })
    const r = await deliverTurnReply({
      chatId: 'c1', reply: reply('恭喜你上线啦太棒了'), context: 'dm',
      attachments: [pending({ kind: 'sticker', ref: { tag: '庆祝' } }, { ok: true }, order), pending({ kind: 'file', path: '/tmp/a.pdf' }, { ok: true }, order)],
    }, h.deps)
    expect(order).toEqual(['text', 'sticker', 'file'])
    expect(r.attachmentsSent).toBe(2)
  })

  it('只有语音、没有文字 ⇒ 只发语音(已定 ⑤)', async () => {
    const v = pending({ kind: 'voice', text: '晚安,好梦' })
    const h = harness()
    const r = await deliverTurnReply({ chatId: 'c1', reply: reply(''), attachments: [v], context: 'dm' }, h.deps)
    expect(h.sent).toEqual([])
    expect(v.send).toHaveBeenCalledTimes(1)
    expect(r.delivery).toBe('attachments_only')
  })

  it('文字与语音内容一样(去标点空白)⇒ 只发语音', async () => {
    const v = pending({ kind: 'voice', text: '晚安,好梦。' })
    const h = harness()
    await deliverTurnReply({ chatId: 'c1', reply: reply('晚安 好梦'), attachments: [v], context: 'dm' }, h.deps)
    expect(h.sent).toEqual([])
    expect(v.send).toHaveBeenCalled()
  })

  it('文字与语音不同 ⇒ 先文字后语音', async () => {
    const order: string[] = []
    const v = pending({ kind: 'voice', text: '晚安' }, { ok: true }, order)
    const h = harness({ sendText: vi.fn(async () => { order.push('text'); return { msgId: 'm' } }) })
    await deliverTurnReply({ chatId: 'c1', reply: reply('今天辛苦了,早点休息'), attachments: [v], context: 'dm' }, h.deps)
    expect(order).toEqual(['text', 'voice'])
  })

  it('语音合成 / 发送失败 ⇒ daemon 自己把这段话按文字发(不要模型兜底)', async () => {
    const v = pending({ kind: 'voice', text: '晚安,好梦' }, { ok: false, error: 'not_configured' })
    const h = harness()
    const r = await deliverTurnReply({ chatId: 'c1', reply: reply(''), attachments: [v], context: 'dm' }, h.deps)
    expect(h.sent).toEqual(['晚安,好梦'])
    expect(r.delivery).toBe('text')
    expect(h.logs.some(l => l.startsWith('[REPLY_VOICE_FALLBACK]'))).toBe(true)
  })

  it('静默 + 附件:NO_REPLY 只压文字,附件照发', async () => {
    const s = pending({ kind: 'sticker', ref: { tag: '抱抱' } })
    const h = harness()
    const r = await deliverTurnReply({ chatId: 'c1', reply: reply('', { silent: true }), attachments: [s], context: 'tick' }, h.deps)
    expect(h.sent).toEqual([])
    expect(s.send).toHaveBeenCalled()
    expect(r.delivery).toBe('attachments_only')
  })

  it('静默、没附件 ⇒ delivery=silent,什么都不发', async () => {
    const h = harness()
    const r = await deliverTurnReply({ chatId: 'c1', reply: reply('', { silent: true }), attachments: [], context: 'tick' }, h.deps)
    expect(h.sent).toEqual([])
    expect(r.delivery).toBe('silent')
  })

  it('空文字、没附件、不是静默 ⇒ empty', async () => {
    const h = harness()
    expect((await deliverTurnReply({ chatId: 'c1', reply: reply(''), attachments: [], context: 'dm' }, h.deps)).delivery).toBe('empty')
  })

  it('本轮 message 工具已经把同样的话发给主人了 ⇒ 最后的话不再重复交付(REPLY_DEDUPED)', async () => {
    const h = harness()
    const r = await deliverTurnReply({ chatId: 'c1', reply: reply('会议改到明天下午三点了'), attachments: [], context: 'dm', messagedOwner: ['会议改到明天下午三点了。'] }, h.deps)
    expect(h.sent).toEqual([])
    expect(r.deduped).toBe(true)
    expect(h.logs.some(l => l.startsWith('[REPLY_DEDUPED]'))).toBe(true)
  })
})

describe('deliverTurnReply — app 接收器(桌面 / 手机这一轮)', () => {
  it('接收器拿到整个 TurnReply(文字 + 附件 + 旁白),一个字都不进微信', async () => {
    const captured: TurnReply[] = []
    const v = pending({ kind: 'voice', text: '晚安' })
    const h = harness({ sink: { captureReply: (_c, r) => { captured.push(r); return true } } })
    const rp = reply('今天辛苦了', { narration: ['我看看日程'], attachments: [v.attachment] })
    const r = await deliverTurnReply({ chatId: 'c1', reply: rp, attachments: [v], context: 'dm' }, h.deps)
    expect(captured).toEqual([rp])
    expect(h.sent).toEqual([])
    expect(v.send).not.toHaveBeenCalled() // 修 §1.2 ④:语音 / 表情不再漏到微信
    expect(r).toMatchObject({ target: 'sink', delivery: 'text', bubbles: 1 })
  })

  it('没开接收器 ⇒ 走微信', async () => {
    const h = harness({ sink: { captureReply: () => false } })
    await deliverTurnReply({ chatId: 'c1', reply: reply('一句话就够了这里'), attachments: [], context: 'dm' }, h.deps)
    expect(h.sent).toEqual(['一句话就够了这里'])
  })
})

describe('makeReplyDeliveryRuntime — 一轮的句柄', () => {
  it('daemon:begin 之后 attach 的附件跟着这一轮交付;没开轮 ⇒ attach 返回 false', async () => {
    const h = harness()
    const rt = makeReplyDeliveryRuntime(h.deps)
    expect(rt.attach('c1', pending({ kind: 'sticker', ref: { tag: 'x' } }))).toBe(false)
    const handle = rt.begin('c1', { context: 'dm', providerId: 'openai' })
    const s = pending({ kind: 'sticker', ref: { tag: '庆祝' } })
    expect(rt.attach('c1', s)).toBe(true)
    const r = await handle.deliver({ finalText: '恭喜恭喜上线成功', narration: [] })
    expect(h.sent).toEqual(['恭喜恭喜上线成功'])
    expect(s.send).toHaveBeenCalled()
    expect(r.attachmentsSent).toBe(1)
    expect(rt.attach('c1', s)).toBe(false) // 交付完就关了
  })

  it('/both、/chat 两位共用一轮时,同一个附件只发一次;一位放弃不丢另一位的附件(2026-10-10)', async () => {
    const h = harness()
    const rt = makeReplyDeliveryRuntime(h.deps)
    const claude = rt.begin('c1', { context: 'dm', providerId: 'claude' })
    const codex = rt.begin('c1', { context: 'dm', providerId: 'codex' })
    const s = pending({ kind: 'sticker', ref: { tag: '开心' } })
    rt.attach('c1', s)
    await claude.deliver({ finalText: 'Claude 的回答在这里', narration: [] })
    const r = await codex.deliver({ finalText: 'Codex 的回答在这里', narration: [] })
    expect(s.send).toHaveBeenCalledTimes(1)
    expect(r.attachmentsSent).toBe(0)
    const a = rt.begin('c2', { context: 'dm', providerId: 'claude' })
    const b = rt.begin('c2', { context: 'dm', providerId: 'codex' })
    const v = pending({ kind: 'sticker', ref: { tag: '好的' } })
    rt.attach('c2', v)
    a.abandon('error')
    await b.deliver({ finalText: 'Codex 接着说完', narration: [] })
    expect(v.send).toHaveBeenCalledTimes(1)
  })

  it('turnChatFor:共享令牌按「这家 provider 此刻在跑的轮」认聊天(none / bound / ambiguous;交付或放弃后解绑)', async () => {
    const h = harness()
    const rt = makeReplyDeliveryRuntime(h.deps)
    expect(rt.turnChatFor('agy')).toEqual({ kind: 'none' })
    const a = rt.begin('c1', { context: 'dm', providerId: 'agy' })
    const other = rt.begin('c9', { context: 'dm', providerId: 'openai' })
    expect(rt.turnChatFor('agy')).toEqual({ kind: 'bound', chatId: 'c1' }) // 别家的轮不相干
    const b = rt.begin('c2', { context: 'tick', providerId: 'agy' })
    expect(rt.turnChatFor('agy')).toEqual({ kind: 'ambiguous', count: 2 })
    await b.deliver({ finalText: 'NO_REPLY', narration: [] })
    expect(rt.turnChatFor('agy')).toEqual({ kind: 'bound', chatId: 'c1' })
    a.abandon('error')
    a.abandon('again') // 幂等:不会把计数减成负的
    expect(rt.turnChatFor('agy')).toEqual({ kind: 'none' })
    other.abandon('x')
  })

  it('私聊里 NO_REPLY ⇒ 不显示、记 REPLY_SILENT_IN_DM', async () => {
    const h = harness()
    const rt = makeReplyDeliveryRuntime(h.deps)
    const r = await rt.begin('c1', { context: 'dm', providerId: 'openai' }).deliver({ finalText: 'NO_REPLY', narration: [] })
    expect(h.sent).toEqual([])
    expect(r.delivery).toBe('silent')
    expect(h.logs.some(l => l.startsWith('[REPLY_SILENT_IN_DM]'))).toBe(true)
  })

  it('推送里 NO_REPLY ⇒ REPLY_SILENT kind=tick,令牌一次都不外发', async () => {
    const h = harness()
    const rt = makeReplyDeliveryRuntime(h.deps)
    await rt.begin('c1', { context: 'tick', providerId: 'openai' }).deliver({ finalText: 'NO_REPLY', narration: ['议程过期了'] })
    expect(h.sent).toEqual([])
    expect(h.logs.some(l => l.startsWith('[REPLY_SILENT]') && l.includes('kind=tick'))).toBe(true)
  })

  it('混合令牌行 ⇒ 剥掉、其余照发、记 NO_REPLY_MIXED', async () => {
    const h = harness()
    const rt = makeReplyDeliveryRuntime(h.deps)
    await rt.begin('c1', { context: 'dm', providerId: 'openai' }).deliver({ finalText: '好的收到啦,明天见\nNO_REPLY', narration: [] })
    expect(h.sent).toEqual(['好的收到啦,明天见'])
    expect(h.sent.join('')).not.toContain('NO_REPLY')
    expect(h.logs.some(l => l.startsWith('[NO_REPLY_MIXED]'))).toBe(true)
  })

  it('旁白不进微信', async () => {
    const h = harness()
    const rt = makeReplyDeliveryRuntime(h.deps)
    await rt.begin('c1', { context: 'dm', providerId: 'openai' }).deliver({ finalText: '查到了,是 42', narration: ['让我查一下'] })
    expect(h.sent).toEqual(['查到了,是 42'])
  })

  it('abandon ⇒ 附件丢弃不发,登记口关闭', async () => {
    const h = harness()
    const rt = makeReplyDeliveryRuntime(h.deps)
    const handle = rt.begin('c1', { context: 'dm', providerId: 'openai' })
    const s = pending({ kind: 'sticker', ref: { tag: 'x' } })
    rt.attach('c1', s)
    handle.abandon('turn_timeout')
    expect(s.send).not.toHaveBeenCalled()
    expect(rt.attach('c1', s)).toBe(false)
  })

  it('progress:微信这一轮发一句;app 这一轮(接收器开着)不进微信', async () => {
    const h = harness()
    let sinkOpen = false
    const rt = makeReplyDeliveryRuntime({ ...h.deps, isSinkOpen: () => sinkOpen })
    const handle = rt.begin('c1', { context: 'dm', providerId: 'openai' })
    await handle.progress('还在查,有点久')
    expect(h.sent).toEqual(['还在查,有点久'])
    sinkOpen = true
    await handle.progress('又一句')
    expect(h.sent).toEqual(['还在查,有点久'])
  })

  it('message 记账 → 交付去重', async () => {
    const h = harness()
    const rt = makeReplyDeliveryRuntime(h.deps)
    const handle = rt.begin('c1', { context: 'dm', providerId: 'openai' })
    rt.noteMessage('c1', { toOwner: true, text: '会议改到明天下午三点了' })
    const r = await handle.deliver({ finalText: '会议改到明天下午三点了', narration: [] })
    expect(r.deduped).toBe(true)
    expect(h.sent).toEqual([])
  })

})

describe('deliverTurnReply — 聊天型模型的多段(每段按 ④ 各自分条)', () => {
  it('segments 依次交付,每段各自分条;旁听拿到的是拼起来的原文', async () => {
    const observe = vi.fn()
    const h = harness({ observe })
    const r = await deliverTurnReply({ chatId: 'c1', reply: reply('第一段的意思在这里\n\n第二段 A 的意思在这里\n\n第二段 B 的意思在这里', { segments: ['第一段的意思在这里', '第二段 A 的意思在这里\n\n第二段 B 的意思在这里'] }), attachments: [], context: 'dm' }, h.deps)
    expect(h.sent).toEqual(['第一段的意思在这里', '第二段 A 的意思在这里', '第二段 B 的意思在这里'])
    expect(r.bubbles).toBe(3)
    expect(observe).toHaveBeenCalledTimes(1)
  })

  it('句柄:begin 时声明 textStrategy=all_segments ⇒ 工具前说的话也送达', async () => {
    const h = harness()
    const rt = makeReplyDeliveryRuntime(h.deps)
    await rt.begin('c1', { context: 'dm', providerId: 'openai', textStrategy: 'all_segments' }).deliver({ finalText: '第三条:早点睡觉吧', narration: ['第一条:出门走走晒太阳', '第二条:做一顿好吃的'] })
    expect(h.sent).toEqual(['第一条:出门走走晒太阳', '第二条:做一顿好吃的', '第三条:早点睡觉吧'])
  })
})

// 伙伴主动找你(2026-10-18):一轮可以另有出口(微信不通时落到 App);出口说只收文字 ⇒ 附件不发、语音改发同样的字。
describe('makeReplyDeliveryRuntime — 这一轮另有出口(outbound)', () => {
  it('文字与进度都走 outbound,不碰运行时自己的 sendText', async () => {
    const h = harness()
    const rt = makeReplyDeliveryRuntime(h.deps)
    const via: string[] = []
    const outbound = { sendText: vi.fn(async (_c: string, t: string) => { via.push(t); return { msgId: 'app:1' } }) }
    const handle = rt.begin('c1', { context: 'tick', providerId: 'claude', outbound })
    await handle.progress('我去搜一下')
    const r = await handle.deliver({ finalText: '前两天那个面试怎么样了', narration: [] })
    expect(h.sent).toEqual([])
    expect(via).toEqual(['我去搜一下', '前两天那个面试怎么样了'])
    expect(r).toMatchObject({ delivery: 'text', bubbles: 1, msgIds: ['app:1'] })
  })

  it('textOnly ⇒ 表情 / 文件不发也不去碰微信;语音改发同样的字', async () => {
    const h = harness()
    const rt = makeReplyDeliveryRuntime(h.deps)
    const via: string[] = []
    const outbound = { sendText: async (_c: string, t: string) => { via.push(t); return { msgId: 'app' } }, textOnly: () => true }
    const handle = rt.begin('c1', { context: 'tick', providerId: 'claude', outbound })
    const sticker = pending({ kind: 'sticker', ref: { tag: '开心' } })
    const voice = pending({ kind: 'voice', text: '晚安呀' })
    rt.attach('c1', sticker)
    rt.attach('c1', voice)
    const r = await handle.deliver({ finalText: '今天辛苦了,早点休息', narration: [] })
    expect(sticker.send).not.toHaveBeenCalled()
    expect(voice.send).not.toHaveBeenCalled()
    expect(via).toEqual(['今天辛苦了,早点休息', '晚安呀'])
    expect(r.attachmentsSent).toBe(0)
    expect(h.logs.some(l => l.includes('REPLY_ATTACHMENT_SKIPPED') && l.includes('sticker'))).toBe(true)
  })

  it('没有 outbound ⇒ 照旧走运行时自己的 sendText', async () => {
    const h = harness()
    const rt = makeReplyDeliveryRuntime(h.deps)
    await rt.begin('c1', { context: 'tick', providerId: 'claude' }).deliver({ finalText: '在忙吗今天', narration: [] })
    expect(h.sent).toEqual(['在忙吗今天'])
  })
})

// 手机伙伴第 2 步(2026-10-18):出口收得下附件 ⇒ 表情 / 文件 / 语音交给它记进 App 对话页(语音保留成语音);
// 收不下(回 false / 抛错)⇒ 退回第 1 步:语音改发字、别的不发。
describe('makeReplyDeliveryRuntime — textOnly 出口收附件(sendAttachment)', () => {
  it('收下 ⇒ 不碰微信、语音不改发字、记成已送附件', async () => {
    const h = harness()
    const rt = makeReplyDeliveryRuntime(h.deps)
    const via: string[] = []
    const took: string[] = []
    const outbound = {
      sendText: async (_c: string, t: string) => { via.push(t); return { msgId: 'app' } },
      textOnly: () => true,
      sendAttachment: vi.fn(async (_c: string, a: { kind: string }) => { took.push(a.kind); return true }),
    }
    const handle = rt.begin('c1', { context: 'tick', providerId: 'claude', outbound })
    const sticker = pending({ kind: 'sticker', ref: { tag: '开心' } })
    const voice = pending({ kind: 'voice', text: '晚安呀' })
    rt.attach('c1', sticker)
    rt.attach('c1', voice)
    const r = await handle.deliver({ finalText: '今天辛苦了,早点休息', narration: [] })
    expect(sticker.send).not.toHaveBeenCalled()
    expect(voice.send).not.toHaveBeenCalled()
    expect(h.sent).toEqual([])
    expect(via).toEqual(['今天辛苦了,早点休息'])
    expect(took).toEqual(['sticker', 'voice'])
    expect(r.attachmentsSent).toBe(2)
  })

  it('收不下(false / 抛错)⇒ 退回第 1 步:语音改发同样的字,表情跳过', async () => {
    const h = harness()
    const rt = makeReplyDeliveryRuntime(h.deps)
    const via: string[] = []
    const outbound = {
      sendText: async (_c: string, t: string) => { via.push(t); return { msgId: 'app' } },
      textOnly: () => true,
      sendAttachment: vi.fn(async (_c: string, a: { kind: string }) => { if (a.kind === 'voice') throw new Error('db'); return false }),
    }
    const handle = rt.begin('c1', { context: 'tick', providerId: 'claude', outbound })
    rt.attach('c1', pending({ kind: 'sticker', ref: { tag: '开心' } }))
    rt.attach('c1', pending({ kind: 'voice', text: '晚安呀' }))
    const r = await handle.deliver({ finalText: '今天辛苦了', narration: [] })
    expect(via).toEqual(['今天辛苦了', '晚安呀'])
    expect(r.attachmentsSent).toBe(0)
    expect(h.logs.some(l => l.includes('REPLY_ATTACHMENT_SKIPPED') && l.includes('outbound threw'))).toBe(true)
  })

  it('不是 textOnly(落在微信)⇒ 附件照常发微信,不交给出口', async () => {
    const h = harness()
    const rt = makeReplyDeliveryRuntime(h.deps)
    const outbound = { sendText: async () => ({ msgId: 'w' }), textOnly: () => false, sendAttachment: vi.fn(async () => true) }
    const handle = rt.begin('c1', { context: 'tick', providerId: 'claude', outbound })
    const sticker = pending({ kind: 'sticker', ref: { tag: '开心' } })
    rt.attach('c1', sticker)
    await handle.deliver({ finalText: '嗨', narration: [] })
    expect(sticker.send).toHaveBeenCalledOnce()
    expect(outbound.sendAttachment).not.toHaveBeenCalled()
  })
})

describe('放行规则的提醒(2026-10-25:主人自己的对话里规则替主人放了一次)', () => {
  const notice = (key: string, rule = key, target = 'memory_delete') => ({ key, rule, target })
  it('最后单独一条、不加发言人前缀、不算进 bubbles;同一条规则一轮一行,不同规则各一行', async () => {
    const sent: string[] = []
    const rt = makeReplyDeliveryRuntime({ sendText: async (_c, t) => { sent.push(t); return { msgId: String(sent.length) } }, sleep: async () => {}, log: () => {} })
    const h = rt.begin('c', { context: 'parallel', providerId: 'claude', participantLabel: 'Claude' })
    expect(rt.noteRuleAllow('c', notice('a', '甲'))).toBeTypeOf('function')
    expect(rt.noteRuleAllow('c', notice('a', '甲'))).toBeTypeOf('function')
    expect(rt.noteRuleAllow('c', notice('b', '乙', 'daemon_restart'))).toBeTypeOf('function')
    rt.noteRuleAllow('c', notice('x', '撤了'))!()
    const r = await h.deliver({ finalText: '好', narration: [] })
    expect(sent).toEqual(['[Claude] 好', '按规则「甲」放行了 memory_delete(这一轮共 2 次)\n按规则「乙」放行了 daemon_restart'])
    expect(r.bubbles).toBe(1)
  })
  it('没有开着的轮 ⇒ 登记不上(调用方就不放)', () => {
    const rt = makeReplyDeliveryRuntime({ sendText: async () => ({ msgId: '1' }), log: () => {} })
    expect(rt.noteRuleAllow('c', notice('a'))).toBeNull()
  })
  it('模型写了 NO_REPLY / 什么都没说:提醒照样发', async () => {
    const sent: string[] = []
    const rt = makeReplyDeliveryRuntime({ sendText: async (_c, t) => { sent.push(t); return { msgId: '1' } }, sleep: async () => {}, log: () => {} })
    const h = rt.begin('c', { context: 'tick', providerId: 'claude' })
    rt.noteRuleAllow('c', notice('a', '甲'))
    const r = await h.deliver({ finalText: 'NO_REPLY', narration: [] })
    expect(sent).toEqual(['按规则「甲」放行了 memory_delete'])
    expect(r.delivery).toBe('silent')
  })
  it('app 接收器这一轮:提醒接在文字末尾一起交过去,不进微信', async () => {
    const captured: TurnReply[] = []
    const sendText = vi.fn(async () => ({ msgId: '1' }))
    const rt = makeReplyDeliveryRuntime({ sendText, sink: { captureReply: (_c, r) => { captured.push(r); return true } }, log: () => {} })
    const h = rt.begin('c', { context: 'dm', providerId: 'claude' })
    rt.noteRuleAllow('c', notice('a', '甲'))
    await h.deliver({ finalText: '好了', narration: [] })
    expect(captured[0]!.text).toBe('好了\n\n按规则「甲」放行了 memory_delete')
    expect(sendText).not.toHaveBeenCalled()
  })
})

// 2026-10 变异测试第二轮:发什么、去不去重、失败怎么回落、一轮的句柄怎么收口 —— 基线里这些分支要么没跑到,要么改了不红。
describe('deliverTurnReply — 与 message 工具去重(变异测试第二轮)', () => {
  it.each([
    // [message 工具发过的, 最后的话, 去不去重]
    ['我到了，在门口等你', '我到了在门口等你', true],          // 只差标点空白
    ['我到了，在门口等你。顺便带了伞', '在门口等你', true],     // 说过的话包含最后的话
    ['到了', '我到了门口', true],                               // 最后的话包含说过的话
    ['你好', '再见', false],
    ['。。。', '好的收到', false],                              // 说过的只有标点:去掉以后是空,什么都「包含」空串,不能算说过
  ] as const)('%s / %s ⇒ %s', async (said, text, deduped) => {
    const h = harness()
    const r = await deliverTurnReply({ chatId: 'c', reply: reply(text), attachments: [], context: 'dm', messagedOwner: [said] }, h.deps)
    expect(h.sent).toEqual(deduped ? [] : [text])
    expect(r.deduped === true).toBe(deduped)
  })
  it('句柄:message 只认发给主人聊天的那笔', async () => {
    const h = harness()
    const rt = makeReplyDeliveryRuntime(h.deps)
    const t = rt.begin('c', { context: 'dm', providerId: 'claude' })
    rt.noteMessage('c', { toOwner: false, text: '同一句话' })
    await t.deliver({ finalText: '同一句话', narration: [] })
    expect(h.sent).toEqual(['同一句话'])
  })
})

describe('deliverTurnReply — app 接收器的交付分类(变异测试第二轮)', () => {
  const sink = () => { const got: TurnReply[] = []; return { got, sink: { captureReply: (_c: string, r: TurnReply) => { got.push(r); return true } } } }
  it.each([
    ['有字', reply('好'), { delivery: 'text', bubbles: 1 }],
    ['只有附件', reply('  ', { attachments: [{ kind: 'file', path: '/a' }] }), { delivery: 'attachments_only', bubbles: 0 }],
    ['静默', reply('', { silent: true }), { delivery: 'silent', bubbles: 0 }],
    ['什么都没有', reply(''), { delivery: 'empty', bubbles: 0 }],
  ] as const)('%s', async (_n, r, want) => {
    const s = sink()
    const h = harness({ sink: s.sink })
    expect(await deliverTurnReply({ chatId: 'c', reply: r, attachments: [], context: 'dm' }, h.deps))
      .toEqual({ ...want, target: 'sink', attachmentsSent: 0, failures: [], msgIds: [] })
    expect(h.sent).toEqual([])
  })
  it('提醒:模型静默 / 没说话 ⇒ 接收器只拿到提醒,且不再算静默;多段时提醒成为最后一段(静默的段不交)', async () => {
    const s = sink()
    const h = harness({ sink: s.sink })
    await deliverTurnReply({ chatId: 'c', reply: reply('', { silent: true, segments: ['不该出现'] }), attachments: [], context: 'tick', notices: ['提醒'] }, h.deps)
    expect(s.got[0]).toMatchObject({ text: '提醒', silent: false, segments: ['提醒'] })
    await deliverTurnReply({ chatId: 'c', reply: reply('一\n\n二', { segments: ['一', '二'] }), attachments: [], context: 'dm', notices: ['提醒'] }, h.deps)
    expect(s.got[1]).toMatchObject({ text: '一\n\n二\n\n提醒', segments: ['一', '二', '提醒'] })
    await deliverTurnReply({ chatId: 'c', reply: reply('   '), attachments: [], context: 'dm', notices: ['提醒'] }, h.deps)
    expect(s.got[2]!.text).toBe('提醒')
  })
})

describe('deliverTurnReply — 节奏与失败(变异测试第二轮)', () => {
  it('条与条之间停一下;最后一条之后有附件也停一下;只有一条、没附件 ⇒ 不停', async () => {
    const one = harness()
    await deliverTurnReply({ chatId: 'c', reply: reply('只有一条'), attachments: [], context: 'dm' }, one.deps)
    expect(one.sleeps).toHaveLength(0)
    const withAtt = harness()
    await deliverTurnReply({ chatId: 'c', reply: reply('只有一条'), attachments: [pending({ kind: 'sticker', ref: { tag: 'x' } })], context: 'dm' }, withAtt.deps)
    expect(withAtt.sleeps).toHaveLength(1)
  })
  it('非语音附件发送失败 ⇒ 记进 failures(没给原因就记 <kind>_failed),不改发文字', async () => {
    const h = harness()
    const r = await deliverTurnReply({
      chatId: 'c', reply: reply(''), context: 'dm',
      attachments: [pending({ kind: 'file', path: '/a' }, { ok: false }), pending({ kind: 'sticker', ref: { tag: 'x' } }, { ok: false, error: 'too_big' })],
    }, h.deps)
    expect(h.sent).toEqual([])
    expect(r).toMatchObject({ delivery: 'empty', bubbles: 0, attachmentsSent: 0, failures: ['file_failed', 'too_big'] })
  })
  it('附件的 send 抛异常 ⇒ 当失败记下,不往外抛', async () => {
    const h = harness()
    const boom: PendingAttachment = { attachment: { kind: 'file', path: '/a' }, send: async () => { throw new Error('ENOENT') } }
    const r = await deliverTurnReply({ chatId: 'c', reply: reply(''), attachments: [boom], context: 'dm' }, h.deps)
    expect(r.failures).toEqual(['ENOENT'])
  })
  it('只收文字的出口、没有 sendAttachment:语音改发同样的字,算一条文字气泡', async () => {
    const h = harness({ textOnly: () => true })
    const r = await deliverTurnReply({ chatId: 'c', reply: reply(''), attachments: [pending({ kind: 'voice', text: '晚安' })], context: 'dm' }, h.deps)
    expect(h.sent).toEqual(['晚安'])
    expect(r).toMatchObject({ delivery: 'text', bubbles: 1, attachmentsSent: 0 })
  })
  it('提醒那一条发失败(回 error / 抛错)⇒ 记进 failures,不进 msgIds;模型的话照常算', async () => {
    let n = 0
    const h = harness({ sendText: async (_c, t) => { n++; if (t.startsWith('按规则')) return { msgId: '', error: 'ret=-2' }; return { msgId: `m${n}` } } })
    const r = await deliverTurnReply({ chatId: 'c', reply: reply('好'), attachments: [], context: 'dm', notices: ['按规则「甲」放行了 x'] }, h.deps)
    expect(r).toMatchObject({ delivery: 'text', bubbles: 1, failures: ['ret=-2'], msgIds: ['m1'] })
    const t = harness({ sendText: async (_c, txt) => { if (txt.startsWith('按规则')) throw new Error('socket closed'); return { msgId: 'm1' } } })
    const r2 = await deliverTurnReply({ chatId: 'c', reply: reply('好'), attachments: [], context: 'dm', notices: ['按规则「甲」放行了 x'] }, t.deps)
    expect(r2).toMatchObject({ failures: ['socket closed'], msgIds: ['m1'] })
  })
})

describe('makeReplyDeliveryRuntime — 句柄收口(变异测试第二轮)', () => {
  const notice = (key: string) => ({ key, rule: key, target: 'memory_delete' })
  it('两位共用一轮:先交付的那位走了,登记口还开着;两位都走了才关', async () => {
    const h = harness()
    const rt = makeReplyDeliveryRuntime(h.deps)
    const a = rt.begin('c', { context: 'parallel', providerId: 'claude' })
    const b = rt.begin('c', { context: 'parallel', providerId: 'codex' })
    expect(rt.hasOpenTurn('c')).toBe(true)
    await a.deliver({ finalText: '甲说完了', narration: [] })
    a.abandon('late') // 交付以后再放弃:幂等,不会把另一位的轮也关掉
    expect(rt.hasOpenTurn('c')).toBe(true)
    expect(rt.attach('c', pending({ kind: 'sticker', ref: { tag: 'x' } }))).toBe(true)
    await b.deliver({ finalText: '乙说完了', narration: [] })
    expect(rt.hasOpenTurn('c')).toBe(false)
  })
  it('交付以后 progress 不再发;空白的 progress 不发', async () => {
    const h = harness()
    const rt = makeReplyDeliveryRuntime(h.deps)
    const t = rt.begin('c', { context: 'dm', providerId: 'claude' })
    await t.progress('   ')
    expect(h.sent).toEqual([])
    await t.deliver({ finalText: '完了', narration: [] })
    await t.progress('还在跑')
    expect(h.sent).toEqual(['完了'])
  })
  it('/both 里提醒只跟第一位交付的走,第二位不重复', async () => {
    const h = harness()
    const rt = makeReplyDeliveryRuntime(h.deps)
    const a = rt.begin('c', { context: 'parallel', providerId: 'claude' })
    const b = rt.begin('c', { context: 'parallel', providerId: 'codex' })
    rt.noteRuleAllow('c', notice('甲'))
    await a.deliver({ finalText: '一', narration: [] })
    await b.deliver({ finalText: '二', narration: [] })
    expect(h.sent).toEqual(['一', '按规则「甲」放行了 memory_delete', '二'])
  })
  it('撤销登记:只撤一次;同一条规则登记两次撤一次 ⇒ 剩一次;全撤了 ⇒ 不发提醒', async () => {
    const h = harness()
    const rt = makeReplyDeliveryRuntime(h.deps)
    const t = rt.begin('c', { context: 'dm', providerId: 'claude' })
    rt.noteRuleAllow('c', notice('甲'))
    const undo = rt.noteRuleAllow('c', notice('甲'))!
    undo(); undo()
    const undoB = rt.noteRuleAllow('c', notice('乙'))!
    undoB()
    undoB()
    await t.deliver({ finalText: '好', narration: [] })
    expect(h.sent).toEqual(['好', '按规则「甲」放行了 memory_delete'])
  })
  it('撤销在交付之后才来(那条已经发走了)⇒ 什么都不做', async () => {
    const h = harness()
    const rt = makeReplyDeliveryRuntime(h.deps)
    const t = rt.begin('c', { context: 'dm', providerId: 'claude' })
    const undo = rt.noteRuleAllow('c', notice('甲'))!
    await t.deliver({ finalText: '好', narration: [] })
    expect(() => undo()).not.toThrow()
  })
})
