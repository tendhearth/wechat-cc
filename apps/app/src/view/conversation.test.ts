import { describe, expect, it } from 'vitest'
import { conversationView } from './conversation'
const ev = (kind: string, text: string, createdAt: number) => ({ kind, text, createdAt })
describe('conversationView', () => {
  it('用户 / CC / 合并的步骤 / 出错;系统行不显示', () => {
    expect(conversationView([ev('user', '帮我看看', 1), ev('system', '权限请求', 2), ev('tool_call', 'ListFiles', 3), ev('tool_call', 'ReadFile', 4), ev('text', '看完了', 5), ev('error', '额度用完', 6), ev('user', 'wxvault 不能看到么', 7)]))
      .toEqual([
        { kind: 'me', text: '帮我看看', at: 1 },
        { kind: 'steps', text: 'ReadFile', at: 4, count: 2 },
        { kind: 'cc', text: '看完了', at: 5 },
        { kind: 'error', text: '额度用完', at: 6 },
        { kind: 'me', text: 'wxvault 不能看到么', at: 7 },
      ])
  })
  it('超长截断', () => {
    expect(conversationView([ev('text', 'x'.repeat(5000), 1)])[0]!.text).toHaveLength(4001)
  })
  it('preserves friendly model error and exact raw diagnostic separately', () => {
    const diagnostic = '  **raw**\r\nHTTP 400 https://account.example\r\n'
    expect(conversationView([{ kind: 'error', text: '账号暂不能使用这个模型。', createdAt: 1, diagnostic, errorCode: 'execution_model_unsupported' }]))
      .toEqual([{ kind: 'error', text: '账号暂不能使用这个模型。', at: 1, diagnostic }])
  })
})
