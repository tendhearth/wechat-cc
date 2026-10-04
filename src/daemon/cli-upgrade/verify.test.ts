import { describe, it, expect, vi } from 'vitest'
import { verifyCliProvider, type VerifyDeps } from './verify'
import { CLI_SPECS } from '../../core/cli-upgrade/specs'
import type { SelftestConverseResult } from '../selftest'
import type { SelftestReport } from '../../cli/selftest'

const good = (over: Partial<SelftestConverseResult> = {}): SelftestConverseResult => ({
  ok: true, providerId: 'claude', sessionId: 's1', texts: ['pid 123'], toolCalls: ['wechat/ping'],
  eventKinds: ['init', 'tool_call', 'text', 'result'], durationMs: 10, ...over,
})

function deps(over: Partial<VerifyDeps> = {}): VerifyDeps {
  return {
    hasProvider: () => true,
    guardAllows: async () => ({ allowed: true }),
    converse: vi.fn(async () => good()),
    log: () => {},
    ...over,
  }
}

const wbReport = (checks: SelftestReport['checks']): SelftestReport => ({ ok: checks.every(c => c.ok), kind: 'workbench', target: 'claude', checks, durationMs: 1 })

describe('verifyCliProvider — the same checks as `selftest chat --resume` (+ workbench), in-process', () => {
  it('pass: replied / tool_seen / no_error / protocol_events / resume_replied', async () => {
    const d = deps()
    const r = await verifyCliProvider({ ...CLI_SPECS.claude, workbench: false }, d)
    expect(r.status).toBe('pass')
    expect(d.converse).toHaveBeenCalledTimes(2)
    expect((d.converse as ReturnType<typeof vi.fn>).mock.calls[1]![0]).toMatchObject({ resumeSessionId: 's1' })
  })

  it('protocol smoke: our parser no longer sees a result event ⇒ fail (format drift)', async () => {
    const r = await verifyCliProvider({ ...CLI_SPECS.claude, workbench: false }, deps({ converse: async () => good({ eventKinds: ['text'], sessionId: null }) }))
    expect(r.status).toBe('fail')
    expect(r.detail).toContain('protocol_events')
    expect(r.detail).toContain('缺 result,tool_call')
  })

  it('a turn that errors ⇒ fail with the error in the detail', async () => {
    const r = await verifyCliProvider({ ...CLI_SPECS.codex, workbench: false }, deps({ converse: async () => good({ ok: false, texts: [], error: 'unexpected status 400', errorCode: 'invalid_request' }) }))
    expect(r.status).toBe('fail')
    expect(r.detail).toContain('unexpected status 400')
  })

  it('agy: the wechat MCP tool is not required (not yet verified on a real machine)', async () => {
    const r = await verifyCliProvider(CLI_SPECS.agy, deps({ converse: async () => good({ toolCalls: [], eventKinds: ['text', 'result'] }) }))
    expect(r.status).toBe('pass')
  })

  it('network guard says unsafe ⇒ deferred, no model call at all', async () => {
    const d = deps({ guardAllows: async () => ({ allowed: false, detail: 'bx 未连上' }) })
    const r = await verifyCliProvider(CLI_SPECS.claude, d)
    expect(r).toEqual({ status: 'deferred', detail: 'network_unprotected:bx 未连上' })
    expect(d.converse).not.toHaveBeenCalled()
  })

  it('guard refusal surfacing from inside the turn ⇒ deferred, not fail', async () => {
    const r = await verifyCliProvider(CLI_SPECS.claude, deps({ converse: async () => good({ ok: false, texts: [], error: '网络未受保护', errorCode: 'network_unprotected' }) }))
    expect(r.status).toBe('deferred')
  })

  it('provider-side failures (quota / auth / network / 5xx) are not the CLI’s fault ⇒ deferred, never a rollback', async () => {
    for (const code of ['quota', 'rate_limited', 'auth_failed', 'auth_rejected', 'network', 'server_error']) {
      const r = await verifyCliProvider(CLI_SPECS.cursor, deps({ converse: async () => good({ ok: false, texts: [], error: 'Upgrade your plan to continue', errorCode: code }) }))
      expect(r.status, code).toBe('deferred')
    }
    // 「模型需要更新的 CLI」是 invalid_request —— 那正是要抓的,算 fail
    const tooOld = await verifyCliProvider({ ...CLI_SPECS.codex, workbench: false }, deps({ converse: async () => good({ ok: false, texts: [], error: 'requires a newer version of Codex', errorCode: 'invalid_request' }) }))
    expect(tooOld.status).toBe('fail')
    // 工作台里同一类失败(固定人话)也一样
    const { executionFailureMessage } = await import('../../core/workbench/execution-settings')
    const wb = await verifyCliProvider(CLI_SPECS.claude, deps({ workbench: async () => wbReport([{ name: 'no_error_event', ok: false, detail: executionFailureMessage('provider_quota_exhausted') }]) }))
    expect(wb.status).toBe('deferred')
  })

  it('provider not registered in this daemon ⇒ skipped', async () => {
    const r = await verifyCliProvider(CLI_SPECS.agy, deps({ hasProvider: () => false }))
    expect(r.status).toBe('skipped')
    // 不在重探名单里(reprobe ⇒ null)也一样
    expect((await verifyCliProvider(CLI_SPECS.agy, deps({ hasProvider: () => false, reprobe: async () => null }))).status).toBe('skipped')
  })

  it('#211:开机探测失败、还在重探 ⇒ 立刻重探;还没好 ⇒ deferred(不永久免检),通过 ⇒ 照常自检', async () => {
    const reprobe = vi.fn(async () => false)
    const r = await verifyCliProvider(CLI_SPECS.agy, deps({ hasProvider: () => false, reprobe }))
    expect(r.status).toBe('deferred')
    expect(reprobe).toHaveBeenCalledWith('agy')

    let registered = false
    const d = deps({ hasProvider: () => registered, reprobe: async () => { registered = true; return true } })
    const r2 = await verifyCliProvider({ ...CLI_SPECS.agy, workbench: false }, d)
    expect(r2.status).toBe('pass')
    expect(d.converse).toHaveBeenCalled()
  })

  it('workbench executors also run `selftest workbench`; a failing check fails the upgrade', async () => {
    const wb = vi.fn(async () => wbReport([{ name: 'replied', ok: true }, { name: 'permission_roundtrip', ok: false, detail: 'no permission card' }]))
    const r = await verifyCliProvider(CLI_SPECS.claude, deps({ workbench: wb }))
    expect(wb).toHaveBeenCalledWith('claude')
    expect(r.status).toBe('fail')
    expect(r.detail).toContain('workbench.permission_roundtrip')
  })

  it('workbench selftest refused by the guard ⇒ deferred; daemon API not up ⇒ deferred', async () => {
    expect((await verifyCliProvider(CLI_SPECS.codex, deps({ workbench: async () => wbReport([{ name: 'replied', ok: false, detail: 'task failed: network_unprotected' }]) }))).status).toBe('deferred')
    expect((await verifyCliProvider(CLI_SPECS.codex, deps({ workbench: async () => { throw new Error('daemon_not_running') } }))).status).toBe('deferred')
  })
})
