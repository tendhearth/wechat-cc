import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  makeCliEventHub, formatCliPush, makeProjectNamer, summarizeOneLine, stripMarkdown,
  STOP_HOLD_MS, PERMISSION_HOLD_MS, MAX_TRACKED_SESSIONS, MIN_TURN_MS, PRESENT_WINDOW_MS, RELAY_SUPPRESS_MS,
  DIGEST_WINDOW_MS, INLINE_MAX, PRESENT_IDLE_S, IDLE_FRESH_MS, type CliEvent,
} from './cli-events'

const ev = (over: Partial<CliEvent> = {}): CliEvent => ({
  source: 'claude', kind: 'stop', session_id: 'a1b2c3d4-0000', cwd: '/home/u/work/wechat-cc', text: '搞定了', ...over,
})

function harness(opts: {
  sendResult?: boolean; sendThrows?: boolean; idle?: number | null; desktop?: boolean; sharePage?: boolean; localMachine?: string
} = {}) {
  const sent: string[] = []
  const desktop: { title: string; body: string }[] = []
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
    ...(opts.idle !== undefined ? { machineIdle: async () => opts.idle ?? null } : {}),
    ...(opts.desktop ? { notifyDesktop: async (title, body) => { desktop.push({ title, body }); return true } } : {}),
    ...(opts.sharePage ? { sharePage: async () => 'https://x/docs/abc' } : {}),
    ...(opts.localMachine ? { localMachine: opts.localMachine } : {}),
  })
  return { hub, sent, desktop, logs, send }
}

/** Stop 压满 + 合并窗到点。 */
const settle = async () => { await vi.advanceTimersByTimeAsync(STOP_HOLD_MS); await vi.advanceTimersByTimeAsync(DIGEST_WINDOW_MS) }

describe('CliEventHub 压 / 撤 / 清(spec 2026-09-09-cli-hook-push §5)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('stop → scheduled;压满 STOP_HOLD_MS 进合并窗,再 DIGEST_WINDOW_MS 才发一条', async () => {
    const { hub, sent } = harness()
    expect(hub.ingest(ev())).toBe('scheduled')
    await vi.advanceTimersByTimeAsync(STOP_HOLD_MS - 1)
    expect(sent).toEqual([])
    await vi.advanceTimersByTimeAsync(1 + DIGEST_WINDOW_MS - 1)
    expect(sent).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toBe('🔔 claude 完成了 · wechat-cc · 会话 a1b2c3\n搞定了')
    expect(hub.pending()).toEqual([])
  })

  it('stop 后同会话来 prompt → cancelled,不发;别的会话不受影响', async () => {
    const { hub, sent } = harness()
    hub.ingest(ev())
    hub.ingest(ev({ session_id: 'other-session', text: '另一件事' }))
    expect(hub.ingest(ev({ kind: 'prompt', text: undefined }))).toBe('cancelled')
    await settle()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('另一件事')
  })

  it('prompt 没有待发 → noop', () => {
    expect(harness().hub.ingest(ev({ kind: 'prompt' }))).toBe('noop')
  })

  it('permission 压 PERMISSION_HOLD_MS;期间同会话 stop 把它替换掉(权限那条不发)', async () => {
    const { hub, sent } = harness()
    expect(hub.ingest(ev({ source: 'codex', kind: 'permission', text: 'Bash: rm -rf ./tmp' }))).toBe('scheduled')
    await vi.advanceTimersByTimeAsync(PERMISSION_HOLD_MS - 1)
    expect(hub.ingest(ev({ source: 'codex', kind: 'stop', text: '删完了' }))).toBe('scheduled')
    await settle()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('codex 完成了')
    expect(sent[0]).not.toContain('等你批准')
  })

  it('permission 单独压满 → 发「等你批准」', async () => {
    const { hub, sent } = harness()
    hub.ingest(ev({ source: 'codex', kind: 'permission', text: 'Bash: rm -rf ./tmp' }))
    await vi.advanceTimersByTimeAsync(PERMISSION_HOLD_MS + DIGEST_WINDOW_MS)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('codex 等你批准')
    expect(sent[0]).toContain('Bash: rm -rf ./tmp')
  })

  it('session_end 清掉待发 → cleared;没有待发 → noop', async () => {
    const { hub, sent } = harness()
    hub.ingest(ev())
    expect(hub.ingest(ev({ kind: 'session_end' }))).toBe('cleared')
    expect(hub.ingest(ev({ kind: 'session_end' }))).toBe('noop')
    await settle()
    expect(sent).toEqual([])
  })

  it('send 返回 false → 记日志、不抛;send 抛错 → 记日志、不抛、不重试', async () => {
    const a = harness({ sendResult: false })
    a.hub.ingest(ev())
    await settle()
    expect(a.logs.some(l => l.startsWith('CLI_PUSH') && l.includes('dropped'))).toBe(true)

    const b = harness({ sendThrows: true })
    b.hub.ingest(ev())
    await settle(); await settle()
    expect(b.send).toHaveBeenCalledTimes(1)
    expect(b.logs.some(l => l.startsWith('CLI_PUSH') && l.includes('ilink down'))).toBe(true)
  })

  it('最多跟踪 MAX_TRACKED_SESSIONS 个待发,超出丢最旧的(它不发)', async () => {
    const { hub, sent } = harness()
    for (let i = 0; i <= MAX_TRACKED_SESSIONS; i++) {
      hub.ingest(ev({ session_id: `s-${i}`, text: `t${i}` }))
      await vi.advanceTimersByTimeAsync(1)
    }
    expect(hub.pending()).toHaveLength(MAX_TRACKED_SESSIONS)
    expect(hub.pending().map(p => p.session_id)).not.toContain('s-0')
    await settle()
    const all = sent.join('\n')
    expect(all).not.toMatch(/\nt0(\n|$)/)
    expect(all).toContain('t1\n')
  })

  it('dispose 清掉所有定时器与合并窗', async () => {
    const { hub, sent } = harness()
    hub.ingest(ev())
    hub.dispose()
    await settle()
    expect(sent).toEqual([])
    expect(hub.pending()).toEqual([])
  })
})

describe('在场判断与「一次敲字最多推一条」', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-09T10:00:00Z')) })
  afterEach(() => { vi.useRealTimers() })

  it('prompt 后不到 MIN_TURN_MS 就 Stop → 快问快答,不推;超过才推', async () => {
    const { hub, sent } = harness()
    hub.ingest(ev({ kind: 'prompt' }))
    await vi.advanceTimersByTimeAsync(MIN_TURN_MS - 1000)
    expect(hub.ingest(ev())).toBe('noop')
    await settle()
    expect(sent).toEqual([])
    hub.ingest(ev({ kind: 'prompt' }))
    await vi.advanceTimersByTimeAsync(MIN_TURN_MS)
    expect(hub.ingest(ev())).toBe('scheduled')
    await settle()
    expect(sent).toHaveLength(1)
  })

  it('推过一次「完成了」之后,主人没再敲字 → 后续 Stop 都不推;敲一句就重新算', async () => {
    const { hub, sent } = harness()
    expect(hub.ingest(ev())).toBe('scheduled')
    await settle()
    expect(sent).toHaveLength(1)
    expect(hub.ingest(ev({ text: '又停了一次' }))).toBe('noop')
    await settle()
    expect(sent).toHaveLength(1)
    hub.ingest(ev({ kind: 'prompt' }))
    await vi.advanceTimersByTimeAsync(MIN_TURN_MS)
    expect(hub.ingest(ev({ text: '这回是新的' }))).toBe('scheduled')
    await settle()
    expect(sent).toHaveLength(2)
  })

  it('automated prompt:不撤待发、不刷在场、不重置「已推过」', async () => {
    const { hub, sent } = harness()
    hub.ingest(ev())
    expect(hub.ingest(ev({ kind: 'prompt', automated: true }))).toBe('noop')
    expect(hub.pending()).toHaveLength(1)
    expect(await hub.presence(ev().session_id)).toBe('unknown')
    await settle()
    expect(sent).toHaveLength(1)
    hub.ingest(ev({ kind: 'prompt', automated: true }))
    expect(hub.ingest(ev({ text: '循环 tick 又停了' }))).toBe('noop')
  })

  it('presence 副信号:没见过 prompt → unknown;PRESENT_WINDOW_MS 内 → present;之后 → away;session_end 清掉', async () => {
    const { hub } = harness()
    expect(await hub.presence('s')).toBe('unknown')
    hub.ingest(ev({ session_id: 's', kind: 'prompt' }))
    expect(await hub.presence('s')).toBe('present')
    await vi.advanceTimersByTimeAsync(PRESENT_WINDOW_MS)
    expect(await hub.presence('s')).toBe('away')
    hub.ingest(ev({ session_id: 's', kind: 'session_end' }))
    expect(await hub.presence('s')).toBe('unknown')
  })

  it('presence 主信号:传入的空闲秒数 > 事件里新鲜的 idle_s > 本机探针 > 敲字;过期的 idle_s 不算', async () => {
    const { hub } = harness({ idle: 600 })
    hub.ingest(ev({ session_id: 's', kind: 'prompt', idle_s: 5 }))
    expect(await hub.presence('s')).toBe('present')            // 事件带的 5s,新鲜
    expect(await hub.presence('s', 999)).toBe('away')          // 传入的优先
    await vi.advanceTimersByTimeAsync(IDLE_FRESH_MS)
    expect(await hub.presence('s')).toBe('away')               // idle_s 过期 → 本机探针 600s
    const b = harness()
    b.hub.ingest(ev({ session_id: 's', kind: 'prompt' }))
    expect(await b.hub.presence('s')).toBe('present')          // 没探针 → 敲字
  })

  it('notePermissionRelay 之后 RELAY_SUPPRESS_MS 内的 permission 提醒 → noop;过了照推', async () => {
    const { hub, sent } = harness()
    hub.notePermissionRelay('s')
    expect(hub.ingest(ev({ session_id: 's', kind: 'permission', text: 'Bash: x' }))).toBe('noop')
    await vi.advanceTimersByTimeAsync(RELAY_SUPPRESS_MS)
    expect(hub.ingest(ev({ session_id: 's', kind: 'permission', text: 'Bash: x' }))).toBe('scheduled')
    await vi.advanceTimersByTimeAsync(PERMISSION_HOLD_MS + DIGEST_WINDOW_MS)
    expect(sent).toHaveLength(1)
  })
})

describe('发到哪个面(人在电脑前 → 桌面;机器空闲 → 微信)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('发送时刻本机空闲 < PRESENT_IDLE_S → 桌面通知,不进微信;之后同会话 Stop 也算「已推过」', async () => {
    const { hub, sent, desktop } = harness({ idle: PRESENT_IDLE_S - 1, desktop: true })
    hub.ingest(ev({ text: '**粗体** 第一行\n\n- 点一\n- 点二' }))
    await settle()
    expect(sent).toEqual([])
    expect(desktop).toEqual([{ title: '🔔 claude 完成了 · wechat-cc · 会话 a1b2c3', body: '粗体 第一行 · 点一 · 点二' }])
    expect(hub.ingest(ev())).toBe('noop')
  })

  it('在场但没有桌面面 → 干脆不发(人就在终端前)', async () => {
    const { hub, sent, logs } = harness({ idle: 10 })
    hub.ingest(ev())
    await settle()
    expect(sent).toEqual([])
    expect(logs.some(l => l.includes('skip claude/stop') && l.includes('idle 10s'))).toBe(true)
  })

  it('机器空闲 ≥ PRESENT_IDLE_S → 微信;那边的会话用事件里的 idle_s,标题写「那边」', async () => {
    const a = harness({ idle: PRESENT_IDLE_S, desktop: true })
    a.hub.ingest(ev())
    await settle()
    expect(a.sent).toHaveLength(1)
    expect(a.desktop).toEqual([])

    const b = harness({ idle: 5, desktop: true, localMachine: 'mac-here' })
    b.hub.ingest(ev({ machine: 'win-test', idle_s: 900 }))
    await settle()
    expect(b.sent).toHaveLength(1)
    expect(b.sent[0]).toContain('🔔 claude 完成了 · 那边(win-test) · wechat-cc · 会话 a1b2c3')
    expect(b.desktop).toEqual([])
  })

  it('DIGEST_WINDOW_MS 内多条会话完成 → 合成一条', async () => {
    const { hub, sent } = harness()
    hub.ingest(ev({ session_id: 'aaaaaa', text: '甲' }))
    await vi.advanceTimersByTimeAsync(5000)
    hub.ingest(ev({ session_id: 'bbbbbb', text: '乙' }))
    await vi.advanceTimersByTimeAsync(STOP_HOLD_MS + DIGEST_WINDOW_MS)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('会话 aaaaaa\n甲')
    expect(sent[0]).toContain('— — —')
    expect(sent[0]).toContain('会话 bbbbbb\n乙')
  })

  it('超过 INLINE_MAX 的最后一句:截断 + 全文链接(没有 sharePage 就只截断)', async () => {
    const long = 'x'.repeat(INLINE_MAX + 50)
    const a = harness({ sharePage: true })
    a.hub.ingest(ev({ text: long }))
    await settle()
    expect(a.sent[0]).toContain('全文:https://x/docs/abc')
    expect(a.sent[0]!.length).toBeLessThan(INLINE_MAX + 120)
    const b = harness()
    b.hub.ingest(ev({ text: long }))
    await settle()
    expect(b.sent[0]).not.toContain('全文')
    expect(b.sent[0]!.endsWith('…')).toBe(true)
  })
})

describe('会话登记(「看 码」「@码」按前缀找)', () => {
  it('lookup 前缀、最近的优先;sessions 按最近排序;session_end 删掉', () => {
    vi.useFakeTimers()
    try {
      const { hub } = harness()
      hub.ingest(ev({ session_id: 'abc111', kind: 'prompt', transcript_path: '/t/1.jsonl', machine: 'm1' }))
      vi.advanceTimersByTime(10)
      hub.ingest(ev({ session_id: 'abc222', kind: 'prompt', source: 'codex' }))
      expect(hub.lookup('abc1')?.transcript_path).toBe('/t/1.jsonl')
      expect(hub.lookup('abc1')?.machine).toBe('m1')
      expect(hub.lookup('abc')?.session_id).toBe('abc222')
      expect(hub.lookup('zzz')).toBeNull()
      expect(hub.lookup('')).toBeNull()
      expect(hub.sessions().map(s => s.session_id)).toEqual(['abc222', 'abc111'])
      hub.ingest(ev({ session_id: 'abc222', kind: 'session_end' }))
      expect(hub.lookup('abc')?.session_id).toBe('abc111')
    } finally { vi.useRealTimers() }
  })
})

describe('措辞', () => {
  it('stop:完整最后一句去 markdown,保留换行', () => {
    const s = formatCliPush(ev({ text: '## 结果\n\n**代码**:`feat/x` 四个提交\n- 一\n- 二\n\n\n看 [PR](https://g/1)' }), 'wechat-cc')
    expect(s).toBe('🔔 claude 完成了 · wechat-cc · 会话 a1b2c3\n结果\n\n代码:feat/x 四个提交\n· 一\n· 二\n\n看 PR (https://g/1)')
  })
  it('stop 没留最后一句 → 只有标题行', () => {
    expect(formatCliPush(ev({ text: undefined }), 'wechat-cc')).toBe('🔔 claude 完成了 · wechat-cc · 会话 a1b2c3')
  })
  it('permission:等你批准 + 工具摘要 + 回终端提示', () => {
    const s = formatCliPush(ev({ source: 'codex', kind: 'permission', session_id: '9f0e1d22', text: 'Bash: rm -rf ./tmp' }), 'tendhearth')
    expect(s).toBe('✋ codex 等你批准 · tendhearth · 会话 9f0e1d\nBash: rm -rf ./tmp\n(回终端处理;这一类微信里暂时答不了)')
  })
  it('summarizeOneLine 压空白、截到上限加省略号;stripMarkdown 不吃普通星号乘法', () => {
    expect(summarizeOneLine(' a \n b\t\tc ')).toBe('a b c')
    expect(summarizeOneLine('x'.repeat(200), 120)).toBe('x'.repeat(119) + '…')
    expect(stripMarkdown('2 * 3 = 6')).toBe('2 * 3 = 6')
    expect(stripMarkdown('```ts\nconst a = 1\n```')).toBe('const a = 1')
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
