import { describe, it, expect, vi } from 'vitest'
import { outputEvalRoutes } from './routes'
import type { EvalRunner } from './runner'
import { WORKBENCH_ERRORS } from '@wechat-cc/protocol'
import { ROUTES } from '@wechat-cc/protocol/routes'

function fakeRunner(): EvalRunner & { calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = []
  return {
    calls,
    reply: vi.fn(async (i) => { calls.push(['reply', i]); return { ok: true, kind: 'reply' as const, providerId: 'claude', finalText: 'x', bubbles: ['x'], silent: false, rawFinalText: 'x', narration: [], segments: ['x'], toolCalls: [], durationMs: 1 } }),
    brief: vi.fn(async (i) => { calls.push(['brief', i]); return { ok: false, code: 'eval_unknown_provider' } as const }),
    reference: vi.fn(async (i) => { calls.push(['reference', i]); return { ok: true, kind: 'reference', resolution: { kind: 'none' }, durationMs: 0 } as const }),
    judge: vi.fn(async (p) => { calls.push(['judge', p]); return { ok: false, code: 'eval_no_cheap_model' } as const }),
  }
}

const post = (r: ReturnType<typeof outputEvalRoutes>, body: unknown) => r['POST /v1/eval/run']!(new URLSearchParams(), body, undefined as never, undefined as never)

describe('POST /v1/eval/run', () => {
  it('路由表里:admin 档、operator 令牌、挂在 output-eval 模块下;码都在错误码表里', () => {
    expect(ROUTES['POST /v1/eval/run']).toEqual({ module: 'output-eval', desktop: { tier: 'admin', tokens: ['operator'] } })
    for (const c of ['eval_invalid_request', 'eval_unknown_provider', 'eval_no_cheap_model']) expect(WORKBENCH_ERRORS[c], c).toBeDefined()
  })
  it('reply:只把认得的字段交给 runner', async () => {
    const run = fakeRunner()
    const res = await post(outputEvalRoutes(run), { kind: 'reply', text: '早', tier: 'trusted', providerId: 'codex', model: 'm', timeoutMs: 5000, junk: 1 })
    expect(res.status).toBe(200)
    expect(run.calls).toEqual([['reply', { text: '早', tier: 'trusted', providerId: 'codex', model: 'm', timeoutMs: 5000 }]])
  })
  it('请求不成立 ⇒ 400 eval_invalid_request 带 detail,runner 不被调', async () => {
    const run = fakeRunner()
    const r = outputEvalRoutes(run)
    for (const body of [
      null, { kind: 'chat' }, { kind: 'reply' }, { kind: 'reply', text: '' }, { kind: 'reply', text: '早', tier: 'guest' },
      { kind: 'reply', text: '早', providerId: '../x' }, { kind: 'reply', text: '早', timeoutMs: 0 },
      { kind: 'brief' }, { kind: 'brief', material: { reminders: 'x' } }, { kind: 'brief', material: {}, asks: [{ no: 'a' }] },
      { kind: 'reference', text: 'x' }, { kind: 'reference', text: 'x', candidates: [{ title: 't' }] },
      { kind: 'judge' }, { kind: 'judge', prompt: 'x'.repeat(20_001) },
    ]) {
      const res = await post(r, body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect((res.body as { error: string; detail: string }).error).toBe('eval_invalid_request')
      expect(typeof (res.body as { detail: string }).detail).toBe('string')
    }
    expect(run.calls).toEqual([])
  })
  it('brief:素材缺的块补成空,候选照收', async () => {
    const run = fakeRunner()
    const asks = [{ no: 1, id: 'a', hash: 'h', question: 'q', recommend: 'r' }]
    await post(outputEvalRoutes(run), { kind: 'brief', material: { today: '修好了', reminders: [{ at: '09:00', text: '房租' }] }, asks, nowIso: '2026-10-29T00:00:00.000Z' })
    expect(run.calls).toEqual([['brief', { material: { today: '修好了', reminders: [{ at: '09:00', text: '房租' }], agenda: [], prefs: [], calendar: null }, asks, nowIso: '2026-10-29T00:00:00.000Z' }]])
  })
  it('runner 拒了 ⇒ 按码表回状态', async () => {
    const run = fakeRunner()
    const r = outputEvalRoutes(run)
    expect(await post(r, { kind: 'brief', material: {} })).toEqual({ status: 404, body: { ok: false, error: 'eval_unknown_provider' } })
    expect(await post(r, { kind: 'judge', prompt: 'p' })).toEqual({ status: 503, body: { ok: false, error: 'eval_no_cheap_model' } })
  })
  it('reference:候选补齐缺省字段', async () => {
    const run = fakeRunner()
    await post(outputEvalRoutes(run), { kind: 'reference', text: '登录那件', candidates: [{ id: 'aaaa1111', title: '修登录页' }], focus: { taskId: 'aaaa1111', expiresAt: 5 }, nowMs: 1 })
    expect(run.calls).toEqual([['reference', {
      text: '登录那件', candidates: [{ id: 'aaaa1111', title: '修登录页', project: '', path: '', providerId: '', phase: '', updatedAt: 0 }],
      focus: { taskId: 'aaaa1111', expiresAt: 5 }, nowMs: 1,
    }]])
  })
})
