import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { AgentEvent } from '../../../ports/agent-provider'
import { grokHome, grokSubprocessEnv } from '../../../lib/grok-home'
import { removeTempDir } from '../../../lib/test-temp'
import { TIER_PROFILES } from '../../../domain/user-tier'
import { createScriptedAcpAgent, type ScriptedTurn } from '../../../test-support/executors/acp-scripted-agent'
import { createAcpGrokProvider } from './acp-grok'
import { executionFailureMessage, taskErrorForProviderCode } from '../../store/workbench/execution-settings'
import { spawnFailedNotice, turnErrorNotice } from '../../../app/coordinator/failures'

const dirs: string[] = []
const project = { alias: 'offline-test', path: '/fake-project' }
const context = { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' as const, chatId: 'test' }
function fixture(turns: ScriptedTurn[], networkPreflight = vi.fn(async () => true), limits: { promptIdleTimeoutMs?: number; cancelGraceMs?: number; ignoreSigterm?: boolean } = {}) {
  const { ignoreSigterm, ...timeouts } = limits
  const stateDir = mkdtempSync(join(tmpdir(), 'grok-liveness-')); dirs.push(stateDir)
  grokSubprocessEnv(stateDir, {})
  writeFileSync(join(grokHome(stateDir), '.grok/auth.json'), 'fake login existence only')
  const fake = createScriptedAcpAgent({ turns })
  const kills = vi.fn()
  const spawn = vi.fn((...args: Parameters<typeof fake.spawn>) => {
    const child = fake.spawn(...args) as ChildProcess
    const kill = child.kill.bind(child)
    child.kill = signal => { kills(signal); return ignoreSigterm && signal === 'SIGTERM' ? true : kill(signal) }
    return child
  }) as unknown as typeof fake.spawn
  const provider = createAcpGrokProvider({ bin: '/fake/grok', stateDir, log: () => {}, spawn, networkPreflight, ...timeouts })
  return { fake, spawn, kills, provider, networkPreflight }
}
const drain = async (events: AsyncIterable<AgentEvent>) => { const result: AgentEvent[] = []; for await (const event of events) result.push(event); return result }
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) removeTempDir(dir) })

describe.runIf(process.platform !== 'win32')('Grok offline liveness', () => {
  it('reports the network refusal and idle stop honestly in chat and workbench', () => {
    expect(spawnFailedNotice('grok', 'grok_network_unavailable', 'network')).toBe('Grok 现在连不上（网络），这句我先不转给它。')
    expect(turnErrorNotice('grok', 'acp_prompt_idle_timeout: Grok', 'provider_error')).toBe('Grok 没回应，已停下。')
    expect(executionFailureMessage(taskErrorForProviderCode('network', 'grok_network_unavailable')!)).toBe('Grok 现在连不上（网络），这句我先不转给它。')
    expect(executionFailureMessage(taskErrorForProviderCode('provider_error', 'acp_prompt_idle_timeout: Grok')!)).toBe('Grok 没回应，已停下。')
  })

  it('rejects a failed preflight before spawning and never retries on its own', async () => {
    const t = fixture([], vi.fn(async () => false))
    await expect(t.provider.spawn(project, context)).rejects.toThrow('grok_network_unavailable')
    expect(t.spawn).not.toHaveBeenCalled()
    expect(t.networkPreflight).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the injected preflight throws, in workbench too', async () => {
    const t = fixture([], vi.fn(async () => { throw new Error('DNS failure') }))
    await expect(t.provider.spawn(project, context)).rejects.toThrow('grok_network_unavailable')
    expect(t.spawn).not.toHaveBeenCalled()
    const provider = createAcpGrokProvider({ bin: '/fake/grok', stateDir: dirs.at(-1), workbench: true, log: () => {}, spawn: t.spawn, networkPreflight: async () => false })
    await expect(provider.spawn(project, context)).rejects.toThrow('grok_network_unavailable')
    expect(t.spawn).not.toHaveBeenCalled()
  })

  it('allows a reachable preflight and checks every next turn on a cached session', async () => {
    const t = fixture([{ steps: [{ say: '正常回复' }] }, { steps: [{ say: '恢复后的下一句' }] }])
    const session = await t.provider.spawn(project, context)
    try {
      expect(await drain(session.dispatch('第一句'))).toContainEqual({ kind: 'text', text: '正常回复' })
      t.networkPreflight.mockResolvedValue(false)
      const blocked = await drain(session.dispatch('断网这一句'))
      expect(blocked).toContainEqual(expect.objectContaining({ kind: 'error', message: 'grok_network_unavailable', code: 'network' }))
      expect(blocked.some(e => e.kind === 'init')).toBe(false)
      expect(t.fake.children[0]!.prompts).toHaveLength(1)
      t.networkPreflight.mockResolvedValue(true)
      expect(await drain(session.dispatch('下一句才重试'))).toContainEqual({ kind: 'text', text: '恢复后的下一句' })
      expect(t.fake.children).toHaveLength(1)
      expect(t.fake.children[0]!.prompts).toHaveLength(2)
    } finally { await session.close() }
  })

  it('cancels after the default 90s silence and kills a child that ignores cancellation after the grace', async () => {
    const t = fixture([{ steps: [{ delayMs: 1_000_000 }] }])
    const session = await t.provider.spawn(project, context)
    vi.useFakeTimers()
    const events = drain(session.dispatch('不回应'))
    await vi.advanceTimersByTimeAsync(89_999)
    expect(t.fake.children[0]!.sent.filter(r => r.method === 'session/cancel')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(t.fake.children[0]!.sent.filter(r => r.method === 'session/cancel')).toHaveLength(1)
    expect(t.kills).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await events).toContainEqual(expect.objectContaining({ kind: 'error', message: 'acp_prompt_idle_timeout: Grok' }))
    expect(t.kills).toHaveBeenCalledWith('SIGTERM')
    expect(t.fake.children[0]!.prompts).toHaveLength(1)
    expect(t.fake.children[0]!.sent.filter(r => r.method === 'session/cancel')).toHaveLength(1)
    await session.close()
  })

  it('resets the injected idle deadline on thought updates even though no text event is produced', async () => {
    const t = fixture([{ steps: [{ delayMs: 80 }, { think: 'still working' }, { delayMs: 80 }, { say: '完成' }] }], undefined, { promptIdleTimeoutMs: 100, cancelGraceMs: 20 })
    const session = await t.provider.spawn(project, context)
    vi.useFakeTimers()
    const events = drain(session.dispatch('慢一点'))
    await vi.advanceTimersByTimeAsync(161)
    expect(await events).toContainEqual({ kind: 'text', text: '完成' })
    await vi.advanceTimersByTimeAsync(500)
    expect(t.fake.children[0]!.sent.some(r => r.method === 'session/cancel')).toBe(false)
    expect(t.kills).not.toHaveBeenCalled()
    await session.close()
  })

  it('accepts prompt completion during cancellation grace without leaking the partial answer or killing', async () => {
    const t = fixture([{ steps: [{ say: '半截话' }, { delayMs: 110 }] }], undefined, { promptIdleTimeoutMs: 100, cancelGraceMs: 20 })
    const session = await t.provider.spawn(project, context)
    vi.useFakeTimers()
    const events = drain(session.dispatch('卡住后回应 cancel'))
    await vi.advanceTimersByTimeAsync(111)
    const result = await events
    expect(result).toContainEqual(expect.objectContaining({ kind: 'error', message: 'acp_prompt_idle_timeout: Grok' }))
    expect(result.some(e => e.kind === 'text')).toBe(false)
    await vi.advanceTimersByTimeAsync(100)
    expect(t.kills).not.toHaveBeenCalled()
    expect(t.fake.children[0]!.prompts).toHaveLength(1)
    await session.close()
  })

  it('also bounds a manual cancellation when the child ignores cancel', async () => {
    const t = fixture([{ steps: [{ delayMs: 1_000_000 }] }], undefined, { promptIdleTimeoutMs: 100, cancelGraceMs: 20 })
    const session = await t.provider.spawn(project, context)
    vi.useFakeTimers()
    const events = drain(session.dispatch('手动停止'))
    await vi.advanceTimersByTimeAsync(10)
    await session.cancel?.()
    await vi.advanceTimersByTimeAsync(20)
    expect(t.kills).toHaveBeenCalledWith('SIGTERM')
    expect(await events).toContainEqual(expect.objectContaining({ kind: 'error', message: 'acp_turn_cancelled' }))
    expect(t.fake.children[0]!.sent.filter(r => r.method === 'session/cancel')).toHaveLength(1)
    await session.close()
  })

  it('uses the existing SIGKILL escalation and confirms exit before reporting stopped', async () => {
    const t = fixture([{ steps: [{ delayMs: 1_000_000 }] }], undefined, { promptIdleTimeoutMs: 100, cancelGraceMs: 20, ignoreSigterm: true })
    const session = await t.provider.spawn(project, context)
    vi.useFakeTimers()
    let ended = false
    const events = drain(session.dispatch('连 SIGTERM 也不理')).then(result => { ended = true; return result })
    await vi.advanceTimersByTimeAsync(120)
    expect(t.kills).toHaveBeenCalledWith('SIGTERM')
    expect(ended).toBe(false)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(t.kills).toHaveBeenCalledWith('SIGKILL')
    expect(await events).toContainEqual(expect.objectContaining({ kind: 'error', message: 'acp_prompt_idle_timeout: Grok' }))
    expect(t.fake.children[0]!.prompts).toHaveLength(1)
    await session.close()
  })
})
