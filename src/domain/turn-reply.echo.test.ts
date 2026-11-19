import { describe, expect, it } from 'vitest'
import { replyMayBeEcho, replyNotForOwner } from './turn-reply'

describe('replyNotForOwner · 整段只由内部回声组成才算', () => {
  it.each([
    ['[System: 在消息发送通道中，工具结果返回为空字符串。这是正常情况 - 继续处理用户请求]', 'system_annotation'],
    ['[System: a]\n\n[System: b [嵌套] 也算]', 'system_annotation'],
    ['[调用工具 matter_plan] {"project": "wechat-cc", "title": "修一下", "legs": [{"brief": "修一下"}]}', 'tool_echo'],
    ['[调用工具 wechat/matter_plan] {"title":"带 } 和 { 的字符串","legs":[{"brief":"引号 \\" 也在"}]}', 'tool_echo'],
    ['[调用工具 a] {"x":1}\n[System: 工具结果返回为空字符串]', 'tool_echo'],
    ['[System: 先来一句]\n[调用工具 a] {"x":1}\n[调用工具 b] {"y":[1,2]}', 'tool_echo'],
  ] as const)('%s ⇒ %s', (text, category) => {
    expect(replyNotForOwner(text)).toBe(category)
  })

  it.each([
    '记下了，这个先当点子放着。',
    '[System: 备注]\n不过你要的东西我放到 wechat-cc 那边了。',
    '我刚才看到一行 [System: 备注]，不知道是什么。',
    '> [System: 这是引用]',
    '```\n[System: 在代码块里]\n```',
    '    [System: 缩进的代码块]',
    '[System: 没写完',
    '[调用工具 matter_plan] {"title": "没写完"',
    '[调用工具 matter_plan] {不是 JSON}',
    '[调用工具 matter_plan] {"a":1} 然后我去办了。',
    '[调用工具 matter_plan]',
    '',
  ])('不拦:%s', text => {
    expect(replyNotForOwner(text)).toBeUndefined()
  })

  it('replyMayBeEcho 只看起头:没写完的也算「可能是」', () => {
    expect(replyMayBeEcho('[System: tool result')).toBe(true)
    expect(replyMayBeEcho('  [调用工具 x] {')).toBe(true)
    expect(replyMayBeEcho('好，[System: 这句在中间')).toBe(false)
    expect(replyMayBeEcho('')).toBe(false)
  })

  it.each([
    ['[assistant turn timed out before producing a reply]', 'english_annotation'],
    ['[no reply was delivered]', 'english_annotation'],
    ['[tool call omitted]', 'english_annotation'],
    ['[tool call omitted [details]]', 'english_annotation'],
    ['[历史回放] 2026-07-02 23:39 (UTC+8)', 'timestamp_annotation'],
    ['[历史回放] 2026年7月2日 23时39分', 'timestamp_annotation'],
    ['[history replay] 2026/07/02 23:39 (UTC-05:30)', 'timestamp_annotation'],
  ] as const)('新增拦截:%s ⇒ %s', (text, category) => {
    expect(replyNotForOwner(text)).toBe(category)
    expect(replyMayBeEcho(text)).toBe(false)
  })

  it.each([
    '[捂脸]',
    '[旺柴]',
    '[旺柴][旺柴]',
    '[OK]',
    '[强]',
    '[Draft v2] 我改好了。',
    '[1] 第一点…',
    '[rici] 收藏功能做完了',
    '[System',
    '[assistant turn timed out',
    '[assistant turn timed out] 正文',
    '[assistant turn timed out][旺柴]',
    '> [assistant turn timed out]',
    '> [历史回放] 2026-07-02',
    '```\n[assistant turn timed out]\n```',
    '    [历史回放] 2026-07-02',
    '`[assistant turn timed out]`',
    '[2026-07-02] 今天…',
    '[历史回放] 2026-07-02 那天我们聊过…',
    '[历史回放] 2026-07-',
    '[历史回放] 2026-07-02 23:39 (UTC+8',
  ])('新增形状不拦:%s', text => {
    expect(replyNotForOwner(text)).toBeUndefined()
  })
})
