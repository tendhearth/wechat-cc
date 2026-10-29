import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeEvalRunner, type EvalRunnerDeps } from './runner'
import { makeFakeSession } from '../../test-support/test-helpers'
import { JOB_PROFILE, TIER_PROFILES } from '../../domain/user-tier'
import type { AgentEvent, AgentProject, AgentSession, SpawnContext } from '../../ports/agent-provider'

let root = ''
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'wcc-output-eval-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

interface Spawned { project: AgentProject; ctx: SpawnContext; dispatched: string[]; closed: boolean }

function harness(o: { events?: AgentEvent[]; spawnThrows?: Error; cheap?: ((p: string) => Promise<string>) | null; providers?: string[] } = {}) {
  const spawned: Spawned[] = []
  const providers = o.providers ?? ['claude', 'codex']
  const registry: EvalRunnerDeps['registry'] = {
    get: (id: string) => {
      if (!providers.includes(id)) return null
      return {
        provider: {
          async spawn(project: AgentProject, ctx: SpawnContext): Promise<AgentSession> {
            if (o.spawnThrows) throw o.spawnThrows
            const rec: Spawned = { project, ctx, dispatched: [], closed: false }
            spawned.push(rec)
            const inner = makeFakeSession({ events: o.events ?? [], onDispatch: (t) => { rec.dispatched.push(t) } })
            return { ...inner, async close() { rec.closed = true; await inner.close() } }
          },
        },
        opts: { displayName: id, canResume: () => true },
      } as never
    },
    getCheapEval: () => (o.cheap === undefined ? null : o.cheap),
    getCheapEvalBudgetMs: () => 5_000,
  }
  const buildInstructions = vi.fn((p: string, _tp: unknown, chatId: string, model?: string) => `PROMPT(${p},${chatId},${model ?? '-'})`)
  const mintSessionToken = vi.fn((_tier: string, _key: string, _opts?: unknown) => 'tok')
  const invalidateSession = vi.fn()
  const deps: EvalRunnerDeps = {
    registry, defaultProviderId: () => 'claude', buildInstructions, currentModelFor: (p) => (p === 'claude' ? 'claude-x' : undefined),
    mintSessionToken, invalidateSession, log: vi.fn(), projectDir: join(root, 'project'), now: () => 1000, uuid: () => 'u-1',
  }
  return { runner: makeEvalRunner(deps), deps, spawned, buildInstructions, mintSessionToken, invalidateSession }
}

const text = (t: string): AgentEvent => ({ kind: 'text', text: t })

describe('reply:生产的提示词 + 只读档、不批权限', () => {
  it('提示词按样本的档位用 buildInstructions 组装;会话按定时只读档起(strict、不给批权限的口)', async () => {
    const h = harness({ events: [text('早,今天先做哪件?')] })
    const r = await h.runner.reply({ text: '早' })
    expect(r).toMatchObject({ ok: true, kind: 'reply', providerId: 'claude', model: 'claude-x', finalText: '早,今天先做哪件?', bubbles: ['早,今天先做哪件?'], silent: false })
    expect(h.buildInstructions).toHaveBeenCalledWith('claude', TIER_PROFILES.admin, 'eval-u-1', 'claude-x')
    const s = h.spawned[0]!
    expect(s.ctx.appendInstructions).toBe('PROMPT(claude,eval-u-1,claude-x)')
    expect(s.ctx.tierProfile).toBe(JOB_PROFILE)
    expect(s.ctx.tierProfile.relay.size).toBe(0) // 不在 allow 里的一律拒,不弹卡
    expect(s.ctx.permissionMode).toBe('strict')
    expect(s.ctx.requestPermission).toBeUndefined()
    expect(s.ctx.chatId).toBe('eval-u-1')
    expect(s.ctx.model).toBe('claude-x')
    expect(s.ctx.mcpEnv).toEqual({ WECHAT_SESSION_TOKEN: 'tok', WECHAT_SESSION_TIER: 'guest' })
    expect(s.project.path).toBe(join(root, 'project'))
    expect(s.dispatched).toEqual(['早'])
    expect(s.closed).toBe(true)
  })
  it('会话令牌只放行 GET /v1/health,跑完作废', async () => {
    const h = harness({ events: [text('好')] })
    await h.runner.reply({ text: '早' })
    const [tier, key, opts] = h.mintSessionToken.mock.calls[0]!
    expect(tier).toBe('guest')
    expect([...(opts as { routeAllow: Set<string> }).routeAllow]).toEqual(['GET /v1/health'])
    expect(h.invalidateSession).toHaveBeenCalledWith(key)
  })
  it('trusted 档 / 指定执行者与模型', async () => {
    const h = harness({ events: [text('好')] })
    const r = await h.runner.reply({ text: '早', tier: 'trusted', providerId: 'codex', model: 'm2' })
    expect(r).toMatchObject({ providerId: 'codex', model: 'm2' })
    expect(h.buildInstructions).toHaveBeenCalledWith('codex', TIER_PROFILES.trusted, 'eval-u-1', 'm2')
  })
  it('最后的话 + 分气泡;旁白不进回复', async () => {
    const h = harness({ events: [text('我查一下'), { kind: 'tool_call', tool: 'Read' }, text('登录页的问题已经修好并且验证过了。\n\n接口那边还在等对方回复,明天再看。')] })
    const r = await h.runner.reply({ text: '怎么样' })
    expect(r).toMatchObject({ finalText: '登录页的问题已经修好并且验证过了。\n\n接口那边还在等对方回复,明天再看。', narration: ['我查一下'], toolCalls: ['Read'] })
    expect('bubbles' in r && r.bubbles).toEqual(['登录页的问题已经修好并且验证过了。', '接口那边还在等对方回复,明天再看。'])
  })
  it('私聊里写 NO_REPLY:不显示(silent),也没有气泡', async () => {
    const h = harness({ events: [text('NO_REPLY')] })
    expect(await h.runner.reply({ text: '嗯' })).toMatchObject({ ok: true, finalText: '', bubbles: [], silent: true })
  })
  it('跑完(成功或出错)都请 forgetChat 收掉这个一次性 chatId 的痕迹', async () => {
    const forgot: string[] = []
    const h = harness({ events: [text('好')] })
    const r2 = makeEvalRunner({ ...h.deps, forgetChat: (c) => { forgot.push(c) } })
    await r2.reply({ text: '早' })
    const bad = harness({ spawnThrows: new Error('x') })
    await makeEvalRunner({ ...bad.deps, forgetChat: (c) => { forgot.push(c) } }).reply({ text: '早' })
    expect(forgot).toEqual(['eval-u-1', 'eval-u-1'])
  })
  it('不认得的执行者 ⇒ eval_unknown_provider,不起会话、不铸令牌', async () => {
    const h = harness()
    expect(await h.runner.reply({ text: '早', providerId: 'nope' })).toEqual({ ok: false, code: 'eval_unknown_provider' })
    expect(h.mintSessionToken).not.toHaveBeenCalled()
  })
  it('起会话抛错 ⇒ ok:false 带原因,令牌照样作废', async () => {
    const h = harness({ spawnThrows: Object.assign(new Error('guard says no'), { code: 'network_unprotected' }) })
    const r = await h.runner.reply({ text: '早' })
    expect(r).toMatchObject({ ok: false, kind: 'reply', error: 'guard says no', errorCode: 'network_unprotected' })
    expect(h.invalidateSession).toHaveBeenCalled()
  })
  it('轮次出错 ⇒ ok:false 带错误码', async () => {
    const h = harness({ events: [{ kind: 'error', message: 'quota', code: 'quota_exhausted' }] })
    expect(await h.runner.reply({ text: '早' })).toMatchObject({ ok: false, error: 'quota', errorCode: 'quota_exhausted' })
  })
})

describe('brief:早报信封 + 拍板候选', () => {
  const material = { today: '终端里修好了登录', reminders: [{ at: '09:00', text: '交房租' }], agenda: [], prefs: [] }
  it('发的是 buildBriefText 拼的信封;提示词用 JOB_PROFILE', async () => {
    const h = harness({ events: [text('1. 交房租\n就这些。')] })
    const r = await h.runner.brief({ material, nowIso: '2026-10-29T00:00:00.000Z' })
    expect(r).toMatchObject({ ok: true, kind: 'brief', finalText: '1. 交房租\n就这些。', silent: false, attached: false })
    expect(h.buildInstructions).toHaveBeenCalledWith('claude', JOB_PROFILE, 'eval-u-1', 'claude-x')
    const sent = h.spawned[0]!.dispatched[0]!
    expect(sent).toContain('<scheduled_job id="eval-brief" kind="brief" ts="2026-10-29T00:00:00.000Z" />')
    expect(sent).toContain('09:00 交房租')
    expect(sent).toContain('终端里修好了登录')
  })
  it('有候选 ⇒ 信封里说有几条,模型写完后接上', async () => {
    const asks = [{ no: 1, id: 'a1', hash: 'h', question: '要不要换模型?', recommend: '换' }]
    const h = harness({ events: [text('1. 交房租\n<<CC_ASKS>>\n就这些。')] })
    const r = await h.runner.brief({ material, asks })
    expect(h.spawned[0]!.dispatched[0]!).toContain('今天有 1 条是 CC 自己找到')
    expect(r).toMatchObject({ ok: true, attached: true })
    expect('finalText' in r && r.finalText).toContain('要不要换模型?')
  })
  it('早报可以静默', async () => {
    const h = harness({ events: [text('NO_REPLY')] })
    expect(await h.runner.brief({ material })).toMatchObject({ ok: true, silent: true, finalText: '', bubbles: [] })
  })
})

describe('reference:生产的指称顺序 + 生产的便宜模型', () => {
  const cand = (id: string, title: string) => ({ id, title, project: 'p', path: '/p', providerId: 'claude', phase: 'running', updatedAt: 0 })
  it('名字撞了两件 ⇒ 问便宜模型', async () => {
    const cheap = vi.fn(async () => '2')
    const h = harness({ cheap })
    const r = await h.runner.reference({ text: '登录那件怎么样了', candidates: [cand('aaaa1111', '修登录页'), cand('bbbb2222', '登录接口')] })
    expect(r).toMatchObject({ ok: true, kind: 'reference', resolution: { kind: 'task', taskId: 'bbbb2222', via: 'judge' } })
    expect(cheap).toHaveBeenCalledOnce()
  })
  it('没有便宜模型 ⇒ 不问,照规则落(ambiguous 带选项编号)', async () => {
    const h = harness({ cheap: null })
    const r = await h.runner.reference({ text: '登录那件怎么样了', candidates: [cand('aaaa1111', '修登录页'), cand('bbbb2222', '登录接口')] })
    expect(r).toMatchObject({ ok: true, resolution: { kind: 'ambiguous', options: ['aaaa1111', 'bbbb2222'] } })
  })
  it('焦点的过期时间按 nowMs 判', async () => {
    const h = harness({ cheap: null })
    const r = await h.runner.reference({ text: '好了吗', candidates: [cand('aaaa1111', '修登录页')], focus: { taskId: 'aaaa1111', expiresAt: 2000 }, nowMs: 1500 })
    expect(r).toMatchObject({ resolution: { kind: 'task', taskId: 'aaaa1111', via: 'focus' } })
  })
})

describe('judge:生产的便宜模型原样回答', () => {
  it('回模型的原文', async () => {
    const h = harness({ cheap: async (p) => (p === 'Q' ? ' 1\n' : 'x') })
    expect(await h.runner.judge('Q')).toEqual({ ok: true, kind: 'judge', answer: ' 1\n', durationMs: 0 })
  })
  it('没有便宜模型 ⇒ eval_no_cheap_model;调用抛错 ⇒ ok:false 带原因', async () => {
    expect(await harness({ cheap: null }).runner.judge('Q')).toEqual({ ok: false, code: 'eval_no_cheap_model' })
    expect(await harness({ cheap: async () => { throw new Error('down') } }).runner.judge('Q')).toEqual({ ok: false, kind: 'judge', error: 'down', durationMs: 0 })
  })
})
