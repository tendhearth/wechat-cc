import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  makeCliEventHub, formatCliPush, makeProjectNamer, summarizeOneLine,
  STOP_HOLD_MS, PERMISSION_HOLD_MS, MAX_TRACKED_SESSIONS, MIN_TURN_MS, PRESENT_WINDOW_MS, RELAY_SUPPRESS_MS, type CliEvent,
} from './cli-events'

const ev = (over: Partial<CliEvent> = {}): CliEvent => ({
  source: 'claude', kind: 'stop', session_id: 'a1b2c3d4-0000', cwd: '/home/u/work/wechat-cc', text: '搞定了', ...over,
})

function harness(opts: { sendResult?: boolean; sendThrows?: boolean } = {}) {
  const sent: string[] = []
  const logs: string[] = []
  const send = vi.fn(async (text: string) => {
    if (opts.sendThrows) throw new Error('ilink down')
    sent.push(text)
    return opts.sendResult ?? true
  })
  const hub = makeCliEventHub({
    send,
    projectName: (cwd) => cwd.split('/').pop() ?? cwd,
    log: (tag, line) => logs.push(`${tag} ${line}`),
  })
  return { hub, sent, logs, send }
}

describe('CliEventHub 压 / 撤 / 清(spec 2026-09-09-cli-hook-push §5)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('stop → scheduled;压满 STOP_HOLD_MS 才发一条', async () => {
    const { hub, sent } = harness()
    expect(hub.ingest(ev())).toBe('scheduled')
    await vi.advanceTimersByTimeAsync(STOP_HOLD_MS - 1)
    expect(sent).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('claude 完成了')
    expect(sent[0]).toContain('wechat-cc')
    expect(hub.pending()).toEqual([])
  })

  it('stop 后同会话来 prompt → cancelled,不发;别的会话不受影响', async () => {
    const { hub, sent } = harness()
    hub.ingest(ev())
    hub.ingest(ev({ session_id: 'other-session', text: '另一件事' }))
    expect(hub.ingest(ev({ kind: 'prompt', text: undefined }))).toBe('cancelled')
    await vi.advanceTimersByTimeAsync(STOP_HOLD_MS)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('另一件事')
  })

  it('prompt 没有待发 → noop', () => {
    const { hub } = harness()
    expect(hub.ingest(ev({ kind: 'prompt' }))).toBe('noop')
  })

  it('permission 压 PERMISSION_HOLD_MS;期间同会话 stop 把它替换掉(权限那条不发)', async () => {
    const { hub, sent } = harness()
    expect(hub.ingest(ev({ source: 'codex', kind: 'permission', text: 'Bash: rm -rf ./tmp' }))).toBe('scheduled')
    await vi.advanceTimersByTimeAsync(PERMISSION_HOLD_MS - 1)
    expect(hub.ingest(ev({ source: 'codex', kind: 'stop', text: '删完了' }))).toBe('scheduled')
    await vi.advanceTimersByTimeAsync(STOP_HOLD_MS)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('codex 完成了')
    expect(sent[0]).not.toContain('等你批准')
  })

  it('permission 单独压满 → 发「等你批准」', async () => {
    const { hub, sent } = harness()
    hub.ingest(ev({ source: 'codex', kind: 'permission', text: 'Bash: rm -rf ./tmp' }))
    await vi.advanceTimersByTimeAsync(PERMISSION_HOLD_MS)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('codex 等你批准')
    expect(sent[0]).toContain('Bash: rm -rf ./tmp')
  })

  it('session_end 清掉待发 → cleared;没有待发 → noop', async () => {
    const { hub, sent } = harness()
    hub.ingest(ev())
    expect(hub.ingest(ev({ kind: 'session_end' }))).toBe('cleared')
    expect(hub.ingest(ev({ kind: 'session_end' }))).toBe('noop')
    await vi.advanceTimersByTimeAsync(STOP_HOLD_MS)
    expect(sent).toEqual([])
  })

  it('send 返回 false(没主人 chat)→ 记日志、不抛;send 抛错 → 记日志、不抛、不重试', async () => {
    const a = harness({ sendResult: false })
    a.hub.ingest(ev())
    await vi.advanceTimersByTimeAsync(STOP_HOLD_MS)
    expect(a.logs.some(l => l.startsWith('CLI_PUSH') && l.includes('dropped'))).toBe(true)

    const b = harness({ sendThrows: true })
    b.hub.ingest(ev())
    await vi.advanceTimersByTimeAsync(STOP_HOLD_MS * 3)
    expect(b.send).toHaveBeenCalledTimes(1)
    expect(b.logs.some(l => l.startsWith('CLI_PUSH') && l.includes('ilink down'))).toBe(true)
  })

  it('最多跟踪 MAX_TRACKED_SESSIONS 个会话,超出丢最旧的(它不发)', async () => {
    const { hub, sent } = harness()
    for (let i = 0; i <= MAX_TRACKED_SESSIONS; i++) {
      hub.ingest(ev({ session_id: `s-${i}`, text: `t${i}` }))
      await vi.advanceTimersByTimeAsync(1)
    }
    expect(hub.pending()).toHaveLength(MAX_TRACKED_SESSIONS)
    expect(hub.pending().map(p => p.session_id)).not.toContain('s-0')
    await vi.advanceTimersByTimeAsync(STOP_HOLD_MS)
    expect(sent).toHaveLength(MAX_TRACKED_SESSIONS)
    expect(sent.some(s => s.includes('t0\n') || s.endsWith('t0'))).toBe(false)
  })

  it('dispose 清掉所有定时器', async () => {
    const { hub, sent } = harness()
    hub.ingest(ev())
    hub.dispose()
    await vi.advanceTimersByTimeAsync(STOP_HOLD_MS)
    expect(sent).toEqual([])
    expect(hub.pending()).toEqual([])
  })
})

describe('formatCliPush(spec §4)', () => {
  it('stop:来源 · 项目 · 会话短码 + 最后一句压成一行', () => {
    const s = formatCliPush(ev({ text: '  第一行\n\n第二行   很长  ' }), 'wechat-cc')
    expect(s).toBe('🔔 claude 完成了 · wechat-cc · 会话 a1b2c3\n第一行 第二行 很长')
  })
  it('stop 没留最后一句 → 只有标题行', () => {
    expect(formatCliPush(ev({ text: undefined }), 'wechat-cc')).toBe('🔔 claude 完成了 · wechat-cc · 会话 a1b2c3')
  })
  it('permission:等你批准 + 工具摘要 + 回终端提示', () => {
    const s = formatCliPush(ev({ source: 'codex', kind: 'permission', session_id: '9f0e1d22', text: 'Bash: rm -rf ./tmp' }), 'tendhearth')
    expect(s).toBe('✋ codex 等你批准 · tendhearth · 会话 9f0e1d\nBash: rm -rf ./tmp\n(回终端处理;这一类微信里暂时答不了)')
  })
})

describe('summarizeOneLine', () => {
  it('压空白、截到上限加省略号', () => {
    expect(summarizeOneLine(' a \n b\t\tc ')).toBe('a b c')
    expect(summarizeOneLine('x'.repeat(200), 120)).toBe('x'.repeat(119) + '…')
    expect(summarizeOneLine('')).toBe('')
  })
})

describe('makeProjectNamer', () => {
  const projects = [
    { alias: 'hearth', path: '/home/u/work/tendhearth' },
    { alias: 'wcc', path: '/home/u/work/tendhearth/wechat-cc' },
  ]
  it('最长前缀命中 → alias;目录边界要对齐', () => {
    const name = makeProjectNamer(() => projects)
    expect(name('/home/u/work/tendhearth/wechat-cc/src')).toBe('wcc')
    expect(name('/home/u/work/tendhearth')).toBe('hearth')
    expect(name('/home/u/work/tendhearth-old')).toBe('tendhearth-old')
  })
  it('没命中 → cwd 末段;列表抛错 → 末段;Windows 路径也认', () => {
    const name = makeProjectNamer(() => { throw new Error('db busy') })
    expect(name('/tmp/scratch')).toBe('scratch')
    expect(name('C:\\Users\\u\\proj\\')).toBe('proj')
  })
})

describe('CliEventHub 在场判断与「一次敲字最多推一条」(spec §5 补)', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-09T10:00:00Z')) })
  afterEach(() => { vi.useRealTimers() })

  it('prompt 后不到 MIN_TURN_MS 就 Stop → 快问快答,不推;超过才推', async () => {
    const { hub, sent } = harness()
    hub.ingest(ev({ kind: 'prompt' }))
    await vi.advanceTimersByTimeAsync(MIN_TURN_MS - 1000)
    expect(hub.ingest(ev())).toBe('noop')
    await vi.advanceTimersByTimeAsync(STOP_HOLD_MS)
    expect(sent).toEqual([])
    hub.ingest(ev({ kind: 'prompt' }))
    await vi.advanceTimersByTimeAsync(MIN_TURN_MS)
    expect(hub.ingest(ev())).toBe('scheduled')
    await vi.advanceTimersByTimeAsync(STOP_HOLD_MS)
    expect(sent).toHaveLength(1)
  })

  it('推过一次「完成了」之后,主人没再敲字 → 后续 Stop 都不推;敲一句就重新算', async () => {
    const { hub, sent } = harness()
    expect(hub.ingest(ev())).toBe('scheduled')          // 没见过 prompt:按长任务推
    await vi.advanceTimersByTimeAsync(STOP_HOLD_MS)
    expect(sent).toHaveLength(1)
    expect(hub.ingest(ev({ text: '又停了一次' }))).toBe('noop')
    await vi.advanceTimersByTimeAsync(STOP_HOLD_MS)
    expect(sent).toHaveLength(1)
    hub.ingest(ev({ kind: 'prompt' }))
    await vi.advanceTimersByTimeAsync(MIN_TURN_MS)
    expect(hub.ingest(ev({ text: '这回是新的' }))).toBe('scheduled')
    await vi.advanceTimersByTimeAsync(STOP_HOLD_MS)
    expect(sent).toHaveLength(2)
  })

  it('presence:没见过 prompt → unknown;PRESENT_WINDOW_MS 内 → present;之后 → away;session_end 清掉', async () => {
    const { hub } = harness()
    expect(hub.presence('s')).toBe('unknown')
    hub.ingest(ev({ session_id: 's', kind: 'prompt' }))
    expect(hub.presence('s')).toBe('present')
    await vi.advanceTimersByTimeAsync(PRESENT_WINDOW_MS)
    expect(hub.presence('s')).toBe('away')
    hub.ingest(ev({ session_id: 's', kind: 'session_end' }))
    expect(hub.presence('s')).toBe('unknown')
  })

  it('notePermissionRelay 之后 RELAY_SUPPRESS_MS 内的 permission 提醒 → noop;过了照推', async () => {
    const { hub, sent } = harness()
    hub.notePermissionRelay('s')
    expect(hub.ingest(ev({ session_id: 's', kind: 'permission', text: 'Bash: x' }))).toBe('noop')
    await vi.advanceTimersByTimeAsync(RELAY_SUPPRESS_MS)
    expect(hub.ingest(ev({ session_id: 's', kind: 'permission', text: 'Bash: x' }))).toBe('scheduled')
    await vi.advanceTimersByTimeAsync(PERMISSION_HOLD_MS)
    expect(sent).toHaveLength(1)
  })
})

describe('automated prompt(harness 自己塞的,不算主人回来)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })
  it('不撤待发、不刷在场、不重置「已推过」', async () => {
    const { hub, sent } = harness()
    hub.ingest(ev())
    expect(hub.ingest(ev({ kind: 'prompt', automated: true }))).toBe('noop')
    expect(hub.pending()).toHaveLength(1)
    expect(hub.presence(ev().session_id)).toBe('unknown')
    await vi.advanceTimersByTimeAsync(STOP_HOLD_MS)
    expect(sent).toHaveLength(1)
    hub.ingest(ev({ kind: 'prompt', automated: true }))
    expect(hub.ingest(ev({ text: '循环 tick 又停了' }))).toBe('noop')
  })
})
