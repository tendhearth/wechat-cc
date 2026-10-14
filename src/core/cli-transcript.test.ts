import { describe, it, expect } from 'vitest'
import { parseTranscript, renderTranscriptTail } from './cli-transcript'

const claudeLines = [
  { type: 'user', message: { content: '帮我看看' } },
  { type: 'user', isMeta: true, message: { content: '# /loop — schedule' } },
  { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: '好的,我先查' }, { type: 'tool_use', name: 'Bash' }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } },
  { type: 'user', message: { content: '<task-notification>\n<task-id>x</task-id>' } },
  { type: 'assistant', message: { content: [{ type: 'text', text: '查完了,**结论**如下' }] } },
  'not json',
].map(x => typeof x === 'string' ? x : JSON.stringify(x)).join('\n')

const codexLines = [
  { type: 'session_meta', payload: { id: 't' } },
  { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>' }] } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n<cwd>/x</cwd>' }] } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '创建 hello.py' }] } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '我先创建文件。\n<tool_call>\n<function=exec_command>\n<parameter=cmd>cat</parameter>\n</function>\n</tool_call>' }] } },
  { type: 'response_item', payload: { type: 'function_call', name: 'exec_command' } },
  { type: 'event_msg', payload: { type: 'task_complete' } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已完成' }] } },
].map(x => JSON.stringify(x)).join('\n')

describe('parseTranscript', () => {
  it('claude:只取 user/assistant 的文字,跳过 meta / thinking / tool / harness 文本 / 坏行', () => {
    expect(parseTranscript(claudeLines, 'claude')).toEqual([
      { role: 'user', text: '帮我看看' },
      { role: 'assistant', text: '好的,我先查' },
      { role: 'assistant', text: '查完了,**结论**如下' },
    ])
  })
  it('codex:response_item message 的 user/assistant,去掉 tool_call 与环境上下文', () => {
    expect(parseTranscript(codexLines, 'codex')).toEqual([
      { role: 'user', text: '创建 hello.py' },
      { role: 'assistant', text: '我先创建文件。' },
      { role: 'assistant', text: '已完成' },
    ])
  })
})

describe('renderTranscriptTail', () => {
  it('只显示最后 N 段,标出总数;空会话有提示', () => {
    const md = renderTranscriptTail(claudeLines, 'claude', { turns: 2, title: '会话 a1b2c3' })
    expect(md.startsWith('# 会话 a1b2c3\n')).toBe(true)
    expect(md).toContain('共 3 段,只显示最后 2 段')
    expect(md).not.toContain('帮我看看')
    expect(md).toContain('**claude**:\n\n查完了')
    expect(renderTranscriptTail('', 'codex')).toContain('还没有对话文字')
  })
})

// 2026-10-10 评审:「看 码」把对话尾巴发成一个不用登录的公开页面。Claude Code 的 `!` 命令输出
// (<bash-input> / <bash-stdout> / <bash-stderr>)原先照样进页面 ⇒ `! env`、`! cat .env` 的密钥就上了公网。
describe('transcript secrets', () => {
  it('skips the `!` shell blocks and masks obvious keys in what is left', () => {
    const jsonl = [
      { type: 'user', message: { content: '<bash-input>env</bash-input>' } },
      { type: 'user', message: { content: '<bash-stdout>OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123</bash-stdout><bash-stderr></bash-stderr>' } },
      { type: 'user', message: { content: '我的 key 是 sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX,GitHub ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789,AWS AKIAIOSFODNN7EXAMPLE' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: '已设置 DB_PASSWORD=hunter2hunter2 和 api_key: "abc123def456ghi789"' }] } },
    ].map(x => JSON.stringify(x)).join('\n')
    const turns = parseTranscript(jsonl, 'claude')
    const all = turns.map(t => t.text).join('\n')
    expect(turns).toHaveLength(2)
    expect(all).not.toMatch(/sk-proj-abcdef|sk-ant-api03-ABCDEF|ghp_ABCDEF|AKIAIOSFODNN7EXAMPLE|hunter2hunter2|abc123def456ghi789/)
    expect(all).toContain('我的 key 是')
    expect(all).toContain('DB_PASSWORD=')
  })
})
