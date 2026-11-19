import { describe, expect, it, vi } from 'vitest'
import { collectOwnerReply, OWNER_REPLY_REMINDER } from './collect-owner-reply'
import type { TurnSummary } from '../ports/agent-provider'

const summary = (finalText: string, narration: string[] = []): TurnSummary =>
  ({ assistantText: [...narration, finalText], finalText, narration, replyToolCalled: false, toolCalls: [] }) as unknown as TurnSummary

describe('collectOwnerReply · 多段回复逐段判', () => {
  it('前一段是工具回声、后一段是系统注记:两段都不是给主人的话 ⇒ 重答', async () => {
    const collect = vi.fn()
      .mockResolvedValueOnce(summary('[System: 工具结果返回为空字符串]', ['[调用工具 matter_plan] {"title":"加收藏"}']))
      .mockResolvedValueOnce(summary('放到 wechat-cc 那边办了。'))
    const out = await collectOwnerReply(collect, 'hi', 'all_segments', vi.fn())
    expect(collect).toHaveBeenNthCalledWith(2, OWNER_REPLY_REMINDER, true)
    expect(out).toMatchObject({ replyRetried: true, replySuppressed: false, finalText: '放到 wechat-cc 那边办了。' })
  })

  it('有一段是正常的话 ⇒ 原样交付,不重答', async () => {
    const collect = vi.fn().mockResolvedValueOnce(summary('[System: 备注]', ['先看一下设置页。']))
    const out = await collectOwnerReply(collect, 'hi', 'all_segments', vi.fn())
    expect(collect).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({ replyRetried: false, replySuppressed: false })
  })

  it('只看最后一段的执行者:前面的旁白不参与判定', async () => {
    const collect = vi.fn()
      .mockResolvedValueOnce(summary('[System: 备注]', ['先看一下设置页。']))
      .mockResolvedValueOnce(summary('好了。'))
    const out = await collectOwnerReply(collect, 'hi', 'last_segment', vi.fn())
    expect(out.replyRetried).toBe(true)
  })

  it('静默令牌 + 一句注记:交付时令牌会被剥掉、注记会单独发出去 ⇒ 按回声重答', async () => {
    const collect = vi.fn()
      .mockResolvedValueOnce(summary('NO_REPLY\n[System: 工具结果返回为空字符串]'))
      .mockResolvedValueOnce(summary('记下了。'))
    const out = await collectOwnerReply(collect, 'hi', 'last_segment', vi.fn())
    expect(out).toMatchObject({ replyRetried: true, replySuppressed: false, finalText: '记下了。' })
  })

  it('整段就是静默令牌 = 模型有意不说,不算回声、不重答', async () => {
    const collect = vi.fn().mockResolvedValueOnce(summary('NO_REPLY'))
    const out = await collectOwnerReply(collect, 'hi', 'last_segment', vi.fn())
    expect(collect).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({ replyRetried: false, replySuppressed: false, finalText: 'NO_REPLY' })
  })

  it('同一段里工具回声紧跟着系统注记(中间没有工具调用把它们分开)⇒ 重答', async () => {
    const collect = vi.fn()
      .mockResolvedValueOnce(summary('[调用工具 matter_plan] {"title":"加收藏","legs":[{"brief":"加 {收藏} 按钮"}]}\n[System: 工具结果返回为空字符串]'))
      .mockResolvedValueOnce(summary('放到 wechat-cc 那边办了。'))
    const out = await collectOwnerReply(collect, 'hi', 'last_segment', vi.fn())
    expect(out).toMatchObject({ replyRetried: true, replySuppressed: false })
  })

  it('日志只有类别、段数和长度,没有正文', async () => {
    const log = vi.fn()
    const collect = vi.fn()
      .mockResolvedValueOnce(summary('[System: 独特字符串-9f3a]'))
      .mockResolvedValueOnce(summary('[System: 独特字符串-9f3a]'))
    const out = await collectOwnerReply(collect, 'hi', 'last_segment', log)
    expect(out).toMatchObject({ replyRetried: true, replySuppressed: true, finalText: '' })
    expect(log.mock.calls.flat().join(' ')).not.toContain('独特字符串')
    expect(log).toHaveBeenCalledWith('REPLY_NOT_FOR_OWNER', expect.stringMatching(/^category=system_annotation segments=1 length=\d+$/))
  })
})
