import { describe, expect, it } from 'vitest'
import { claudeStep, codexExecSteps, parseActivity, textDiff, DETAIL_MAX } from './cli-activity'

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
      { kind: 'step', text: '运行 npm test', at: Date.parse(T), verb: 'run', target: 'npm test' },
      { kind: 'step', text: '改 main.ts', at: null, verb: 'edit', target: 'main.ts' },
    ])
  })

  it('Claude 给命令写了说明 ⇒ 用说明;认不出的工具写「用 名字」;mcp 工具带上服务名', () => {
    expect(claudeStep('Bash', { command: 'ls -la', description: '看看目录' })).toBe('看看目录')
    expect(claudeStep('Read', { file_path: '/a/b/c.md' })).toBe('读 c.md')
    expect(claudeStep('Task', { description: '查 CI' })).toBe('派子任务:查 CI')
    expect(claudeStep('WebFetch', { url: 'https://example.com/a?b' })).toBe('看网页 example.com')
    expect(claudeStep('TodoWrite', { todos: [{ status: 'completed', content: 'a' }, { status: 'in_progress', content: 'b', activeForm: '在写测试' }] })).toBe('清单:在写测试')
    expect(claudeStep('mcp__wechat__ping', {})).toBe('用 ping')
    expect(claudeStep('mcp__plugin_playwright_playwright__browser_click', {})).toBe('用 browser_click')
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
    expect(codexExecSteps('tools.exec_command({cmd:"python3 - <<\'PY\'\\nprint(1)\\nPY"})').map(x => x.text)).toEqual(['运行 python3 - <<\'PY\' …'])
  })

  it('Cursor 只有文字;坏行跳过', () => {
    const jsonl = [
      L({ role: 'user', message: { content: [{ type: 'text', text: '<timestamp>x</timestamp>\n<user_query>改个颜色</user_query>' }] } }),
      '{not json',
      L({ role: 'assistant', message: { content: [{ type: 'text', text: '改好了' }] } }),
    ].join('\n')
    expect(parseActivity(jsonl, 'cursor').map(i => `${i.kind}:${i.text}`)).toEqual(['you:改个颜色', 'said:改好了'])
  })

  it('点开一步:Claude 改文件 ⇒ diff;命令 ⇒ 输出尾巴;读文件不挂输出;报错 ⇒ error 且挂上原因', () => {
    const jsonl = [
      L({ type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/p/a.ts', old_string: 'const a = 1\nconst b = 2', new_string: 'const a = 1\nconst b = 3' } },
        { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm test' } },
        { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/p/a.ts' } },
        { type: 'tool_use', id: 'b2', name: 'Bash', input: { command: 'npm run lint' } },
      ] } }),
      L({ type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: 'e1', content: 'The file has been updated.' },
        { type: 'tool_result', tool_use_id: 'b1', content: [{ type: 'text', text: 'PASS a.test.ts\nTests 3 passed' }] },
        { type: 'tool_result', tool_use_id: 'r1', content: 'const a = 1' },
        { type: 'tool_result', tool_use_id: 'b2', content: 'error: unused var TOKEN=abcd1234zz', is_error: true },
      ] } }),
    ].join('\n')
    const [edit, test, read, lint] = parseActivity(jsonl, 'claude')
    expect(edit).toMatchObject({ text: '改 a.ts', detail: '- const b = 2\n+ const b = 3' })
    expect(edit!.error).toBeUndefined()
    expect(test).toMatchObject({ text: '运行 npm test', detail: 'PASS a.test.ts\nTests 3 passed' })
    expect(read!.detail).toBeUndefined()
    expect(lint).toMatchObject({ error: true, detail: 'error: unused var TOKEN=[已打码]' })
  })

  it('长输出只留结尾,长 diff 只留开头,都不超过上限', () => {
    const out = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')
    const jsonl = [
      L({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'x' } }, { type: 'tool_use', id: 'w', name: 'Write', input: { file_path: '/n.md', content: out } }] } }),
      L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: out }] } }),
    ].join('\n')
    const [bash, write] = parseActivity(jsonl, 'claude')
    expect(bash!.detail!.endsWith('line 199')).toBe(true)
    expect(bash!.detail!.startsWith('…(前面还有 160 行)')).toBe(true)
    expect(write!.detail!.startsWith('+ line 0')).toBe(true)
    expect(write!.detail).toContain('还有 160 行')
    for (const d of [bash!.detail!, write!.detail!]) expect(d.length).toBeLessThanOrEqual(DETAIL_MAX)
  })

  it('Codex:exec 的输出解开 JSON 只留 output;非零退出算报错;apply_patch 按文件出 diff', () => {
    const jsonl = [
      L({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'text(await tools.exec_command({cmd:"cargo test"}))' } }),
      L({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'Script completed\nWall time 1.0 seconds\nOutput:\n' }, { type: 'input_text', text: JSON.stringify({ exit_code: 101, output: 'test x ... FAILED' }) }] } }),
      L({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c2', name: 'exec', input: 'text(await tools.apply_patch("*** Begin Patch\\n*** Update File: /w/a.rs\\n@@\\n-old\\n+new\\n*** Add File: /w/b.rs\\n+fn b() {}\\n*** End Patch"))' } }),
      L({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c4', name: 'exec', input: 'text(await tools.mcp_x({}))' } }),
      L({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c4', output: 'Script failed\nOutput:\n' + JSON.stringify({ content: [{ type: 'text', text: 'not allowed' }] }) } }),
      L({ type: 'response_item', payload: { type: 'function_call', call_id: 'c3', name: 'shell', arguments: JSON.stringify({ command: ['ls'] }) } }),
      L({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c3', output: 'a\nb' } }),
    ].join('\n')
    const items = parseActivity(jsonl, 'codex')
    expect(items).toEqual([
      { kind: 'step', text: '运行 cargo test', at: null, detail: 'test x ... FAILED', error: true, verb: 'run', target: 'cargo test' },
      { kind: 'step', text: '改 a.rs', at: null, detail: '- old\n+ new', verb: 'edit', target: 'a.rs' },
      { kind: 'step', text: '写 b.rs', at: null, detail: '+ fn b() {}', verb: 'write', target: 'b.rs' },
      { kind: 'step', text: '用 exec', at: null, detail: 'not allowed', error: true, verb: 'tool', target: 'exec' },
      { kind: 'step', text: '运行 ls', at: null, detail: 'a\nb', verb: 'run', target: 'ls' },
    ])
  })

  it('textDiff 只留改了的那一截', () => {
    expect(textDiff('a\nb\nc', 'a\nB\nc')).toBe('- b\n+ B')
    expect(textDiff('', 'x')).toBe('- \n+ x')
  })
})

describe('verb + target(给按语言显示的端)', () => {
  it('固定说法都能反解;Claude 自己写的命令说明不拆', async () => {
    const { stepPhrase } = await import('./cli-activity')
    expect(stepPhrase('运行 npm test')).toEqual({ verb: 'run', target: 'npm test' })
    expect(stepPhrase('上网搜「bun ffi」')).toEqual({ verb: 'websearch', target: 'bun ffi' })
    expect(stepPhrase('搜「TODO」')).toEqual({ verb: 'search', target: 'TODO' })
    expect(stepPhrase('更新清单')).toEqual({ verb: 'todos', target: '' })
    expect(stepPhrase('派子任务:查 CI')).toEqual({ verb: 'subtask', target: '查 CI' })
    expect(stepPhrase('Check CI status')).toBeNull()
    const L = (o: object) => JSON.stringify(o)
    const items = parseActivity([
      L({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls', description: '运行 测试' } }, { type: 'tool_use', name: 'Edit', input: { file_path: '/a/b.ts', old_string: 'a', new_string: 'b' } }] } }),
    ].join('\n'), 'claude')
    expect(items[0]).toMatchObject({ text: '运行 测试' }); expect(items[0]!.verb).toBeUndefined()
    expect(items[1]).toMatchObject({ verb: 'edit', target: 'b.ts' })
  })
})

describe('renderTurnSteps(「看 码」页面)', () => {
  it('只列主人最后一句之后的步骤;不放 diff / 输出;报错标「没成」;超过上限只列最后几步', async () => {
    const { renderTurnSteps, VIEW_STEPS_MAX } = await import('./cli-activity')
    const L = (o: object) => JSON.stringify(o)
    const tool = (id: string, name: string, input: object) => L({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })
    const jsonl = [
      L({ type: 'user', message: { content: '上一件' } }), tool('o', 'Read', { file_path: '/old.ts' }),
      L({ type: 'user', message: { content: '修测试' } }),
      tool('a', 'Edit', { file_path: '/p/a.ts', old_string: 'SECRET_OLD', new_string: 'x' }),
      tool('b', 'Bash', { command: 'npm test' }),
      L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: '1 failed', is_error: true }] } }),
    ].join('\n')
    const md = renderTurnSteps(jsonl, 'claude')
    expect(md).toBe('## 这一轮做了什么\n\n- 改 a.ts\n- 运行 npm test(没成)\n')
    expect(md).not.toContain('SECRET_OLD'); expect(md).not.toContain('old.ts')
    expect(renderTurnSteps(L({ type: 'user', message: { content: '在吗' } }), 'claude')).toBe('')
    const many = [L({ type: 'user', message: { content: 'go' } }), ...Array.from({ length: 20 }, (_, i) => tool(`t${i}`, 'Bash', { command: `step${i}` }))].join('\n')
    const m = renderTurnSteps(many, 'claude')
    expect(m).toContain(`共 20 步,只列最后 ${VIEW_STEPS_MAX} 步`); expect(m).toContain('运行 step19'); expect(m).not.toContain('运行 step7\n')
  })
})
