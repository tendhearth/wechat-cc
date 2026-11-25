import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openFirstUseProbeRecords } from '../daemon/bootstrap/first-use-probe-records'
import { collectTurn, type AgentEvent, type AgentProvider } from '../ports/agent-provider'
import { TIER_PROFILES } from '../domain/user-tier'
import { classifyCall } from '../lib/call-classifier'
import { probeEndpointKey, probeStatusNote, withTurnConfirmation } from './first-use-probe'
import { createProviderRegistry } from './provider-registry'

const ctx = { chatId: 'owner', permissionMode: 'strict', tierProfile: TIER_PROFILES.guest } as const
const model = 'configured-model'
const project = { alias: 'test', path: '/tmp' }
const baseUrl = 'https://api.anthropic.com'
const defaults = { cliVersion: '1.2.3', sdkVersion: 'sdk-build', model, endpoint: probeEndpointKey({ baseUrl }) }

async function withRecords(run: (dir: string, path: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'turn-confirmation-'))
  try { await run(dir, join(dir, 'first-use-probes.json')) }
  finally { rmSync(dir, { recursive: true, force: true }) }
}

function fixture(dir: string, combination = () => defaults) {
  let events: AgentEvent[] = [
    { kind: 'text', text: 'normal reply' },
    { kind: 'result', sessionId: 'sid', numTurns: 1, durationMs: 2 },
  ]
  let now = 2_000
  const dispatch = vi.fn(async function* () { yield* events })
  const inner: AgentProvider = {
    callTarget: () => ({ provider: 'claude', model, baseUrl }),
    spawn: async (_project, context) => ({ callTarget: () => ({ provider: 'claude', model: context.model ?? model, baseUrl }), dispatch, close: async () => {} }),
    cheapEval: async input => input,
  }
  const history = openFirstUseProbeRecords(dir, () => { throw new Error('unable to write test fixture') })('claude')
  const provider = withTurnConfirmation(inner, { provider: 'claude', combination, history, now: () => now })
  return { provider, history, dispatch, setEvents: (next: AgentEvent[]) => { events = next }, setNow: (at: number) => { now = at } }
}

describe('withTurnConfirmation', () => {
  it('keys an endpoint by scheme, host and path without URL credentials or query parameters', () => {
    const key = (baseUrl: string) => probeEndpointKey({ baseUrl })
    expect(key('https://user:password@gateway.invalid/v1/?key=value#fragment')).toBe(key('https://gateway.invalid/v1'))
    expect(key('http://gateway.invalid/v1')).not.toBe(key('https://gateway.invalid/v1'))
    expect(key('https://gateway.invalid/v2')).not.toBe(key('https://gateway.invalid/v1'))
  })

  it('records the first successful real turn only, and reuses its timestamp after restart', () => withRecords(async (dir, path) => {
    const f = fixture(dir)
    expect(f.provider.probeStatus()).toEqual({ state: 'awaiting_turn' })
    expect(await f.provider.cheapEval!('eval')).toBe('eval')
    const session = await f.provider.spawn(project, ctx)
    expect(f.dispatch).not.toHaveBeenCalled()
    await collectTurn(session.dispatch('owner question'))
    const record = { ...defaults, confirmedByTurn: true, at: 2_000 }
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ claude: [record] })
    f.setNow(3_000)
    await collectTurn(session.dispatch('follow up'))
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ claude: [record] })
    expect(f.provider.probeStatus()).toEqual({ state: 'ok', source: 'turn', at: 3_000 })
    const restarted = fixture(dir)
    expect(restarted.provider.probeStatus()).toEqual({ state: 'ok', source: 'history', at: 2_000 })
    restarted.setNow(4_000)
    const resumed = await restarted.provider.spawn(project, ctx)
    await collectTurn(resumed.dispatch('first reply after restart'))
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ claude: [{ ...record, at: 4_000 }] })
  }))

  it('keeps an in-flight result on its session model and endpoint when the defaults change', () => withRecords(async (dir, path) => {
    let configured = defaults
    const f = fixture(dir, () => configured)
    const session = await f.provider.spawn(project, ctx)
    const events = session.dispatch('first turn')[Symbol.asyncIterator]()
    expect(await events.next()).toMatchObject({ value: { kind: 'text' } })
    configured = { ...defaults, model: 'new-default' }
    expect(await events.next()).toMatchObject({ value: { kind: 'result' } })
    expect(await events.next()).toMatchObject({ done: true })
    expect(f.provider.probeStatus()).toEqual({ state: 'awaiting_turn' })
    expect(JSON.parse(readFileSync(path, 'utf8')).claude).toEqual([{ ...defaults, at: 2_000, confirmedByTurn: true }])
    configured = { ...defaults, endpoint: 'native' }
    expect(f.provider.probeStatus()).toEqual({ state: 'awaiting_turn' })
    configured = defaults
    expect(f.provider.probeStatus()).toEqual({ state: 'ok', source: 'turn', at: 2_000 })
  }))

  it.each([
    { cliVersion: '3.2.1' }, { sdkVersion: 'different-build' }, { model: 'different-model' }, { endpoint: 'native' },
  ])('does not reuse a confirmation for a changed combination %j', (changed) => withRecords(async (dir, path) => {
    writeFileSync(path, JSON.stringify({ claude: [{ ...defaults, at: 1_000, confirmedByTurn: true }] }))
    const f = fixture(dir, () => ({ ...defaults, ...changed }))
    expect(f.provider.probeStatus()).toEqual({ state: 'awaiting_turn' })
    await f.provider.spawn(project, ctx)
    expect(f.dispatch).not.toHaveBeenCalled()
  }))

  it.each([
    '{', '{"claude":{"at":22}}', JSON.stringify({ claude: { ...defaults, at: 1_000 } }),
  ])('accepts a real reply with older or unreadable history (%s)', (data) => withRecords(async (dir, path) => {
    writeFileSync(path, data)
    const f = fixture(dir)
    expect(f.provider.probeStatus()).toEqual({ state: 'awaiting_turn' })
    const session = await f.provider.spawn(project, ctx)
    await collectTurn(session.dispatch('owner turn'))
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ claude: [{ ...defaults, at: 2_000, confirmedByTurn: true }] })
  }))

  it('clears only the pinned incompatible target and lets its retained session try again', () => withRecords(async (dir) => {
    const f = fixture(dir)
    const ordinary = await f.provider.spawn(project, ctx)
    await collectTurn(ordinary.dispatch('default target'))
    const pinned = await f.provider.spawn(project, { ...ctx, model: 'pinned' })
    await collectTurn(pinned.dispatch('pinned target'))
    f.setEvents([{ kind: 'error', message: 'protocol mismatch' }])
    expect((await collectTurn(pinned.dispatch('failed turn'))).errorCode).toBe('incompatible')
    expect(f.history.read({ ...defaults, model: 'pinned' })).toBeUndefined()
    expect(f.history.read(defaults)).toBeDefined()
    expect(f.provider.probeStatus()).toEqual({ state: 'ok', source: 'turn', at: 2_000 })
    f.setEvents([{ kind: 'result', sessionId: 'sid', numTurns: 1, durationMs: 2, finalText: 'I saw a protocol mismatch in the log.' }])
    expect((await collectTurn(pinned.dispatch('next turn'))).error).toBeUndefined()
    expect(f.history.read({ ...defaults, model: 'pinned' })).toBeDefined()
  }))

  it.each([
    { message: 'API Error: 503 Service Unavailable', code: 'server_error', note: '暂时忙不过来（503）' },
    { message: 'unexpected status 429', code: 'rate_limited', note: '暂时限流（429）' },
    { message: 'rate limit exceeded', code: 'rate_limited', note: '暂时忙不过来（rate_limit）' },
    { message: 'read ECONNRESET', code: 'network', note: '暂时连不上（网络）' },
    { message: 'connection reset', code: 'provider_error', note: '暂时没有回应（原因未明）' },
    { message: 'authentication failed or timed out', code: 'network', note: '请求超时（timeout）' },
    { message: 'unexpected failure', code: 'provider_error', note: '暂时没有回应（原因未明）' },
    { message: 'HTTP error: 401 Unauthorized', code: 'auth_rejected', note: '拒绝了凭证（401）' },
    { message: 'model not found', explicitCode: 'auth_rejected', code: 'auth_rejected', note: '拒绝了凭证（认证）' },
    { message: 'insufficient_quota', explicitCode: 'auth_rejected', code: 'auth_rejected', note: '拒绝了凭证（认证）' },
    { message: 'HTTP error: 401 Unauthorized', explicitCode: 'network', code: 'network', note: '暂时连不上（网络）' },
    { message: 'failed to connect', explicitCode: 'provider_error', code: 'network', note: '暂时连不上（网络）' },
  ])('reports a real turn error and preserves prior confirmation for $message', ({ message, explicitCode, code, note }) => withRecords(async (dir) => {
    const f = fixture(dir)
    const session = await f.provider.spawn(project, ctx)
    await collectTurn(session.dispatch('confirm before failure'))
    const record = f.history.read(defaults)
    f.setEvents([{ kind: 'error', message, ...(explicitCode ? { code: explicitCode } : {}) }])
    expect((await collectTurn(session.dispatch('failing turn'))).errorCode).toBe(code)
    expect(probeStatusNote(f.provider.probeStatus())).toContain(note)
    expect(f.history.read(defaults)).toEqual(record)
  }))

  it('counts tool-only completion as a real reply and rejects a genuinely empty completion', () => withRecords(async dir => {
    const f = fixture(dir)
    const session = await f.provider.spawn(project, ctx)
    const result = { kind: 'result', sessionId: 'sid', numTurns: 1, durationMs: 2 } as const
    f.setEvents([{ kind: 'tool_call', tool: 'reply' }, result])
    expect((await collectTurn(session.dispatch('tool reply'))).error).toBeUndefined()
    expect(f.history.read(defaults)).toBeDefined()
    f.setEvents([result])
    expect((await collectTurn(session.dispatch('empty reply'))).errorCode).toBe('incompatible')
    expect(f.history.read(defaults)).toBeUndefined()
  }))

  it('checks the retained session on each dispatch and leaves confirmation alone on a guard denial', () => withRecords(async (dir) => {
    const f = fixture(dir)
    let safe = true
    const registry = createProviderRegistry({ networkGate: {
      classify: classifyCall,
      check: async () => ({ safe, source: 'off', detail: 'test' }),
    } })
    registry.register('claude', f.provider, { canResume: () => true })
    const session = await registry.get('claude')!.provider.spawn(project, ctx)
    await collectTurn(session.dispatch('first'))
    safe = false
    await expect(collectTurn(session.dispatch('guard dropped'))).rejects.toMatchObject({ code: 'network_unprotected' })
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    expect(probeStatusNote(f.provider.probeStatus())).toBe('已通过对话确认连接')
    safe = true
    await collectTurn(session.dispatch('guard recovered'))
    expect(f.dispatch).toHaveBeenCalledTimes(2)
  }))
})
