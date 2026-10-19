import { describe, it, expect, vi, afterEach } from 'vitest'
import { terminalWaitingRows, terminalTitle, createTerminalWaitingPoller } from './terminal-waiting.js'

const s = (over: Record<string, unknown> = {}) => ({
  session_id: 'ab12c3-full', code: 'ab12c3', source: 'claude', status: 'waiting', project: 'wechat-cc', machine: null,
  pending: { tool: 'Bash', summary: 'npm publish', since: 1, hash: 'k3x9z' }, ...over,
})

describe('terminalWaitingRows', () => {
  it('只要等批准的;开了码 ⇒ hash;桌面只写「项目」(哪家画头像,名字给读屏和小窗),不写「终端」和码', () => {
    expect(terminalWaitingRows([
      s(),
      s({ session_id: 'cd34e5-full', code: 'cd34e5', source: 'codex', project: 'melu', pending: { tool: 'permission', summary: '要改 package.json', since: 1, hash: null } }),
      s({ session_id: 'x', status: 'running', pending: null }),
      s({ session_id: 'y', status: 'idle' }),
    ])).toEqual([
      { id: 'ab12c3-full', title: '想运行 npm publish', detail: 'wechat-cc', agent: 'claude', source: 'Claude Code', hash: 'k3x9z', tool: 'Bash', command: 'npm publish', commandLabel: '要运行的命令' },
      { id: 'cd34e5-full', title: '要改 package.json', detail: 'melu', agent: 'codex', source: 'Codex', hash: null, tool: '', command: '要改 package.json', commandLabel: '具体内容' },
    ])
  })

  it('老 daemon 没带 hash / hash 形状不对 ⇒ 不给按钮;没摘要 ⇒ 兜底标题;长的截断;坏输入 ⇒ 空', () => {
    expect(terminalWaitingRows([s({ pending: { tool: 'Bash', summary: null, since: 1 } })])[0]).toMatchObject({ title: '想用 Bash', hash: null })
    expect(terminalWaitingRows([s({ pending: { tool: 'Bash', summary: 'x', since: 1, hash: 'NOT A HASH' } })])[0]!.hash).toBeNull()
    expect(terminalWaitingRows([s({ pending: { tool: 'permission', summary: null, since: 1, hash: null } })])[0]!.title).toBe('Claude Code 要你批准')
    expect(terminalWaitingRows([s({ pending: { tool: 'Bash', summary: 'y'.repeat(300), since: 1, hash: null } })])[0]!.title.length).toBe(120)
    expect(terminalWaitingRows(undefined)).toEqual([])
    expect(terminalTitle('Edit', 'src/a.ts', 'Claude Code')).toBe('想改 src/a.ts')
    expect(terminalTitle('mcp__x__do', 'go', 'Claude Code')).toBe('想用 mcp__x__do：go')
    expect(terminalWaitingRows([null, 3, s({ pending: null })])).toEqual([])
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
})
