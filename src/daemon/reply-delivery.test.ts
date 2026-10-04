import { describe, it, expect, vi } from 'vitest'
import { deliverTurnReply, makeReplyDeliveryRuntime, type DeliverDeps, type PendingAttachment } from './reply-delivery'
import type { TurnReply, TurnAttachment } from '../core/turn-reply'

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
    const handle = rt.begin('c1', { mode: 'daemon', context: 'dm', providerId: 'openai' })
    const s = pending({ kind: 'sticker', ref: { tag: '庆祝' } })
    expect(rt.attach('c1', s)).toBe(true)
    const r = await handle.deliver({ finalText: '恭喜恭喜上线成功', narration: [] })
    expect(h.sent).toEqual(['恭喜恭喜上线成功'])
    expect(s.send).toHaveBeenCalled()
    expect(r.attachmentsSent).toBe(1)
    expect(rt.attach('c1', s)).toBe(false) // 交付完就关了
  })

  it('turnChatFor:共享令牌按「这家 provider 此刻在跑的 daemon 轮」认聊天(none / bound / ambiguous;shadow 不算;交付或放弃后解绑)', async () => {
    const h = harness()
    const rt = makeReplyDeliveryRuntime(h.deps)
    expect(rt.turnChatFor('agy')).toEqual({ kind: 'none' })
    const shadow = rt.begin('c0', { mode: 'shadow', context: 'dm', providerId: 'agy' })
    expect(rt.turnChatFor('agy')).toEqual({ kind: 'none' }) // shadow 轮没有附件工具,不绑定
    const a = rt.begin('c1', { mode: 'daemon', context: 'dm', providerId: 'agy' })
    const other = rt.begin('c9', { mode: 'daemon', context: 'dm', providerId: 'openai' })
    expect(rt.turnChatFor('agy')).toEqual({ kind: 'bound', chatId: 'c1' }) // 别家的轮不相干
    const b = rt.begin('c2', { mode: 'daemon', context: 'tick', providerId: 'agy' })
    expect(rt.turnChatFor('agy')).toEqual({ kind: 'ambiguous', count: 2 })
    await b.deliver({ finalText: 'NO_REPLY', narration: [] })
    expect(rt.turnChatFor('agy')).toEqual({ kind: 'bound', chatId: 'c1' })
    a.abandon('error')
    a.abandon('again') // 幂等:不会把计数减成负的
    expect(rt.turnChatFor('agy')).toEqual({ kind: 'none' })
    shadow.abandon('x'); other.abandon('x')
  })

  it('私聊里 NO_REPLY ⇒ 不显示、记 REPLY_SILENT_IN_DM', async () => {
    const h = harness()
    const rt = makeReplyDeliveryRuntime(h.deps)
    const r = await rt.begin('c1', { mode: 'daemon', context: 'dm', providerId: 'openai' }).deliver({ finalText: 'NO_REPLY', narration: [] })
    expect(h.sent).toEqual([])
    expect(r.delivery).toBe('silent')
    expect(h.logs.some(l => l.startsWith('[REPLY_SILENT_IN_DM]'))).toBe(true)
  })

  it('推送里 NO_REPLY ⇒ REPLY_SILENT kind=tick,令牌一次都不外发', async () => {
    const h = harness()
    const rt = makeReplyDeliveryRuntime(h.deps)
    await rt.begin('c1', { mode: 'daemon', context: 'tick', providerId: 'openai' }).deliver({ finalText: 'NO_REPLY', narration: ['议程过期了'] })
    expect(h.sent).toEqual([])
    expect(h.logs.some(l => l.startsWith('[REPLY_SILENT]') && l.includes('kind=tick'))).toBe(true)
  })

  it('混合令牌行 ⇒ 剥掉、其余照发、记 NO_REPLY_MIXED', async () => {
    const h = harness()
    const rt = makeReplyDeliveryRuntime(h.deps)
    await rt.begin('c1', { mode: 'daemon', context: 'dm', providerId: 'openai' }).deliver({ finalText: '好的收到啦,明天见\nNO_REPLY', narration: [] })
    expect(h.sent).toEqual(['好的收到啦,明天见'])
    expect(h.sent.join('')).not.toContain('NO_REPLY')
    expect(h.logs.some(l => l.startsWith('[NO_REPLY_MIXED]'))).toBe(true)
  })

  it('旁白不进微信', async () => {
    const h = harness()
    const rt = makeReplyDeliveryRuntime(h.deps)
    await rt.begin('c1', { mode: 'daemon', context: 'dm', providerId: 'openai' }).deliver({ finalText: '查到了,是 42', narration: ['让我查一下'] })
    expect(h.sent).toEqual(['查到了,是 42'])
  })

  it('abandon ⇒ 附件丢弃不发,登记口关闭', async () => {
    const h = harness()
    const rt = makeReplyDeliveryRuntime(h.deps)
    const handle = rt.begin('c1', { mode: 'daemon', context: 'dm', providerId: 'openai' })
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
    const handle = rt.begin('c1', { mode: 'daemon', context: 'dm', providerId: 'openai' })
    await handle.progress('还在查,有点久')
    expect(h.sent).toEqual(['还在查,有点久'])
    sinkOpen = true
    await handle.progress('又一句')
    expect(h.sent).toEqual(['还在查,有点久'])
  })

  it('message 记账 → 交付去重', async () => {
    const h = harness()
    const rt = makeReplyDeliveryRuntime(h.deps)
    const handle = rt.begin('c1', { mode: 'daemon', context: 'dm', providerId: 'openai' })
    rt.noteMessage('c1', { toOwner: true, text: '会议改到明天下午三点了' })
    const r = await handle.deliver({ finalText: '会议改到明天下午三点了', narration: [] })
    expect(r.deduped).toBe(true)
    expect(h.sent).toEqual([])
  })

  it('shadow:什么都不发,只把 legacy 实际发出的和新路会发的比一比,记 REPLY_SHADOW', async () => {
    const h = harness()
    const rt = makeReplyDeliveryRuntime(h.deps)
    const handle = rt.begin('c1', { mode: 'shadow', context: 'dm', providerId: 'claude' })
    rt.observeLegacy('c1', '你有两个项目')
    const r = await handle.deliver({ finalText: '你有两个项目', narration: ['我查一下'] })
    expect(h.sent).toEqual([])
    expect(r.shadow).toBe(true)
    const line = h.logs.find(l => l.startsWith('[REPLY_SHADOW]'))!
    expect(line).toContain('match=same')
    expect(line).toContain('legacy_n=1')
    expect(line).toContain('narration=1')
    expect(line).toContain('provider=claude')
  })

  it('shadow:legacy 发了旁白 + 结论,新路只发结论 ⇒ match=contains', async () => {
    const h = harness()
    const rt = makeReplyDeliveryRuntime(h.deps)
    const handle = rt.begin('c1', { mode: 'shadow', context: 'dm', providerId: 'agy' })
    rt.observeLegacy('c1', '已回复用户的问候。')
    rt.observeLegacy('c1', '你好呀')
    await handle.deliver({ finalText: '你好呀', narration: [] })
    expect(h.logs.find(l => l.startsWith('[REPLY_SHADOW]'))).toContain('match=contains')
  })

  it('shadow 的旁听只在开着的轮里记;没开 ⇒ 无操作', () => {
    const h = harness()
    const rt = makeReplyDeliveryRuntime(h.deps)
    expect(() => rt.observeLegacy('c1', 'x')).not.toThrow()
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
    await rt.begin('c1', { mode: 'daemon', context: 'dm', providerId: 'openai', textStrategy: 'all_segments' }).deliver({ finalText: '第三条:早点睡觉吧', narration: ['第一条:出门走走晒太阳', '第二条:做一顿好吃的'] })
    expect(h.sent).toEqual(['第一条:出门走走晒太阳', '第二条:做一顿好吃的', '第三条:早点睡觉吧'])
  })
})
