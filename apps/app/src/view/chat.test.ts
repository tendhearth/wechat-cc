import { describe, expect, it } from 'vitest'
import { CHAT_TEXT_MAX } from '@wechat-cc/protocol'
import { ACCEPTED_TTL_MS, acceptedSettled, chatBubbles, chatSendOutcome, isOwnerChatMatter, mergeChatPages, olderCursor, rebaseOlder, textAfterSend } from './chat'
import { t } from '../i18n'
import type { ChatMessageT, ChatPageT } from '../backend/types'

const msg = (id: string, at: number, role: 'me' | 'cc' = 'me', text = id, source: ChatMessageT['source'] = 'wechat'): ChatMessageT => ({ id, role, kind: 'text', text, truncated: false, at, source })
const page = (messages: ChatMessageT[], over: Partial<ChatPageT> = {}): ChatPageT => ({ matterId: 'c0ffee01', title: 't', messages, hasMore: false, nextBefore: null, pending: null, failed: null, ...over })

describe('chat 视图', () => {
  it('合并:旧页在前、按时间排、按 id 去重(重拉最新页与旧页重叠)', () => {
    const latest = page([msg('b', 2), msg('c', 3)]), older = [page([msg('a', 1), msg('b', 2)], { nextBefore: 'x', hasMore: true })]
    expect(mergeChatPages(latest, older).map(m => m.id)).toEqual(['a', 'b', 'c'])
    expect(olderCursor(latest, older)).toBe('x')
    expect(olderCursor(page([], { hasMore: true, nextBefore: 'y' }), [])).toBe('y')
    expect(olderCursor(page([], { hasMore: false, nextBefore: null }), [])).toBeNull()
  })
  it('pending ⇒ 我的气泡 + CC 在想', () => {
    const b = chatBubbles([msg('a', 1, 'cc')], { pending: { requestId: 'r', text: '你好', status: 'pending', since: 5 }, failed: null }, null, 5)
    expect(b.slice(-2).map(x => [x.side, x.state, x.text])).toEqual([['me', 'sent', '你好'], ['cc', 'thinking', '']])
  })
  it('failed busy ⇒ 可重试的失败气泡', () => {
    const b = chatBubbles([], { pending: null, failed: { requestId: 'r', text: 'hi', status: 'failed', since: 5, error: 'busy' } }, null, 5)
    expect(b).toEqual([expect.objectContaining({ side: 'me', state: 'failed', failedKind: 'busy', requestId: 'r', text: 'hi' })])
  })
  it('failed 其它原因 ⇒ unavailable;not_configured ⇒ notConfigured', () => {
    const b = chatBubbles([], { pending: null, failed: { requestId: 'r', text: 'hi', status: 'failed', since: 5, error: 'unavailable' } }, null, 5)
    expect(b[0]).toMatchObject({ failedKind: 'unavailable' })
    const c = chatBubbles([], { pending: null, failed: { requestId: 'r', text: 'hi', status: 'failed', since: 5, error: 'not_configured' } }, null, 5)
    expect(c[0]).toMatchObject({ failedKind: 'notConfigured' })
  })
  it('unavailable 的措辞不能说「没送到电脑上」—— 可能已经到了电脑、是那边没办成(终审 I2)', () => {
    for (const lang of ['zh-Hans', 'en'] as const) expect(t(lang, 'chat.failedUnavailable')).not.toBe(lang === 'zh-Hans' ? '没送到电脑上' : 'Didn’t reach your computer')
    expect(t('zh-Hans', 'chat.failedUnavailable')).not.toContain('没送到')
  })
  it('daemon 的 failed 那句其实已经落进对话(超时后才回来)⇒ 不再画失败气泡(终审 I2)', () => {
    const failed = { requestId: 'r', text: '在吗', status: 'failed' as const, since: 1000, error: 'unavailable' as const }
    const b = chatBubbles([msg('x', 1200, 'me', '在吗', 'phone'), msg('y', 700_000, 'cc', '在的')], { pending: null, failed }, null, 800_000)
    expect(b.filter(x => x.state === 'failed')).toEqual([])
    // 没落地 ⇒ 照旧可重试
    expect(chatBubbles([], { pending: null, failed }, null, 800_000).map(x => x.failedKind)).toEqual(['unavailable'])
  })
  it('本机收过回执,daemon 却既没 pending 也没历史(重启丢了)⇒ 可能没送到', () => {
    const acc = { requestId: 'r', text: '在吗', at: 1000 }
    expect(chatBubbles([], { pending: null, failed: null }, acc, 1000).at(-1)).toMatchObject({ state: 'failed', failedKind: 'maybeLost', requestId: 'r' })
    expect(chatBubbles([msg('x', 1200, 'me', '在吗', 'phone')], { pending: null, failed: null }, acc, 1200).filter(x => x.state === 'failed')).toEqual([])
  })
  it('回执对应的还在 pending / 已经 failed ⇒ 不另起「可能没送到」', () => {
    const acc = { requestId: 'r', text: '在吗', at: 1000 }
    expect(chatBubbles([], { pending: { requestId: 'r', text: '在吗', status: 'pending', since: 1000 }, failed: null }, acc, 1000).filter(x => x.failedKind === 'maybeLost')).toEqual([])
    expect(chatBubbles([], { pending: null, failed: { requestId: 'r', text: '在吗', status: 'failed', since: 1000, error: 'busy' } }, acc, 1000).map(x => x.failedKind)).toEqual(['busy'])
  })
  it('过了 ACCEPTED_TTL_MS 还没落地也不悄悄消失 ⇒「没确认送到」,同一个 requestId 可重试(修订 Ruling 5)', () => {
    const acc = { requestId: 'r', text: '在吗', at: 1000 }
    const b = chatBubbles([], { pending: null, failed: null }, acc, 1000 + ACCEPTED_TTL_MS + 1)
    expect(b).toEqual([expect.objectContaining({ side: 'me', state: 'failed', failedKind: 'notConfirmed', requestId: 'r', text: '在吗' })])
  })
  it('正文比较按 trim 后相等', () => {
    const acc = { requestId: 'r', text: '在吗 ', at: 1000 }
    expect(chatBubbles([msg('x', 1000, 'me', ' 在吗', 'phone')], { pending: null, failed: null }, acc, 1000).filter(x => x.state === 'failed')).toEqual([])
  })
  it('落地的我消息被截断过(正好 CHAT_TEXT_MAX 长,原文更长)⇒ 按前缀也算落地', () => {
    const long = 'a'.repeat(CHAT_TEXT_MAX) + 'tail'
    const acc = { requestId: 'r', text: long, at: 1000 }
    const m = { ...msg('x', 1000, 'me', long.slice(0, CHAT_TEXT_MAX), 'phone'), truncated: true }
    expect(chatBubbles([m], { pending: null, failed: null }, acc, 1000).filter(x => x.state === 'failed')).toEqual([])
  })
  it('前缀规则收紧:短的截断消息 / 空正文 / 两条长消息开头相同而第二条丢了 ⇒ 都不算落地', () => {
    const acc = { requestId: 'r', text: 'abcdef', at: 1000 }
    const short = { ...msg('x', 1000, 'me', 'abc', 'phone'), truncated: true }
    expect(acceptedSettled(acc, [short], { pending: null, failed: null })).toBe(false)
    const empty = { ...msg('e', 1000, 'me', '', 'phone'), truncated: true }
    expect(acceptedSettled(acc, [empty], { pending: null, failed: null })).toBe(false)
    const head = 'b'.repeat(CHAT_TEXT_MAX)
    const first = head + ' first', second = head + ' second'
    const landedFirst = { ...msg('f', 1500, 'me', head, 'phone'), truncated: true }
    expect(acceptedSettled({ requestId: 'r1', text: first, at: 1000 }, [landedFirst], { pending: null, failed: null })).toBe(true)
    // 第二条开头一样、几秒后才收下(上一句回完才能说),却丢了:不能拿第一条的截断正文冒充它落地
    expect(acceptedSettled({ requestId: 'r2', text: second, at: 3000 }, [landedFirst], { pending: null, failed: null })).toBe(false)
  })
  it('acceptedSettled(修订 Ruling 5):只有看到落地才清;pending / failed / 超时都不清(超时变成「没确认送到」,由重试或「不管它」清)', () => {
    const acc = { requestId: 'r', text: '在吗', at: 1000 }
    const none = { pending: null, failed: null }
    expect(acceptedSettled(null, [], none)).toBe(true)
    expect(acceptedSettled(acc, [], none)).toBe(false)
    expect(acceptedSettled(acc, [msg('x', 1100, 'me', '在吗', 'phone')], none)).toBe(true)
    expect(acceptedSettled(acc, [msg('x', 1100, 'me', '在吗', 'wechat')], none)).toBe(false)
    expect(acceptedSettled(acc, [], { pending: { requestId: 'r', text: '在吗', status: 'pending', since: 1000 }, failed: null })).toBe(false)
  })
  it('只有主人那条对话才算主人对话(Ruling 9)', () => {
    expect(isOwnerChatMatter({ id: 'c0ffee01', kind: 'chat' }, 'c0ffee01')).toBe(true)
    expect(isOwnerChatMatter({ id: 'guest', kind: 'chat' }, 'c0ffee01')).toBe(false)
    expect(isOwnerChatMatter({ id: 'c0ffee01', kind: 'task' }, 'c0ffee01')).toBe(false)
    expect(isOwnerChatMatter({ id: 'c0ffee01', kind: 'chat' }, null)).toBe(false)
  })
  it('发送结果 ⇒ 页内提示种类', () => {
    expect(chatSendOutcome('ok')).toBe('ok')
    expect(chatSendOutcome('busy')).toBe('busy')
    expect(chatSendOutcome({ error: 'busy' })).toBe('ccBusy')
    expect(chatSendOutcome({ error: 'uncertain' })).toBe('uncertain')
    expect(chatSendOutcome({ error: 'revoked' })).toBe('revoked')
    expect(chatSendOutcome({ error: 'offline' })).toBe('failed')
    expect(chatSendOutcome({ error: 'unavailable' })).toBe('failed')
  })
  it('电脑答了、但没接下 ⇒ refused(中性的一句),不说「没有送到」', () => {
    for (const error of ['unknown', 'invalid', 'not_found', 'quota', 'session_busy', 'provider_missing']) {
      expect(chatSendOutcome({ error }), error).toBe('refused')
    }
  })
  it('先发的那句没确认、又说了一句 ⇒ 两个本机回执各自成气泡,前一句不会被后一句顶掉', () => {
    const a = { requestId: 'a', text: '第一句', at: 1000 }, b = { requestId: 'b', text: '第二句', at: 5000 }
    const out = chatBubbles([], { pending: { requestId: 'b', text: '第二句', status: 'pending', since: 5000 }, failed: null }, [a, b], 5000)
    // 按时间排:前一句(早)在后一句的 pending 之前(Task 11 b)
    expect(out.map(x => [x.key, x.state, x.failedKind])).toEqual([['l:a', 'failed', 'maybeLost'], ['p:b', 'sent', undefined], ['t:b', 'thinking', undefined]])
  })
  it('丢了的 / 失败的气泡按时间插回对话里,不堆在最后(Task 11 b)', () => {
    const lost = { requestId: 'a', text: '第一句', at: 1000 }
    const out = chatBubbles([msg('w1', 500, 'cc', '早'), msg('w2', 2000, 'cc', '晚')], { pending: null, failed: null }, [lost], 3000)
    expect(out.map(x => x.key)).toEqual(['w1', 'l:a', 'w2'])
    const failed = { requestId: 'f', text: '失败', status: 'failed' as const, since: 1500, error: 'busy' as const }
    expect(chatBubbles([msg('w1', 500, 'cc'), msg('w2', 2000, 'cc')], { pending: null, failed }, null, 3000).map(x => x.key)).toEqual(['w1', 'f:f', 'w2'])
  })
  it('一样的短句(「好」)前一分钟说过一次 ⇒ 不能冒充这一句落地;只留 1 秒钟取整余量(Task 11 d)', () => {
    const acc = { requestId: 'r', text: '好', at: 100_000 }
    const none = { pending: null, failed: null }
    expect(acceptedSettled(acc, [msg('old', 100_000 - 30_000, 'me', '好', 'phone')], none)).toBe(false)
    expect(acceptedSettled(acc, [msg('now', 100_000 - 500, 'me', '好', 'phone')], none)).toBe(true)
    expect(acceptedSettled(acc, [msg('now', 100_000 + 2_000, 'me', '好', 'phone')], none)).toBe(true)
  })
  it('发送成功只清掉发出去的那段,发送途中新打的字留着(Task 11 a)', () => {
    expect(textAfterSend('在吗', '在吗')).toBe('')
    // 接着往后打 ⇒ 只去掉已发出的前缀(连带它与新字之间的空白)
    expect(textAfterSend('在吗 顺便问下', '在吗')).toBe('顺便问下')
    expect(textAfterSend('在吗\n还有', '在吗')).toBe('还有')
    // 改了发出去那句本身(不再以它开头)⇒ 原样留着,不猜
    expect(textAfterSend('在不在', '在吗')).toBe('在不在')
    expect(textAfterSend('', '在吗')).toBe('')
  })
  describe('rebaseOlder:最新页刷新后旧页还接得上吗(Task 11 c)', () => {
    const p1 = page([msg('m3', 3), msg('m4', 4)], { hasMore: true, nextBefore: 't3' })
    const old = [page([msg('m1', 1), msg('m2', 2)], { hasMore: false, nextBefore: null })]
    it('来了一条新的:新最新页与上一份最新页重叠 ⇒ 上一份并进旧页,不在边界上漏掉 m3', () => {
      const p2 = page([msg('m4', 4), msg('m5', 5)], { hasMore: true, nextBefore: 't4' })
      const next = rebaseOlder(p1, p2, old)
      expect(mergeChatPages(p2, next).map(m => m.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5'])
      expect(olderCursor(p2, next)).toBeNull()   // 最旧那页的游标不变
    })
    it('来了一大批(一页都盖不住)⇒ 旧页清掉,从新最新页重新往上翻,不留洞', () => {
      const p2 = page([msg('m9', 9), msg('m10', 10)], { hasMore: true, nextBefore: 't9' })
      expect(rebaseOlder(p1, p2, old)).toEqual([])
      expect(olderCursor(p2, [])).toBe('t9')
    })
    it('没翻过旧页 / 同一页 ⇒ 原样', () => {
      expect(rebaseOlder(p1, page([msg('m9', 9)], { hasMore: true, nextBefore: 't9' }), [])).toEqual([])
      expect(rebaseOlder(p1, p1, old)).toBe(old)
      expect(rebaseOlder(undefined, p1, old)).toBe(old)
    })
  })
})
