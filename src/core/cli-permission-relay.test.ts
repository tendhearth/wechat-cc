import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeCliPermissionRelay, formatCliPermissionPrompt, CLI_PERMISSION_WAIT_MS, type CliPermissionRequest } from './cli-permission-relay'

const req = (over: Partial<CliPermissionRequest> = {}): CliPermissionRequest => ({
  source: 'claude', session_id: 'abc123-xyz', cwd: '/w/wechat-cc', tool_name: 'Bash', summary: 'rm -rf ./tmp', ...over,
})

function harness(opts: { presence?: 'present' | 'away' | 'unknown'; answer?: 'allow' | 'deny' | 'timeout' | 'undelivered'; answerAfterMs?: number } = {}) {
  const asked: { prompt: string; hash: string; timeoutMs: number }[] = []
  const relayed: string[] = []
  const logs: string[] = []
  const ask = vi.fn((prompt: string, hash: string, timeoutMs: number) => {
    asked.push({ prompt, hash, timeoutMs })
    return new Promise<'allow' | 'deny' | 'timeout' | 'undelivered'>((resolve) => {
      setTimeout(() => resolve(opts.answer ?? 'allow'), opts.answerAfterMs ?? 1000)
    })
  })
  const relay = makeCliPermissionRelay({
    ask,
    presence: async () => opts.presence ?? 'away',
    projectName: (cwd) => cwd.split('/').pop() ?? cwd,
    onRelayed: (s) => relayed.push(s),
    log: (t, l) => logs.push(`${t} ${l}`),
  })
  return { relay, asked, relayed, logs, ask }
}

describe('CliPermissionRelay(spec 2026-09-09-cli-hook-push §6.3)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('主人在场 → owner_present,不去微信问', async () => {
    const { relay, ask } = harness({ presence: 'present' })
    expect(await relay.open(req())).toEqual({ status: 'owner_present' })
    expect(ask).not.toHaveBeenCalled()
  })

  it('不在场 / 不知道 → 发卡片,回 5 位码;pending → 答 allow 后 status=allow;onRelayed 记一笔', async () => {
    const { relay, asked, relayed } = harness({ presence: 'unknown', answer: 'allow' })
    const r = await relay.open(req())
    expect(r.status).toBe('pending')
    const hash = (r as { hash: string }).hash
    expect(hash).toMatch(/^[a-z0-9]{5}$/)
    expect(asked[0]!.timeoutMs).toBe(CLI_PERMISSION_WAIT_MS)
    expect(asked[0]!.prompt).toContain('claude 等你批准 · wechat-cc · 会话 abc123')
    expect(asked[0]!.prompt).toContain('Bash: rm -rf ./tmp')
    // 「怎么回」那一行由 ilink-glue.askUser 统一加(两位数码在那里分配),relay 的文案只说过期后会怎样。
    expect(asked[0]!.prompt).not.toContain(`y ${hash}`)
    expect(asked[0]!.prompt).toContain('过期终端自己会问')
    expect(relay.status(hash)).toBe('pending')
    await vi.advanceTimersByTimeAsync(1000)
    expect(relay.status(hash)).toBe('allow')
    expect(relayed).toEqual(['abc123-xyz'])
  })

  it('wait:状态一变就返回;到时限还没变就返回 pending', async () => {
    const { relay } = harness({ answer: 'deny', answerAfterMs: 5000 })
    const { hash } = await relay.open(req()) as { hash: string }
    const early = relay.wait(hash, 2000)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await early).toBe('pending')
    const late = relay.wait(hash, 10_000)
    await vi.advanceTimersByTimeAsync(3000)
    expect(await late).toBe('deny')
  })

  it('timeout / undelivered 原样透出;不认识的 hash → unknown;ask 抛错 → undelivered', async () => {
    const a = harness({ answer: 'timeout' })
    const { hash } = await a.relay.open(req()) as { hash: string }
    await vi.advanceTimersByTimeAsync(1000)
    expect(a.relay.status(hash)).toBe('timeout')
    expect(a.relay.status('zzzzz')).toBe('unknown')

    const b = harness()
    b.ask.mockImplementationOnce(() => Promise.reject(new Error('ilink down')))
    const { hash: h2 } = await b.relay.open(req()) as { hash: string }
    await vi.advanceTimersByTimeAsync(0)
    expect(b.relay.status(h2)).toBe('undelivered')
    expect(b.logs.some(l => l.includes('ilink down'))).toBe(true)
  })

  it('已决的条目保留一段时间供轮询,之后清掉;dispose 全清', async () => {
    const { relay } = harness({ answer: 'allow' })
    const { hash } = await relay.open(req()) as { hash: string }
    await vi.advanceTimersByTimeAsync(1000)
    expect(relay.status(hash)).toBe('allow')
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(relay.status(hash)).toBe('unknown')
    const { hash: h2 } = await relay.open(req()) as { hash: string }
    relay.dispose()
    expect(relay.status(h2)).toBe('unknown')
  })
})

describe('formatCliPermissionPrompt', () => {
  it('四要素 + 怎么回;那边的会话写机器名', () => {
    expect(formatCliPermissionPrompt(req({ source: 'codex', session_id: '9f0e1d22' }), 'tendhearth', 'k3x9z', 120_000))
      .toBe('✋ codex 等你批准 · tendhearth · 会话 9f0e1d\nBash: rm -rf ./tmp\n过期终端自己会问。')
    expect(formatCliPermissionPrompt(req({ machine: 'win-test' }), 'p', 'k3x9z', 1000, 'mac-here')).toContain('等你批准 · 那边(win-test) · p')
    expect(formatCliPermissionPrompt(req({ machine: 'mac-here' }), 'p', 'k3x9z', 1000, 'mac-here')).not.toContain('那边')
  })
  it('open 把请求里的 idle_s 交给 presence', async () => {
    const presence = vi.fn(async (_s: string, idle?: number | null) => (idle ?? 999) < 120 ? 'present' as const : 'away' as const)
    const relay = makeCliPermissionRelay({ ask: async () => 'timeout', presence, projectName: (c) => c, onRelayed: () => {}, log: () => {} })
    expect(await relay.open(req({ idle_s: 3 }))).toEqual({ status: 'owner_present' })
    expect((await relay.open(req({ idle_s: 900 }))).status).toBe('pending')
  })
})
