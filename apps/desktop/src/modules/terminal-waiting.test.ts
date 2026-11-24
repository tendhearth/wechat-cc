import { describe, it, expect, vi, afterEach } from 'vitest'
import { terminalPendingOperation, terminalWaitingRows, terminalTitle, createTerminalWaitingPoller } from './terminal-waiting.js'
import { renderTerminalPermissionOperation } from './permission-operation.js'

const s = (over: Record<string, unknown> = {}) => ({
  session_id: 'ab12c3-full', code: 'ab12c3', source: 'claude', displayName: 'Claude', status: 'waiting', project: 'wechat-cc', machine: null,
  pending: { tool: 'Bash', summary: 'npm publish', since: 1, hash: 'k3x9z' }, ...over,
})

describe('terminalWaitingRows', () => {
  it('只要等批准的;开了码 ⇒ hash;桌面只写「项目」(哪家画头像,名字给读屏和小窗),不写「终端」和码', () => {
    expect(terminalWaitingRows([
      s(),
      s({ session_id: 'cd34e5-full', code: 'cd34e5', source: 'codex', displayName: 'Codex', project: 'melu', pending: { tool: 'permission', summary: '要改 package.json', since: 1, hash: null } }),
      s({ session_id: 'x', status: 'running', pending: null }),
      s({ session_id: 'y', status: 'idle' }),
    ])).toEqual([
      { id: 'ab12c3-full', title: '想运行 npm publish', detail: 'wechat-cc', agent: 'claude', source: 'Claude', hash: 'k3x9z', tool: 'Bash', display: { body: { kind: 'command', command: 'npm publish' } }, summaryTruncated: false, summaryOnly: true, summary: 'npm publish', projectPath: 'wechat-cc' },
      { id: 'cd34e5-full', title: '要改 package.json', detail: 'melu', agent: 'codex', source: 'Codex', hash: null, tool: '', display: { body: { kind: 'text', text: '要改 package.json' } }, summaryTruncated: false, summaryOnly: true, summary: '要改 package.json', projectPath: 'melu' },
    ])
  })

  it('老 daemon 没带 hash / hash 形状不对 ⇒ 不给按钮;没摘要 ⇒ 兜底标题;长的截断;坏输入 ⇒ 空', () => {
    expect(terminalWaitingRows([s({ pending: { tool: 'Bash', summary: null, since: 1 } })])[0]).toMatchObject({ title: '想用 Bash', hash: null })
    expect(terminalWaitingRows([s({ pending: { tool: 'Bash', summary: ' \r\n', since: 1 } })])[0])
      .toMatchObject({ title: '想运行 \\r', summaryOnly: true, display: { body: { command: ' \r\n' } } })
    expect(terminalWaitingRows([s({ pending: { tool: 'Bash', summary: 'x', since: 1, hash: 'NOT A HASH' } })])[0]!.hash).toBeNull()
    expect(terminalWaitingRows([s({ pending: { tool: 'permission', summary: null, since: 1, hash: null } })])[0]!.title).toBe('Claude 要你批准')
    expect(terminalWaitingRows([s({ pending: { tool: 'Bash', summary: 'y'.repeat(300), since: 1, hash: null } })])[0]!.title.length).toBe(120)
    expect(terminalWaitingRows(undefined)).toEqual([])
    expect(terminalTitle('Edit', 'src/a.ts', 'Claude Code')).toBe('想改 src/a.ts')
    expect(terminalTitle('mcp__x__do', 'go', 'Claude Code')).toBe('想用 mcp__x__do：go')
    expect(terminalWaitingRows([null, 3, s({ pending: null })])).toEqual([])
  })

  it('prefers a valid edit display and uses its completeness independently of the summary', () => {
    const display = { body: { kind: 'edit', path: '/work/a', changes: [{ before: 'old', after: 'new' }] } }
    const pending = { tool: 'Edit', summary: 'opaque…', since: 1, truncated: true, display, cwd: '/work/run' }
    const row = (over: Record<string, unknown>) => terminalWaitingRows([s({ cwd: '/work', pending: { ...pending, ...over } })])[0]
    expect(row({})).toMatchObject({ title: '想改 opaque…', display, cwd: '/work/run', projectPath: '/work', summaryTruncated: true })
    expect(row({})?.raw === '/work/a\nBefore: "old"\nAfter: "new"').toBe(true)
    expect(row({ display: { ...display, truncated: true }, truncated: false })).toMatchObject({
      display: { truncated: true }, summaryTruncated: false, summary: 'opaque…',
    })
    expect(row({ display: { body: { kind: 'edit', changes: [] } }, cwd: 'relative' })).toMatchObject({
      display: { body: { kind: 'text', text: 'opaque…' }, truncated: true }, cwd: undefined, projectPath: '/work', summaryTruncated: true,
    })
    expect(row({ display: undefined, truncated: false })?.summaryTruncated).toBe(false)
    expect(row({ display: undefined, truncated: undefined })?.summaryTruncated).toBe(true)
    expect(row({ display: undefined, truncated: undefined, summary: 'x'.repeat(200) })?.summaryTruncated).toBe(true)
    expect(row({ display: undefined, truncated: undefined, summary: 'x'.repeat(198) + '\r\n' })?.summaryTruncated).toBe(true)
  })

  it('哪家:没写 source(老 daemon)⇒ Claude;不认识的 ⇒ 照名字来,不冒充 Claude;名字只读 daemon 给的 displayName', () => {
    expect(terminalWaitingRows([s({ source: undefined, displayName: undefined })])[0]).toMatchObject({ agent: 'claude', source: 'claude' })
    expect(terminalWaitingRows([s({ source: 'agy', displayName: 'Gemini(账号)' })])[0]).toMatchObject({ agent: 'agy', source: 'Gemini(账号)' })
    expect(terminalWaitingRows([s({ source: 'kimi', displayName: undefined, pending: { tool: 'permission', summary: null, since: 1, hash: null } })])[0]).toMatchObject({ agent: 'kimi', source: 'kimi', title: 'kimi 要你批准' })
  })
})

describe('terminalPendingOperation', () => {
  const preview = { body: { kind: 'command', command: 'printf "example\r"' } }
  const edit = { body: { kind: 'edit', path: '/sample/a', changes: [{ before: 'example\n', after: 'example' }] } }
  const patch = { body: { kind: 'patch', files: [{ path: '/sample/a', change: 'update', diff: '@@\n-example\n+example\n\\ No newline at end of file' }] } }
  const snapshot = '预览是批准时的快照，运行以当时内容为准。允许仅限本请求、本轮和这一次调用；脚本及运行时依赖可能变化。'
  const common = { tool: 'Bash', summary: 'sample', since: 1, cwd: '/sample', display: preview }

  it.each([
    { label: '结构化完整', fields: { truncated: true }, allow: true, includes: ['看完整原文', '在 /sample', 'approval-invisible-notice'] },
    { label: '结构化被截', fields: { display: { ...preview, truncated: true } }, allow: false, includes: ['看摘要', 'approval-command'] },
    { label: '只有摘要', fields: { display: undefined }, allow: true, includes: ['approval-summary-label', '看摘要'] },
    { label: '摘要被截', fields: { display: undefined, summary: 'sample…' }, allow: false, includes: ['approval-summary-label'] },
    { label: '没有核实的执行目录', fields: { cwd: 'relative' }, allow: false, includes: ['项目目录 /project', 'approval-command'] },
    { label: '命令工具的结构化文字', fields: { cwd: undefined, display: { body: { kind: 'text', text: 'sample' } } }, allow: false, includes: ['data-kind="text"'] },
    { label: '带脚本预览', fields: { showSnapshotNotice: true, hasScriptPreview: true }, allow: false, includes: [snapshot] },
    { label: '只有快照说明', fields: { showSnapshotNotice: true, hasScriptPreview: false }, allow: true, includes: [snapshot] },
    { label: '编辑只有换行差别', fields: { tool: 'Edit', display: edit }, allow: false, includes: ['这一段的末尾少了一个换行。', 'data-line="deleted"', 'data-line="added"'] },
    { label: '补丁只有换行差别', fields: { tool: 'apply_patch', display: patch }, allow: false, includes: ['这处改动只在换行或空白上有差别', 'data-line="added"'] },
  ])('$label', ({ fields, allow, includes }) => {
    const operation = terminalPendingOperation({ project: 'sample', cwd: '/project', pending: { ...common, ...fields } })
    const { html, needsFullView } = renderTerminalPermissionOperation(operation)
    expect(!needsFullView).toBe(allow)
    expect(html.includes('这里不是全部内容，完整的请在终端里看。')).toBe(!allow)
    expect(html.includes('approval-compact')).toBe(false)
    for (const fragment of includes) expect(html.includes(fragment)).toBe(true)
  })
})

describe('createTerminalWaitingPoller', () => {
  afterEach(() => { vi.useRealTimers() })

  it('读 /v1/cli/sessions;只在变化时通知;读不到 ⇒ 空列表(不留旧行)', async () => {
    vi.useFakeTimers()
    let reply: unknown = { ok: true, sessions: [s()] }
    const call = vi.fn(async () => { if (reply instanceof Error) throw reply; return reply })
    const onChange = vi.fn()
    const p = createTerminalWaitingPoller({ call, onChange, intervalMs: 1000 })
    p.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(call).toHaveBeenCalledWith('GET', '/v1/cli/sessions?limit=20')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0]![0]).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(call).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenCalledTimes(1)   // 没变不通知
    reply = new Error('403')
    await vi.advanceTimersByTimeAsync(1000)
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(onChange.mock.calls[1]![0]).toEqual([])
    p.stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(call).toHaveBeenCalledTimes(3)
  })

  it('onSessions:整份会话(不只是等批准的)也交出去,给主页的在做 / 带回来的;只在变化时通知,读不到 ⇒ 空', async () => {
    vi.useFakeTimers()
    let reply: unknown = { ok: true, sessions: [s(), { ...s(), session_id: 'run', status: 'running', pending: null }] }
    const call = vi.fn(async () => { if (reply instanceof Error) throw reply; return reply })
    const onSessions = vi.fn()
    const p = createTerminalWaitingPoller({ call, onChange: vi.fn(), onSessions, intervalMs: 1000 })
    p.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(onSessions).toHaveBeenCalledTimes(1)
    expect(onSessions.mock.calls[0]![0].map((x: any) => x.session_id)).toEqual(['ab12c3-full', 'run'])
    await vi.advanceTimersByTimeAsync(1000)
    expect(onSessions).toHaveBeenCalledTimes(1)
    reply = new Error('403')
    await vi.advanceTimersByTimeAsync(1000)
    expect(onSessions).toHaveBeenLastCalledWith([])
    p.stop()
  })
})

