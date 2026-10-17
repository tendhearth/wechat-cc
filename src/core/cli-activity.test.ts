import { describe, expect, it } from 'vitest'
import { claudeStep, codexExecSteps, parseActivity } from './cli-activity'

const L = (o: object) => JSON.stringify(o)
const T = '2026-10-17T10:00:00.000Z'

describe('parseActivity —— 看着它跑', () => {
  it('Claude:主人的话、它的话、每个工具一步,按记录顺序', () => {
    const jsonl = [
      L({ type: 'user', timestamp: T, message: { content: '把测试修好' } }),
      L({ type: 'assistant', timestamp: T, message: { content: [{ type: 'text', text: '先跑一遍' }, { type: 'tool_use', name: 'Bash', input: { command: 'cd /w/proj && npm test' } }] } }),
      L({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
      L({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/w/proj/src/main.ts' } }] } }),
      L({ type: 'user', message: { content: '<system-reminder>x</system-reminder>' } }),
    ].join('\n')
    expect(parseActivity(jsonl, 'claude')).toEqual([
      { kind: 'you', text: '把测试修好', at: Date.parse(T) },
      { kind: 'said', text: '先跑一遍', at: Date.parse(T) },
      { kind: 'step', text: '运行 npm test', at: Date.parse(T) },
      { kind: 'step', text: '改 main.ts', at: null },
    ])
  })

  it('Claude 给命令写了说明 ⇒ 用说明;认不出的工具写「用 名字」;mcp 工具带上服务名', () => {
    expect(claudeStep('Bash', { command: 'ls -la', description: '看看目录' })).toBe('看看目录')
    expect(claudeStep('Read', { file_path: '/a/b/c.md' })).toBe('读 c.md')
    expect(claudeStep('Task', { description: '查 CI' })).toBe('派子任务:查 CI')
    expect(claudeStep('WebFetch', { url: 'https://example.com/a?b' })).toBe('看网页 example.com')
    expect(claudeStep('TodoWrite', { todos: [{ status: 'completed', content: 'a' }, { status: 'in_progress', content: 'b', activeForm: '在写测试' }] })).toBe('清单:在写测试')
    expect(claudeStep('mcp__wechat__ping', {})).toBe('用 ping(wechat)')
    expect(claudeStep('Weird', {})).toBe('用 Weird')
  })

  it('连续同一步只留一条;密钥打码;只留最后 max 条', () => {
    const read = L({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/x/a.ts' } }] } })
    const secret = L({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'curl -H "x" API_KEY=abcd1234efgh' } }] } })
    const items = parseActivity([read, read, read, secret].join('\n'), 'claude')
    expect(items.map(i => i.text)).toEqual(['读 a.ts', '运行 curl -H "x" API_KEY=[已打码]'])
    const many = Array.from({ length: 60 }, (_, i) => L({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: `/f${i}` } }] } })).join('\n')
    const tail = parseActivity(many, 'claude', 10)
    expect(tail).toHaveLength(10)
    expect(tail[9]!.text).toBe('读 f59')
  })

  it('Codex 老格式:function_call shell / local_shell_call;新格式:exec 里的 exec_command / apply_patch', () => {
    const jsonl = [
      L({ type: 'response_item', timestamp: T, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '修一下' }] } }),
      L({ type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'git status'] }) } }),
      L({ type: 'response_item', payload: { type: 'local_shell_call', action: { command: ['ls', '-la'] } } }),
      L({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'text(await tools.exec_command({cmd:"echo $(date) && rg \\"x\\"",max_output_tokens:7000}));\ntext(await tools.apply_patch("*** Begin Patch\\n*** Update File: /w/p/index.html\\n@@\\n-a\\n+b\\n*** Add File: /w/p/new.ts\\n*** End Patch"))' } }),
      L({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'text(await tools.js_eval({code:"1"}))' } }),
      L({ type: 'response_item', payload: { type: 'function_call', name: 'followup_task', arguments: '{}' } }),
      L({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '好了' }] } }),
    ].join('\n')
    expect(parseActivity(jsonl, 'codex').map(i => `${i.kind}:${i.text}`)).toEqual([
      'you:修一下', 'step:运行 git status', 'step:运行 ls -la', 'step:运行 echo $(date) && rg "x"',
      'step:改 index.html', 'step:写 new.ts', 'step:用 exec', 'step:照看子任务', 'said:好了',
    ])
  })

  it('codexExecSteps:多行命令只留第一行加省略', () => {
    expect(codexExecSteps('tools.exec_command({cmd:"python3 - <<\'PY\'\\nprint(1)\\nPY"})')).toEqual(['运行 python3 - <<\'PY\' …'])
  })

  it('Cursor 只有文字;坏行跳过', () => {
    const jsonl = [
      L({ role: 'user', message: { content: [{ type: 'text', text: '<timestamp>x</timestamp>\n<user_query>改个颜色</user_query>' }] } }),
      '{not json',
      L({ role: 'assistant', message: { content: [{ type: 'text', text: '改好了' }] } }),
    ].join('\n')
    expect(parseActivity(jsonl, 'cursor').map(i => `${i.kind}:${i.text}`)).toEqual(['you:改个颜色', 'said:改好了'])
  })
})
