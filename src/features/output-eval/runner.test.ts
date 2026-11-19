import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createInternalApi } from '../../daemon/internal-api'
import { createInternalApiClient } from '../../mcp-servers/wechat/client'
import { createWechatMcpServer } from '../../mcp-servers/wechat/server'
import { ledgerRoutes } from '../workbench/ledger-routes'
import type { WorkbenchService } from '../workbench/service'
import { WorkbenchEntryResultResponse } from '../../../packages/protocol/src/desktop-api'
import { matterToolFailure } from '../../../packages/protocol/src/workbench-errors'
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
  const providers = o.providers ?? ['claude', 'codex', 'openai']
  const registry: EvalRunnerDeps['registry'] = {
    get: (id: string) => {
      if (!providers.includes(id)) return null
      return {
        provider: {
          cheapEval: o.cheap ?? undefined,
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
  it('样本放开 topic_search:MCP 按 admin 起,令牌只多那一条路由,权限档只多 knowledge_search 一类', async () => {
    const h = harness({ events: [text('好')] })
    await h.runner.reply({ text: '那个问题后来怎么定的', tools: ['topic_search'] })
    const [tier, , opts] = h.mintSessionToken.mock.calls[0]!
    expect(tier).toBe('admin')
    expect([...(opts as { routeAllow: Set<string> }).routeAllow].sort()).toEqual(['GET /v1/health', 'POST /v1/memory/topics/search'])
    const p = h.spawned[0]!.ctx.tierProfile
    expect(p.allow.has('knowledge_search')).toBe(true)
    expect(p.deny.has('knowledge_search')).toBe(false)
    expect([...p.allow].filter(k => !JOB_PROFILE.allow.has(k))).toEqual(['knowledge_search'])
    expect(p.relay.size).toBe(0)
    expect(h.spawned[0]!.ctx.mcpEnv).toEqual({ WECHAT_SESSION_TOKEN: 'tok', WECHAT_SESSION_TIER: 'admin' })
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

describe('整轮上限(Codex 评审:看门狗只管「没动静」,一直在说的一轮要有总上限,CLI 的 HTTP 时限才对得上)', () => {
  it('一直有事件、超过 timeoutMs ⇒ cancel 那一轮、记 turn_deadline、照样收尾', async () => {
    let cancelled = false
    let closed = false
    const registry: EvalRunnerDeps['registry'] = {
      get: () => ({
        provider: {
          async spawn(): Promise<AgentSession> {
            return {
              async *dispatch() { while (!cancelled) { yield text('…'); await new Promise(r => setTimeout(r, 5)) } },
              async cancel() { cancelled = true },
              async close() { closed = true },
            } as unknown as AgentSession
          },
        },
        opts: { displayName: 'claude', canResume: () => true },
      }) as never,
      getCheapEval: () => null,
      getCheapEvalBudgetMs: () => 5_000,
    }
    const invalidateSession = vi.fn()
    const runner = makeEvalRunner({
      registry, defaultProviderId: () => 'claude', buildInstructions: () => 'P', mintSessionToken: () => 'tok', invalidateSession,
      log: vi.fn(), projectDir: join(root, 'project'), uuid: () => 'u-2',
    })
    const r = await runner.reply({ text: '早', timeoutMs: 60 })
    expect(r).toMatchObject({ ok: false, kind: 'reply', errorCode: 'turn_deadline', finalText: '' })
    expect(cancelled).toBe(true)
    expect(closed).toBe(true)
    expect(invalidateSession).toHaveBeenCalledWith('claude/eval/eval-u-2')
  })
})

it('records matter_plan through authenticated HTTP and closes access before session.close', async () => {
  const h = harness()
  const project = { id: 'p-0123456789abcdef0123', name: 'rici', path: root, providerId: 'claude' }
  const matterPlan = vi.fn(async () => ({ task: { id: 'feed1234' }, receipt: { requestId: 'req', taskId: 'feed1234', matterId: 'feed1234', runId: 'run', acceptedAt: 1 } }))
  let executors = { available: ['claude'], defaultProviderId: 'claude' as string | null }
  const matterApprovalStatus = vi.fn(() => true)
  const planConversation = vi.fn(() => ({ scope: 'owner-turn' }))
  const api = createInternalApi({ stateDir: root, daemonPid: 1 })
  const routes = ledgerRoutes({
    workbench: { matterPlan, matterApprovalStatus, projects: () => [project], planExecutors: () => executors } as unknown as WorkbenchService,
    resolveAdminChatId: () => 'owner', planConversation,
  })
  api.mount('workbench', routes)
  const { port } = await api.start()
  const baseUrl = `http://127.0.0.1:${port}`
  const input = { project: 'RICI', title: '加个收藏', isolation: 'worktree', legs: [{ executor: 'claude', brief: '改'.repeat(220) }] }
  const post = (token: string, path = '/v1/matter/plan') => fetch(baseUrl + path, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(input),
  })
  let token: string
  let recordMatterPlan: NonNullable<Parameters<EvalRunnerDeps['mintSessionToken']>[2]>['recordMatterPlan']
  let closeStatus: number | undefined
  const runner = makeEvalRunner({
    ...h.deps,
    mintSessionToken: (tier, key, opts) => {
      recordMatterPlan = opts?.recordMatterPlan
      return api.mintSessionToken(tier, key, opts)
    },
    invalidateSession: key => api.invalidateSession(key),
    registry: {
      ...h.deps.registry,
      // 对话这张登记表里的 claude 不带工作台能力(生产如此);能不能接活由工作台的 availableExecutors 说了算
      get: (id: string) => id !== 'claude' ? null : ({
        provider: {
          async spawn(_project: AgentProject, ctx: SpawnContext): Promise<AgentSession> {
            token = ctx.mcpEnv!.WECHAT_SESSION_TOKEN!
            expect(ctx.tierProfile.relay.size).toBe(0)
            expect(ctx.requestPermission).toBeUndefined()
            return {
              async *dispatch() {
                const internal = createInternalApiClient({ baseUrl, tokenFilePath: '', sessionToken: token })
                const mcp = await createWechatMcpServer(internal, { tier: 'admin', outputEvalTools: ctx.mcpEnv!.WECHAT_OUTPUT_EVAL_TOOLS })
                const ownerMcp = await createWechatMcpServer(internal, { tier: 'admin', parallelSocialProbe: true })
                const connect = async (server: typeof mcp) => {
                  const client = new Client({ name: 'offline-test', version: '1' })
                  const [s, c] = InMemoryTransport.createLinkedPair()
                  await Promise.all([server.connect(s), client.connect(c)])
                  return client
                }
                const [client, ownerClient] = await Promise.all([connect(mcp), connect(ownerMcp)])
                try {
                  const { tools } = await client.listTools()
                  expect(tools).toEqual((await ownerClient.listTools()).tools.filter(tool => tool.name === 'matter_plan'))
                  const call = async (args: Omit<typeof input, 'legs'> & { legs: Array<{ executor?: string; brief: string }> }) => {
                    const result = await client.callTool({ name: 'matter_plan', arguments: args })
                    return JSON.parse((result.content as Array<{ text: string }>)[0]!.text)
                  }
                  const result = WorkbenchEntryResultResponse.parse(await call(input))
                  expect(result.receipt).toMatchObject({ taskId: result.task.id, matterId: result.task.id })
                  expect(result.task).toMatchObject({ title: input.title, path: root, providerId: 'claude' })
                  expect(await call({ ...input, project: 'missing' })).toEqual(matterToolFailure('project_stale', false, 'plan', [project]))
                  expect(await call({ ...input, legs: [] })).toEqual(matterToolFailure('invalid_matter_plan', false))
                  // 没登记的执行者:生产受理前会拒,记录器也拒(独立评审)
                  expect(await call({ ...input, legs: [{ executor: 'ghost', brief: '改' }] })).toEqual(matterToolFailure('unavailable_provider', false, 'plan', undefined, ['claude']))
                  const withoutExecutor = { ...input, legs: [{ brief: '改' }] }
                  expect(WorkbenchEntryResultResponse.parse(await call(withoutExecutor)).task.providerId).toBe('claude')
                  expect(await call({ ...input, legs: [...withoutExecutor.legs, ...input.legs] })).toEqual(matterToolFailure('invalid_matter_plan', false))
                  executors = { available: [], defaultProviderId: null }
                  expect(await call(withoutExecutor)).toEqual(matterToolFailure('unavailable_provider', false, 'plan', undefined, []))
                  const denied = await post(token, '/v1/matter/relay')
                  expect(await denied.json()).toEqual({ error: 'route_not_allowed' })
                  expect(matterPlan).toHaveBeenCalledTimes(0)
                  expect(matterApprovalStatus).toHaveBeenCalledTimes(0)
                  expect(planConversation).toHaveBeenCalledTimes(0)
                } finally {
                  await Promise.all([client.close(), ownerClient.close(), mcp.close(), ownerMcp.close()])
                }
                yield { kind: 'tool_call', tool: 'matter_plan' }
                yield text('已交办，放到 rici。')
              },
              async close() {
                closeStatus = (await post(token)).status
              },
            }
          },
        },
      }) as never,
    },
  })
  try {
    const result = await runner.reply({ text: 'rici 加个收藏', tools: ['matter_plan'] })
    expect(result).toMatchObject({
      ok: true, planCalls: [
        { title: input.title, project: 'RICI', resolvedProject: 'rici', legs: [{ executor: 'claude', brief: '改'.repeat(200) }] },
        { title: input.title, project: 'missing', resolvedProject: null, error: 'project_stale' },
        { title: input.title, project: 'RICI', resolvedProject: null, error: 'invalid_matter_plan', legs: [] },
        { title: input.title, project: 'RICI', resolvedProject: 'rici', error: 'unavailable_provider', legs: [{ executor: 'ghost', brief: '改' }] },
        { title: input.title, project: 'RICI', resolvedProject: 'rici', legs: [{ executor: 'claude', brief: '改' }] },
        { title: input.title, project: 'RICI', resolvedProject: null, error: 'invalid_matter_plan' },
        { title: input.title, project: 'RICI', resolvedProject: 'rici', error: 'unavailable_provider', legs: [] },
      ],
    })
    expect(closeStatus).toBe(401)
    expect((await post(token!)).status).toBe(401)
    // A request that already passed token authentication before revocation must still fail closed.
    const late = await routes['POST /v1/matter/plan']!(new URLSearchParams(), input, {
      origin: 'session', tier: 'admin', chatId: 'owner', sessionKey: 'claude/eval/eval-u-1', recordMatterPlan: recordMatterPlan!,
    })
    expect(late.status).toBe(403)
    expect(matterPlan).toHaveBeenCalledTimes(0)

    const ordinary = api.mintSessionToken('admin', 'claude/project/owner')
    expect((await post(ordinary)).status).toBe(202)
    expect(matterPlan).toHaveBeenCalledTimes(1)
    expect(matterApprovalStatus).toHaveBeenCalledTimes(1)
  } finally {
    await api.stop()
  }
})
