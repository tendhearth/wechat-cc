import { describe, expect, it, vi } from 'vitest'
import { makeMwRoute, type RouteMwDeps } from './mw-route'
import { makeMwTaskReference } from './mw-task-reference'
import type { InboundCtx } from './types'
import { createProviderRegistry } from '../../app/provider-registry'
import { answerTargetProviders } from '../task-handoff-names'

const ctxOf = (text: string, origin?: 'desktop'): InboundCtx => ({
  msg: { chatId: 'owner', userId: 'owner', text, msgType: 'text', createTimeMs: 1, accountId: 'a' },
  receivedAtMs: 1, requestId: origin ? 'app:desktop:1' : 'wechat:1', ...(origin ? { origin } : {}),
})
const providers = () => [
  { id: 'codex', names: ['Codex'], available: true },
  { id: 'claude', names: ['Claude', '克劳德'], available: true },
]
const route = (extra: Partial<RouteMwDeps> = {}) => makeMwRoute({ probes: {}, providers, log: () => {}, ...extra })

describe('共用答话目标（PR 2，仅结构判定）', () => {
  it('人选与名字只从真实 registry 取，支持自定义显示名，不把网关模型名当人选', () => {
    const registry = createProviderRegistry()
    const provider = { spawn: async () => { throw Error('unused') } }
    registry.register('custom', provider, { displayName: '我的助手', canResume: () => false })
    registry.register('claude', provider, { canResume: () => false })
    expect(answerTargetProviders(registry, id => id !== 'claude')).toEqual([
      { id: 'custom', names: ['custom', '我的助手'], available: true },
      { id: 'claude', names: ['claude', 'Claude', '克劳德', 'Claude Code'], available: false },
    ])
  })
  it('共享令牌的 provider 不支持隔离的一次代答，按不可用澄清', async () => {
    const registry = createProviderRegistry()
    registry.register('agy', { spawn: async () => { throw Error('must not spawn') } }, { canResume: () => false })
    const ctx = ctxOf('让 agy 回答这个问题')
    await route({ providers: () => answerTargetProviders(registry, () => true) })(ctx, async () => {})
    expect(ctx.target).toEqual({ kind: 'clarify', provider: 'agy', reason: 'provider_unavailable' })
  })
  it('微信与 App 同句点名相同 oneoff，下一句回 cc；不记录正文', async () => {
    const log = vi.fn()
    const mw = route({ log })
    for (const origin of [undefined, 'desktop'] as const) {
      const first = ctxOf('让 Codex 回答这个问题: 私密题目', origin)
      await mw(first, async () => {})
      expect(first.target).toEqual({ kind: 'oneoff', provider: 'codex', reason: 'explicit_provider' })
      expect(Object.isFrozen(first.target)).toBe(true)
      expect(first.msg.answerTarget?.kind).toBe('oneoff')
      const next = ctxOf('今天有点累', origin)
      await mw(next, async () => {})
      expect(next.target?.kind).toBe('cc')
    }
    const receipts = log.mock.calls.filter(([tag]) => tag === 'ANSWER_TARGET').map(([, line]) => JSON.parse(line))
    expect(receipts).toHaveLength(4)
    expect(receipts[0]).toEqual({ requestId: 'wechat:1', kind: 'oneoff', provider: 'codex', reason: 'explicit_provider' })
    expect(receipts[1].requestId).toBe('wechat:1')
    expect(receipts[2].requestId).toBe('app:desktop:1')
  })

  it.each(['这个让 Claude 答', '让克劳德回答这句：你好'])('只认明确结构：%s', async text => {
    const ctx = ctxOf(text); await route()(ctx, async () => {})
    expect(ctx.target).toEqual({ kind: 'oneoff', provider: 'claude', reason: 'explicit_provider' })
  })

  it.each(['Claude 的额度呢', '换成 Codex', '用 Codex', '切回 Claude', '我想让 Codex 回答这个问题', '不要让 Codex 回答这个问题', '让 Grok 回答这个问题', '让 Codex 回答这个问题吗？'])('保守地留给原入口：%s', async text => {
    const ctx = ctxOf(text); await route()(ctx, async () => {})
    expect(ctx.target?.kind).toBe('cc')
  })

  it('已有命令/控制优先，不询问事项探针', async () => {
    const task = vi.fn()
    const ctx = ctxOf('让 Codex 回答这个问题')
    await route({ probes: { command: () => true, 'task-reference': task } })(ctx, async () => {})
    expect(ctx.intent?.kind).toBe('command')
    expect(ctx.target).toEqual({ kind: 'cc', reason: 'existing_command' })
    expect(task).not.toHaveBeenCalled()
  })

  it('注册但不可用时澄清，不交给另一家', async () => {
    const ctx = ctxOf('让 Codex 回答这个问题')
    await route({ providers: () => [{ id: 'codex', names: ['Codex'], available: false }] })(ctx, async () => {})
    expect(ctx.target).toEqual({ kind: 'clarify', provider: 'codex', reason: 'provider_unavailable' })
  })

  it('既有 20 分钟焦点仍接普通补充，点名不新增或改焦点', async () => {
    const handleWechat = vi.fn(async (_chatId: string, _text: string) => '已补充')
    const task = { id: 'deadbeef', project: 'sample-project', title: '读 NOTES.md,整理成 TODO.md', path: '/fixture', providerId: 'claude', phase: 'running', updatedAt: 1, error: null }
    const ref = makeMwTaskReference({ ownerChatId: () => 'owner', candidates: () => [task], handleWechat, sendMessage: async () => {}, now: () => 1, log: () => {} })
    const mw = route({ probes: { 'task-reference': ref.probe } })
    const send = async (text: string) => { const ctx = ctxOf(text); await mw(ctx, () => ref(ctx, async () => {})); return ctx }
    await send('接下来说整理 TODO 那件')
    expect((await send('再加一行')).target).toMatchObject({ kind: 'matter', matterId: task.id })
    expect((await send('让 Codex 回答这个问题')).target?.kind).toBe('oneoff')
    for (const text of ['换成 Codex', '用 Codex', '切回 Claude']) expect((await send(text)).target?.kind).toBe('cc')
    expect((await send('再补一行')).target?.kind).toBe('matter')
    expect(handleWechat.mock.calls.map(([, text]) => text)).toEqual([`任务 ${task.id} 补充 再加一行`, `任务 ${task.id} 补充 再补一行`])
  })
})
