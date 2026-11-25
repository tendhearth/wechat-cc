import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { openFirstUseProbeRecords } from '../daemon/bootstrap/first-use-probe-records'
import { firstUseProbeTimeout, probeEndpointKey, probeStatusNote, withFirstUseProbe } from './first-use-probe'
import { collectTurn, type AgentEvent, type AgentProvider } from '../ports/agent-provider'
import { errorWithProviderCode } from '../lib/provider-error-code'
import { withNetworkGate } from './provider-registry'
import type { NetworkGate } from '../lib/network-gate'

function inner(): AgentProvider & { spawns: number } {
  const p = {
    spawns: 0,
    async spawn() { p.spawns++; return { dispatch: async function* () {}, close: async () => {} } as never },
    async cheapEval(prompt: string) { return `echo:${prompt}` },
  }
  return p as never
}
const ctx = { tierProfile: {} as never, permissionMode: 'strict' as const, chatId: 'c' }

describe('withFirstUseProbe', () => {
  it('keys an endpoint by scheme, host and path without URL credentials or query parameters', () => {
    const baseUrl = 'https://gateway.example/v1'
    const key = probeEndpointKey({ baseUrl })
    expect(key).toMatch(/^[a-f0-9]{64}$/)
    expect(probeEndpointKey({ baseUrl: 'https://fixture:password@gateway.example/v1/?token=fixture#secret' })).toBe(key)
    expect(probeEndpointKey({ baseUrl: 'https://gateway.example/v2' })).not.toBe(key)
  })
  it('probes once on first spawn, then passes through; concurrent first spawns share one probe', async () => {
    const probe = vi.fn(async () => 'ok')
    const results: unknown[] = []
    const p = withFirstUseProbe(inner(), { probe, failureMessage: d => `bad: ${d}`, onResult: r => results.push(r) })
    expect(p.probeStatus().state).toBe('untested')
    await Promise.all([p.spawn({ alias: 'a', path: '/p' }, ctx), p.spawn({ alias: 'a', path: '/p' }, ctx)])
    await p.spawn({ alias: 'a', path: '/p' }, ctx)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(p.probeStatus().state).toBe('ok')
    expect(results).toEqual([expect.objectContaining({ ok: true, detail: 'ok' })])
  })
  it('empty reply = failure (the silent-mismatch symptom); spawn throws the human message; retry only after the window', async () => {
    let t = 0
    const probe = vi.fn(async () => '')
    const p = withFirstUseProbe(inner(), { probe, failureMessage: d => `codex 不可用:${d}`, retryAfterMs: 1000, now: () => t })
    await expect(p.spawn({ alias: 'a', path: '/p' }, ctx)).rejects.toThrow('codex 不可用:探测拿到了空回复')
    expect(p.probeStatus().state).toBe('failed')
    await expect(p.spawn({ alias: 'a', path: '/p' }, ctx)).rejects.toThrow('codex 不可用')
    expect(probe).toHaveBeenCalledTimes(1)          // inside the window: no re-probe
    t = 2000
    probe.mockResolvedValueOnce('ok')
    await p.spawn({ alias: 'a', path: '/p' }, ctx)  // window passed: re-probe, now healthy
    expect(probe).toHaveBeenCalledTimes(2)
    expect(p.probeStatus().state).toBe('ok')
  })
  it('a throwing probe surfaces its message; cheapEval is gated by the same probe', async () => {
    const p = withFirstUseProbe(inner(), { probe: async () => { throw new Error('400 requires a newer version of Codex') }, failureMessage: d => `codex:${d}` })
    await expect(p.cheapEval!('x')).rejects.toThrow('requires a newer version of Codex')
    expect(p.probeStatus()).toMatchObject({ state: 'failed', detail: expect.stringContaining('newer version') })
  })
  it('retries a 529 overloaded probe on demand after 30 seconds', async () => {
    let t = 0
    const probe = vi.fn(async () => 'ok').mockRejectedValueOnce(new Error('API Error: 529 overloaded'))
    const p = withFirstUseProbe(inner(), { probe, failureMessage: d => d, now: () => t })
    const spawn = () => p.spawn({ alias: 'a', path: '/p' }, ctx)

    await expect(spawn()).rejects.toThrow('529')
    t = 29_999
    await expect(spawn()).rejects.toThrow('529')
    expect(probe).toHaveBeenCalledTimes(1)
    t = 30_001
    expect(probe).toHaveBeenCalledTimes(1)
    await spawn()
    expect(probe).toHaveBeenCalledTimes(2)
    expect(p.probeStatus().state).toBe('ok')
  })
  it('doubles successive transient delays up to ten minutes and stops probing once it recovers', async () => {
    let t = 0
    const probe = vi.fn(async (): Promise<string> => { throw new Error('API Error: 529 overloaded') })
    const onResult = vi.fn()
    const p = withFirstUseProbe(inner(), {
      probe, now: () => t, onResult, failureMessage: (_, failure) => failure.reason,
    })
    const spawn = () => p.spawn({ alias: 'a', path: '/p' }, ctx)
    for (const [attempt, delay] of [30, 60, 120, 240, 480, 600, 600].entries()) {
      await expect(spawn()).rejects.toThrow('暂时忙不过来（529）')
      expect(p.probeStatus()).toMatchObject({ state: 'failed', kind: 'transient', at: t, retryAt: t + delay * 1000 })
      t += delay * 1000 - 1
      await expect(spawn()).rejects.toThrow('暂时忙不过来（529）')
      expect(probe).toHaveBeenCalledTimes(attempt + 1)
      expect(onResult).toHaveBeenCalledTimes(attempt + 1)
      t++
    }
    probe.mockResolvedValueOnce('ok')
    await Promise.all([spawn(), spawn()])
    expect(p.probeStatus()).toEqual({ state: 'ok', source: 'probe', detail: 'ok', at: t })
    t += 600_000
    await spawn()
    expect(probe).toHaveBeenCalledTimes(8)
  })

  it.each([
    { error: new Error('HTTP error: 401 Unauthorized'), kind: 'auth', reason: '拒绝了凭证（401）', wait: 600_000 },
    { error: errorWithProviderCode('credential failed', 'auth_rejected'), kind: 'auth', reason: '拒绝了凭证（认证）', wait: 600_000 },
    { error: new Error('model not found'), kind: 'incompatible', reason: '探测失败', wait: 600_000 },
    { error: new Error('API Error: 503 Service Unavailable'), kind: 'transient', reason: '暂时忙不过来（503）', wait: 30_000 },
    { error: new Error('unexpected status 429'), kind: 'transient', reason: '暂时限流（429）', wait: 30_000 },
    { error: new Error('rate limit exceeded'), kind: 'transient', reason: '暂时忙不过来（rate_limit）', wait: 30_000 },
    { error: new Error('unable to connect'), kind: 'transient', reason: '暂时连不上（网络）', wait: 30_000 },
    { error: new Error('authentication failed or timed out'), kind: 'transient', reason: '请求超时（timeout）', wait: 30_000 },
    { error: new Error('unexpected failure'), kind: 'transient', reason: '暂时没有回应（原因未明）', wait: 30_000 },
    { error: errorWithProviderCode('billing error', 'quota'), kind: 'quota', reason: '额度用完了', wait: 3_600_000 },
    { error: errorWithProviderCode('Claude AI usage limit reached|1800000120', 'quota'), kind: 'quota', reason: '额度用完了', wait: 120_000, now: 1_800_000_000_000 },
    { error: new Error('Claude AI usage limit reached|1800000120'), kind: 'quota', reason: '额度用完了', wait: 120_000, now: 1_800_000_000_000 },
    { error: errorWithProviderCode('unexpected status 429: insufficient_quota', 'rate_limited'), kind: 'quota', reason: '额度用完了', wait: 3_600_000 },
  ])('uses $kind for $error with a $wait ms cooldown', async ({ error, kind, reason, wait, now = 0 }) => {
    let t = now
    // 同步抛错也会释放 in-flight，下一次可以重探。
    const probe = vi.fn((): Promise<string> => { throw error })
    const p = withFirstUseProbe(inner(), { probe, now: () => t, failureMessage: (_, failure) => failure.reason })
    const spawn = () => p.spawn({ alias: 'a', path: '/p' }, ctx)
    await expect(spawn()).rejects.toThrow(reason)
    expect(p.probeStatus()).toMatchObject({ state: 'failed', kind, retryAt: now + wait })
    t = now + wait - 1
    await expect(spawn()).rejects.toThrow(reason)
    expect(probe).toHaveBeenCalledTimes(1)
    t = now + wait
    probe.mockResolvedValueOnce('ok')
    await spawn()
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('treats a blank reply as a protocol failure for ten minutes by default', async () => {
    let t = 0
    const probe = vi.fn(async () => '  ')
    const p = withFirstUseProbe(inner(), { probe, now: () => t, failureMessage: d => d })
    const spawn = () => p.spawn({ alias: 'a', path: '/p' }, ctx)
    await expect(spawn()).rejects.toThrow('协议不合')
    expect(p.probeStatus()).toMatchObject({ state: 'failed', kind: 'incompatible', retryAt: 600_000 })
    t = 599_999
    await expect(spawn()).rejects.toThrow('协议不合')
    expect(probe).toHaveBeenCalledTimes(1)
    t = 600_000
    probe.mockResolvedValueOnce('ok')
    await spawn()
    expect(probe).toHaveBeenCalledTimes(2)
  })
})

describe('gate: spawn', () => {
  it('opens an isolated checkup even if the selected chat model fails its probe', async () => {
    const probe = vi.fn(async () => { throw new Error('API Error: 529 overloaded') })
    const p = inner()
    const wrapped = withFirstUseProbe(p, { probe, gate: 'spawn', failureMessage: d => d })
    const project = { alias: 'checkup', path: '/isolated-checkup' }
    const evaluation = { tools: {} as never, mcpServer: { url: 'http://127.0.0.1:9' }, maxSteps: 3, maxOutputTokens: 4096 }
    await wrapped.spawn(project, { ...ctx, model: 'checkup-model', evaluation })
    expect(p.spawns).toBe(1)
    expect(probe).not.toHaveBeenCalled()
  })
  it('leaves cheapEval ungated (default provider: background evals must not add a boot-time outbound call)', async () => {
    const probe = vi.fn(async () => 'ok')
    const p = withFirstUseProbe(inner(), { probe, gate: 'spawn', failureMessage: d => d })
    await p.cheapEval!('x')
    expect(probe).not.toHaveBeenCalled()
    await p.spawn({ alias: 'a', path: '/p' }, ctx)
    expect(probe).toHaveBeenCalledTimes(1)
  })
})

describe('persistent first-use probe', () => {
  const project = { alias: 'a', path: '/p' }
  const combination = { cliVersion: '1.2.3', sdkVersion: '2.3.4', model: 'default-model' }
  const previous = { ...combination, at: 1000 }
  const other = { ...previous, model: 'other-model' }
  const completed: AgentEvent = { kind: 'result', sessionId: 's', numTurns: 1, durationMs: 1 }
  const reply: AgentEvent = { kind: 'text', text: '收到' }

  async function withRecords(run: (dir: string, path: string) => Promise<void>) {
    const dir = mkdtempSync(join(tmpdir(), 'first-use-probes-'))
    try { await run(dir, join(dir, 'first-use-probes.json')) }
    finally { rmSync(dir, { recursive: true, force: true }) }
  }

  function setup(dir: string, current = combination) {
    let at = 2000
    let events: AgentEvent[] = [reply, completed]
    const probe = vi.fn(async (_model?: string) => 'ok')
    const history = openFirstUseProbeRecords(dir, () => { throw new Error('fixture write failed') })('claude')
    const save = vi.spyOn(history, 'save')
    const provider = inner()
    provider.spawn = async () => ({
      async *dispatch() { yield* events },
      async close() {},
    })
    const wrapped = withFirstUseProbe(provider, {
      probe, failureMessage: d => d, now: () => at,
      cache: { combination: () => current, history },
    })
    return {
      spawn: (model?: string) => wrapped.spawn(project, { ...ctx, model }), probe, save,
      status: wrapped.probeStatus,
      setEvents: (...next: AgentEvent[]) => { events = next },
      setTime: (next: number) => { at = next },
    }
  }

  it('passes through on the same combination without calling the probe', async () => withRecords(async (dir, path) => {
    writeFileSync(path, JSON.stringify({ claude: previous }))
    const fixture = setup(dir)
    await fixture.spawn()
    expect(fixture.probe).not.toHaveBeenCalled()
    expect(fixture.status()).toMatchObject({ state: 'ok', source: 'history', at: previous.at })
    expect(probeStatusNote(fixture.status())).toContain('沿用上次的结果（')
    expect(fixture.save).not.toHaveBeenCalled()
  }))

  it.each(['cliVersion', 'sdkVersion', 'model'] as const)('probes and updates the record when %s changes', async field => withRecords(async (dir, path) => {
    writeFileSync(path, JSON.stringify({ claude: previous, codex: other }))
    const current = { ...combination, [field]: 'different' }
    const fixture = setup(dir, current)
    await fixture.spawn()
    await fixture.spawn()
    expect(fixture.probe).toHaveBeenCalledExactlyOnceWith(current.model, expect.any(AbortSignal), project)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      claude: [...(field === 'model' ? [previous] : []), { ...current, at: 2000 }], codex: [other],
    })
    expect(probeStatusNote(fixture.status())).toBe('刚探测过 ✓')
  }))

  it.each(['{bad json', '{"claude":{"at":1000}}'])('rebuilds an unusable file (%s)', async contents => withRecords(async (dir, path) => {
    writeFileSync(path, contents)
    const fixture = setup(dir)
    await fixture.spawn()
    expect(fixture.probe).toHaveBeenCalledExactlyOnceWith(combination.model, expect.any(AbortSignal), project)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ claude: [{ ...combination, at: 2000 }] })
  }))

  it('records the first successful real turn once, keeping the reused timestamp in status', async () => withRecords(async (dir, path) => {
    writeFileSync(path, JSON.stringify({ claude: previous, codex: other }))
    const fixture = setup(dir)
    const session = await fixture.spawn()
    await collectTurn(session.dispatch('hello'))
    fixture.setTime(3000)
    await collectTurn(session.dispatch('again'))
    expect(fixture.save).toHaveBeenCalledExactlyOnceWith({ ...combination, at: 2000 })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ claude: [{ ...combination, at: 2000 }], codex: [other] })
    expect(fixture.status()).toMatchObject({ source: 'history', at: previous.at })
    expect(fixture.probe).not.toHaveBeenCalled()
  }))

  it.each([
    ['empty completed turn', [completed]],
    ['model not found', [{ kind: 'error', message: 'model not found', code: 'invalid_request' }]],
    ['protocol mismatch', [{ kind: 'error', message: 'protocol mismatch' }]],
    ['outdated client', [{ kind: 'error', message: "The 'm' model requires a newer version of Codex." }]],
  ] satisfies Array<[string, AgentEvent[]]>)('clears the record after %s and reprobes on the next dispatch of a retained session', async (_, events) => withRecords(async (dir, path) => {
    writeFileSync(path, JSON.stringify({ claude: previous, codex: other }))
    const fixture = setup(dir)
    const session = await fixture.spawn()
    fixture.setEvents(...events)
    await collectTurn(session.dispatch('hello'))
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ codex: [other] })
    expect(fixture.status()).toEqual({ state: 'untested' })
    expect(fixture.probe).not.toHaveBeenCalled()

    fixture.setEvents(reply, completed)
    await collectTurn(session.dispatch('next'))
    expect(fixture.probe).toHaveBeenCalledExactlyOnceWith(combination.model, expect.any(AbortSignal), project)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ claude: [{ ...combination, at: 2000 }], codex: [other] })
  }))

  it.each([
    { kind: 'error', message: 'API Error: 529 overloaded', code: 'server_error' },
    { kind: 'error', message: 'HTTP error: 401 Unauthorized', code: 'auth_rejected' },
    { kind: 'error', message: 'model not found', code: 'auth_rejected' },
    { kind: 'error', message: 'connection reset' },
  ] satisfies AgentEvent[])('leaves the record alone on $message ($code)', async event => withRecords(async (dir, path) => {
    writeFileSync(path, JSON.stringify({ claude: previous, codex: other }))
    const fixture = setup(dir)
    const session = await fixture.spawn()
    fixture.setEvents(event, completed)
    await collectTurn(session.dispatch('hello'))
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ claude: previous, codex: other })
    expect(fixture.status()).toMatchObject({ state: 'ok', source: 'history' })
    expect(fixture.save).not.toHaveBeenCalled()
    expect(fixture.probe).not.toHaveBeenCalled()
  }))

  it('opens pinned A during a failure and cooldown of default B', async () => withRecords(async (dir, path) => {
    const fixture = setup(dir)
    fixture.probe.mockImplementation(async model => {
      if (model === combination.model) throw new Error('API Error: 529 overloaded')
      return 'ok'
    })
    await expect(fixture.spawn()).rejects.toThrow('529')
    await fixture.spawn(other.model)
    await expect(fixture.spawn()).rejects.toThrow('529')
    expect(fixture.probe.mock.calls.map(([model]) => model)).toEqual([combination.model, other.model])
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ claude: [{ ...other, at: 2000 }] })
  }))

  it('clears only pinned A after incompatibility and reprobes A on its retained session', async () => withRecords(async (dir, path) => {
    writeFileSync(path, JSON.stringify({ claude: [previous, other] }))
    const fixture = setup(dir)
    const session = await fixture.spawn(other.model)
    fixture.setEvents({ kind: 'error', message: 'model not found' })
    await collectTurn(session.dispatch('hello'))
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ claude: [previous] })
    await fixture.spawn()
    expect(fixture.probe).not.toHaveBeenCalled()
    fixture.setEvents(reply, completed)
    await collectTurn(session.dispatch('next'))
    expect(fixture.probe).toHaveBeenCalledExactlyOnceWith(other.model, expect.any(AbortSignal), project)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ claude: [previous, { ...other, at: 2000 }] })
  }))

  it('suppresses a failed reprobe for a stopped retained session and shares it with the other waiter', async () => withRecords(async (dir, path) => {
    writeFileSync(path, JSON.stringify({ claude: previous }))
    const started = Promise.withResolvers<void>()
    const result = Promise.withResolvers<string>()
    const probe = vi.fn(() => { started.resolve(); return result.promise })
    let events: AgentEvent[] = [{ kind: 'error', message: 'model not found' }]
    const p = inner()
    p.spawn = async () => ({ async *dispatch() { yield* events }, async cancel() {}, async close() {} })
    const provider = withFirstUseProbe(p, {
      probe, cache: { combination: () => combination, history: openFirstUseProbeRecords(dir, () => {})('claude') },
      failureMessage: (_, failure) => failure.reason,
    })
    const stopped = await provider.spawn(project, ctx)
    const otherWaiter = await provider.spawn(project, ctx)
    await collectTurn(stopped.dispatch('invalidate'))
    events = [reply, completed]

    const stoppedTurn = stopped.dispatch('stopped')[Symbol.asyncIterator]().next()
    const otherTurn = otherWaiter.dispatch('still waiting')[Symbol.asyncIterator]().next()
    const stoppedCheck = expect(stoppedTurn).resolves.toMatchObject({ done: true })
    const otherCheck = expect(otherTurn).rejects.toThrow('暂时忙不过来（529）')
    await started.promise
    await stopped.cancel!()
    result.reject(new Error('API Error: 529 overloaded'))
    await Promise.all([stoppedCheck, otherCheck])
    expect(probe).toHaveBeenCalledTimes(1)
    expect(provider.probeStatus()).toMatchObject({ state: 'failed', kind: 'transient' })
  }))

  it('blocks the real dispatch if the guard goes down while a retained session is probing', async () => withRecords(async (dir, path) => {
    writeFileSync(path, JSON.stringify({ claude: previous }))
    const started = Promise.withResolvers<void>()
    const result = Promise.withResolvers<string>()
    const probe = () => { started.resolve(); return result.promise }
    let safe = true
    let sends = 0
    const p = inner()
    p.callTarget = () => ({ provider: 'claude', baseUrl: 'https://gateway.example' })
    const actual = { provider: 'claude', model: combination.model, baseUrl: 'https://api.anthropic.com', exact: true }
    p.spawn = async () => ({
      callTarget: () => actual,
      async *dispatch() { sends++; yield { kind: 'error', message: 'model not found' } },
      async close() {},
    })
    const gate: NetworkGate = { check: async () => ({ safe, source: 'bx', detail: 'fixture' }) }
    const provider = withNetworkGate(withFirstUseProbe(p, {
      probe, networkGate: gate, failureMessage: d => d,
      cache: { combination: () => combination, history: openFirstUseProbeRecords(dir, () => {})('claude') },
    }), gate, 'claude')
    const session = await provider.spawn(project, ctx)
    await collectTurn(session.dispatch('invalidate'))
    const pending = session.dispatch('owner turn')[Symbol.asyncIterator]().next()
    const blocked = expect(pending).rejects.toMatchObject({ code: 'network_unprotected' })
    await started.promise
    safe = false
    result.resolve('ok')
    await blocked
    expect(sends).toBe(1)
  }))

  it('aborts a stuck retained-session reprobe, releases its waiters and retries after cooldown', async () => withRecords(async (dir, path) => {
    vi.useFakeTimers()
    try {
      writeFileSync(path, JSON.stringify({ claude: previous }))
      let finishStale!: (text: string) => void
      const stuck = new Promise<string>(resolve => { finishStale = resolve })
      const probe = vi.fn(async (_model: string | undefined, _signal: AbortSignal) => 'ok').mockReturnValueOnce(stuck)
      let events = [{ kind: 'error', message: 'model not found' }] as AgentEvent[]
      const p = inner()
      p.spawn = async () => ({ async *dispatch() { yield* events }, async close() {} })
      const timeoutMs = firstUseProbeTimeout(200)
      const provider = withFirstUseProbe(p, {
        probe, timeoutMs, cache: { combination: () => combination, history: openFirstUseProbeRecords(dir, () => {})('claude') },
        failureMessage: (_, failure) => failure.reason,
      })
      const session = await provider.spawn(project, ctx)
      await collectTurn(session.dispatch('invalidate'))
      events = [reply, completed]

      const errors: string[] = []
      const dispatch = () => session.dispatch('retry')[Symbol.asyncIterator]().next()
      const observe = () => dispatch().catch((err: Error) => { errors.push(err.message) })
      const waiters = Promise.all([observe(), observe()])
      await vi.advanceTimersByTimeAsync(timeoutMs - 1)
      expect(errors).toEqual([])
      expect(probe).toHaveBeenCalledTimes(1)
      const signal = probe.mock.calls[0]![1]
      expect(signal.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(signal.aborted).toBe(true)
      expect(errors).toEqual(['请求超时（timeout）', '请求超时（timeout）'])
      await waiters
      expect(provider.probeStatus()).toMatchObject({ state: 'failed', kind: 'transient' })
      await expect(dispatch()).rejects.toThrow('请求超时')
      expect(probe).toHaveBeenCalledTimes(1)
      const failed = provider.probeStatus()
      if (failed.state !== 'failed') throw new Error('missing cooldown')
      expect(failed.retryAt - failed.at).toBe(30_000)
      await vi.advanceTimersByTimeAsync(30_000)
      expect((await collectTurn(session.dispatch('recovered'))).finalText).toBe('收到')
      finishStale('late reply')
      expect(probe).toHaveBeenCalledTimes(2)
      expect(provider.probeStatus()).toMatchObject({ state: 'ok', detail: 'ok' })
    } finally {
      vi.useRealTimers()
    }
  }))

  it('accepts tool-only completion and never treats reply text as an error', async () => withRecords(async (dir, path) => {
    writeFileSync(path, JSON.stringify({ claude: previous }))
    const fixture = setup(dir)
    const session = await fixture.spawn()
    fixture.setEvents({ kind: 'tool_call', tool: 'reply', server: 'wechat' }, completed)
    await collectTurn(session.dispatch('hello'))
    fixture.setEvents({ kind: 'text', text: 'model not found' }, completed)
    await collectTurn(session.dispatch('please quote the error'))
    expect(fixture.save).toHaveBeenCalledTimes(1)
    expect(fixture.status()).toMatchObject({ state: 'ok', source: 'history' })
  }))
})
