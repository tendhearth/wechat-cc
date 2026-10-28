import { describe, expect, it } from 'vitest'
import { admit, createPlanner, type AdmitInput, type TurnPlan } from './plan'
import { createCoordinatorCtx } from './ctx'
import type { ConversationCoordinatorDeps } from './types'
import type { Mode } from '../../domain/conversation'
import type { InboundMsg } from '../../domain/prompt-format'
import type { CallTarget, NetworkGate } from '../../lib/network-gate'
import { TIER_PROFILES } from '../../domain/user-tier'

// 2026-10 变异测试第二轮:admit(一轮的档位 / 参与者 / 被拒,开跑前一次定完)以前只经五家交付的集成测试间接跑到。
// 这里直接按「模式 + 候选 + access ⇒ 计划」一张张表钉住。
const ACCESS = { dmPolicy: 'allowlist' as const, allowFrom: ['owner', 'friend', 'guest'], admins: ['owner'], trusted: ['friend'] }
const REGISTERED = ['claude', 'codex', 'cursor', 'agy', 'openai']

function input(over: Partial<AdmitInput> & Pick<AdmitInput, 'mode'>): AdmitInput {
  return {
    chatId: 'owner',
    access: ACCESS,
    permissionMode: 'strict',
    trustedProviders: undefined,
    isRegistered: p => REGISTERED.includes(p),
    registered: REGISTERED,
    defaultProviderId: 'claude',
    ...over,
  }
}

describe('admit — 档位', () => {
  it.each([
    // [chat, 权限模式, 原始档位, 生效档位, 生效权限模式]
    ['owner', 'strict', 'admin', 'admin', 'strict'],
    ['friend', 'strict', 'trusted', 'trusted', 'strict'],
    ['friend', 'dangerously', 'trusted', 'admin', 'dangerously'],
    // 访客永不提权,--dangerously 下也是 strict
    ['guest', 'dangerously', 'guest', 'guest', 'strict'],
  ] as const)('%s / %s ⇒ 原始 %s、生效 %s、%s', (chatId, permissionMode, rawTier, tier, mode) => {
    const a = admit(input({ chatId, permissionMode, mode: { kind: 'solo', provider: 'claude' } }))
    expect(a.auth).toEqual({ rawTier, tier, tierProfile: TIER_PROFILES[tier], permissionMode: mode })
  })
})

describe('admit — 单模型', () => {
  it('solo:注册了 ⇒ 就是它,不记日志', () => {
    const a = admit(input({ mode: { kind: 'solo', provider: 'codex' } }))
    expect(a).toMatchObject({ kind: 'solo', participants: ['codex'], recordMode: 'solo', denial: null, logs: [], notes: [] })
  })
  it('solo:记着的那家不在了 ⇒ 回落到默认,派发时记一句', () => {
    const a = admit(input({ mode: { kind: 'solo', provider: 'gone' } }))
    expect(a).toMatchObject({ kind: 'solo', participants: ['claude'], recordMode: 'solo', denial: null, logs: [] })
    expect(a.notes).toEqual([`chat=owner persisted provider 'gone' not registered; falling back to claude`])
  })
  it('primary_tool:注册了 ⇒ 派给 primary,记成 primary_tool', () => {
    const a = admit(input({ mode: { kind: 'primary_tool', primary: 'codex' } }))
    expect(a).toMatchObject({ kind: 'solo', participants: ['codex'], recordMode: 'primary_tool', notes: [] })
  })
  it('primary_tool:primary 不在了 ⇒ 回落到默认,仍记成 primary_tool', () => {
    const a = admit(input({ mode: { kind: 'primary_tool', primary: 'gone' } }))
    expect(a).toMatchObject({ kind: 'solo', participants: ['claude'], recordMode: 'primary_tool' })
    expect(a.notes).toEqual([`chat=owner primary_tool primary 'gone' not registered; falling back to solo+claude`])
  })
  it('按原始档位查被拒:访客用 codex ⇒ unconfined_guest;--dangerously 也不给访客解锁', () => {
    expect(admit(input({ chatId: 'guest', permissionMode: 'dangerously', mode: { kind: 'solo', provider: 'codex' } })).denial)
      .toEqual({ kind: 'unconfined_guest' })
  })
  it('信任档 + trusted_providers 没列这家 ⇒ not_in_trusted_list;主人不受限', () => {
    const tp = ['claude']
    expect(admit(input({ chatId: 'friend', trustedProviders: tp, mode: { kind: 'solo', provider: 'codex' } })).denial)
      .toEqual({ kind: 'not_in_trusted_list', allowed: tp })
    // --dangerously 把信任档提成 admin,但判 provider 只看原始档位
    expect(admit(input({ chatId: 'friend', permissionMode: 'dangerously', trustedProviders: tp, mode: { kind: 'solo', provider: 'codex' } })).denial)
      .toEqual({ kind: 'not_in_trusted_list', allowed: tp })
    expect(admit(input({ trustedProviders: tp, mode: { kind: 'solo', provider: 'codex' } })).denial).toBeNull()
  })
})

describe('admit — 一组(/both、/chat)', () => {
  it.each(['parallel', 'chatroom'] as const)('%s:候选都能用 ⇒ 原样,不记日志', kind => {
    const a = admit(input({ mode: { kind }, candidates: ['claude', 'codex'] }))
    expect(a).toMatchObject({ kind, participants: ['claude', 'codex'], recordMode: kind, denial: null, logs: [], notes: [] })
  })
  it('没注册的、agy、按档位被拒的都剔掉,记一句', () => {
    const a = admit(input({ chatId: 'guest', mode: { kind: 'parallel' }, candidates: ['claude', 'gone', 'agy', 'cursor', 'openai'] }))
    expect(a.participants).toEqual(['claude', 'openai'])
    expect(a.kind).toBe('parallel')
    expect(a.logs).toEqual([`chat=guest participants filtered claude,gone,agy,cursor,openai → claude,openai (registry: ${REGISTERED.join(',')})`])
  })
  it('主人显式点了 agy 也剔掉(共用令牌)', () => {
    expect(admit(input({ mode: { kind: 'chatroom' }, candidates: ['agy', 'claude', 'codex'] })).participants).toEqual(['claude', 'codex'])
  })
  it('超过 3 家 ⇒ 取前 3,记一句', () => {
    const a = admit(input({ mode: { kind: 'chatroom' }, candidates: ['claude', 'codex', 'cursor', 'openai'] }))
    expect(a.participants).toEqual(['claude', 'codex', 'cursor'])
    expect(a.logs).toEqual(['chat=owner participants > 3; capping at claude,codex,cursor'])
  })
  it('恰好 3 家 ⇒ 不封顶', () => {
    const a = admit(input({ mode: { kind: 'parallel' }, candidates: ['claude', 'codex', 'cursor'] }))
    expect(a.participants).toEqual(['claude', 'codex', 'cursor'])
    expect(a.logs).toEqual([])
  })
  it('一个都不剩 ⇒ 退成单模型默认那家,记成原模式', () => {
    const a = admit(input({ chatId: 'guest', mode: { kind: 'parallel' }, candidates: ['agy', 'codex'] }))
    expect(a).toMatchObject({ kind: 'solo', participants: ['claude'], recordMode: 'parallel', denial: null })
    expect(a.notes).toEqual(['chat=guest parallel resolved to empty participants; falling back to solo+claude'])
  })
  it('没给候选 ⇒ 当空的', () => {
    const a = admit(input({ mode: { kind: 'chatroom' } }))
    expect(a).toMatchObject({ kind: 'solo', participants: ['claude'], recordMode: 'chatroom', logs: [] })
  })
})

// planTurn:解析候选(老数据回填)、过网络守护、定形。假的只有边界:注册表、会话库、守护、日志、回话出口。
describe('planTurn', () => {
  type Row = { mode: Mode } | null
  function planner(o: { registry?: string[]; row?: Row; gate?: NetworkGate; setParticipantsThrows?: boolean; effectiveTarget?: boolean } = {}) {
    const registry = o.registry ?? ['claude', 'codex', 'cursor']
    const logs: string[] = []
    const notices: string[] = []
    const persisted: string[][] = []
    const effective: unknown[][] = []
    const deps = {
      registry: { list: () => registry, has: (p: string) => registry.includes(p), get: () => undefined },
      conversationStore: {
        get: () => o.row ?? null,
        setParticipants: (_chat: string, list: string[]) => { if (o.setParticipantsThrows) throw new Error('disk full'); persisted.push(list) },
      },
      loadAccess: () => ACCESS,
      permissionMode: 'strict',
      defaultProviderId: 'claude',
      log: (tag: string, line: string) => logs.push(`${tag} ${line}`),
      sendNotice: async (_c: string, t: string) => { notices.push(t) },
      resolveProject: () => (o.effectiveTarget ? { alias: 'proj', path: '/p' } : null),
      manager: {
        acquire: async () => { throw new Error('not used') },
        ...(o.effectiveTarget ? { effectiveTarget: (k: unknown, model: unknown) => { effective.push([k, model]); return { provider: (k as { providerId: string }).providerId } } } : {}),
      },
      ...(o.gate ? { networkGate: o.gate } : {}),
    } as unknown as ConversationCoordinatorDeps
    return { p: createPlanner(createCoordinatorCtx(deps)), logs, notices, persisted, effective }
  }
  /** 守护:`protect` 里的 provider 需要保护,信号永远不安全;记下每次分类的目标。 */
  function gate(protect: string[], seen: CallTarget[] = []): NetworkGate {
    return {
      check: async () => ({ safe: false, source: 'probe', detail: '探测失败' }),
      classify: t => { seen.push(t); return { protected: protect.includes(t.provider), kind: 'overseas', label: t.provider.toUpperCase(), host: null, reason: 'test' } as never },
    }
  }
  const msg = (chatId = 'owner') => ({ chatId, userId: chatId, text: 'hi' }) as unknown as InboundMsg

  it('没接守护 ⇒ 同步返回(不让一拍);单模型不碰会话库的参与者', () => {
    const { p, persisted } = planner({ row: { mode: { kind: 'solo', provider: 'codex' } } })
    const plan = p.planTurn(msg(), { kind: 'solo', provider: 'codex' })
    expect(plan).not.toBeInstanceOf(Promise)
    expect(plan).toMatchObject({ kind: 'solo', providerId: 'codex', recordMode: 'solo' })
    expect(persisted).toEqual([])
  })
  it('老数据(有行、没参与者)⇒ 回填注册表前两家(跳过 agy)并写回库', () => {
    const { p, persisted, logs } = planner({ registry: ['agy', 'claude', 'codex', 'cursor'], row: { mode: { kind: 'parallel' } } })
    expect(p.planTurn(msg(), { kind: 'parallel' })).toMatchObject({ kind: 'parallel', participants: ['claude', 'codex'] })
    expect(persisted).toEqual([['claude', 'codex']])
    expect(logs).toContain('COORDINATOR chat=owner legacy parallel backfilled participants=claude,codex')
  })
  it('回填写库失败 ⇒ 记一句,这一轮照样按前两家跑', () => {
    const { p, logs } = planner({ row: { mode: { kind: 'chatroom' } }, setParticipantsThrows: true })
    expect(p.planTurn(msg(), { kind: 'chatroom' })).toMatchObject({ kind: 'chatroom', participants: ['claude', 'codex'] })
    expect(logs).toContain('COORDINATOR chat=owner setParticipants failed: disk full')
  })
  it('全新的聊天(没行)⇒ 整个注册表(去掉 agy),不写库', () => {
    const { p, persisted } = planner({ registry: ['claude', 'agy', 'codex', 'cursor'] })
    expect(p.planTurn(msg(), { kind: 'parallel' })).toMatchObject({ kind: 'parallel', participants: ['claude', 'codex', 'cursor'] })
    expect(persisted).toEqual([])
  })
  it('显式参与者优先,不回填', () => {
    const { p, persisted } = planner({ row: { mode: { kind: 'parallel', participants: ['codex', 'cursor'] } } })
    expect(p.planTurn(msg(), { kind: 'parallel', participants: ['codex', 'cursor'] })).toMatchObject({ participants: ['codex', 'cursor'] })
    expect(persisted).toEqual([])
  })
  it('筛参与者的日志:正式一轮记,quiet(预估)不记', () => {
    const loud = planner()
    loud.p.planTurn(msg(), { kind: 'parallel', participants: ['claude', 'gone', 'codex'] })
    expect(loud.logs.filter(l => l.includes('participants filtered'))).toHaveLength(1)
    const quiet = planner()
    quiet.p.planTurn(msg(), { kind: 'parallel', participants: ['claude', 'gone', 'codex'] }, { quiet: true })
    expect(quiet.logs).toEqual([])
  })
  it('单模型被档位拒 ⇒ refused,不过守护', async () => {
    const seen: CallTarget[] = []
    const { p } = planner({ gate: gate(['codex'], seen) })
    const plan = await p.planTurn(msg('guest'), { kind: 'solo', provider: 'codex' })
    expect(plan).toMatchObject({ kind: 'refused', providerId: 'codex', denial: { kind: 'unconfined_guest' } })
    expect(seen).toEqual([])
  })
  it('守护挡下一组里的一家 ⇒ 退成单模型,记成原模式;回话一次、记 GUARD', async () => {
    const { p, notices, logs } = planner({ gate: gate(['codex']) })
    const plan = await p.planTurn(msg(), { kind: 'parallel', participants: ['claude', 'codex'] }) as TurnPlan
    expect(plan).toMatchObject({ kind: 'solo', providerId: 'claude', recordMode: 'parallel', notes: ['chat=owner parallel resolved to single participant claude; degrading to solo'] })
    expect(notices).toEqual(['网络未受保护(VPN 探测失败),用到 CODEX 的这一步先暂停，恢复后再试。'])
    expect(logs.some(l => l.startsWith('GUARD chat=owner protected call refused (CODEX) — network unprotected [probe] 探测失败'))).toBe(true)
  })
  it('一组里挡下两家 ⇒ 回话里的名字去重拼起来,只回一次', async () => {
    const { p, notices } = planner({ gate: gate(['codex', 'cursor']) })
    expect(await p.planTurn(msg(), { kind: 'chatroom', participants: ['claude', 'codex', 'cursor'] })).toMatchObject({ kind: 'solo', providerId: 'claude', recordMode: 'chatroom' })
    expect(notices).toEqual(['网络未受保护(VPN 探测失败),用到 CODEX、CURSOR 的这一步先暂停，恢复后再试。'])
  })
  it('都没挡 ⇒ 一组照旧', async () => {
    const { p, notices } = planner({ gate: gate([]) })
    expect(await p.planTurn(msg(), { kind: 'chatroom', participants: ['claude', 'codex'] })).toEqual(expect.objectContaining({ kind: 'chatroom', participants: ['claude', 'codex'] }))
    expect(notices).toEqual([])
  })
  it('全挡下:单模型 ⇒ paused 带回落那句;一组 ⇒ paused 不带', async () => {
    const solo = planner({ gate: gate(['claude']) })
    expect(await solo.p.planTurn(msg(), { kind: 'solo', provider: 'gone' })).toEqual({ kind: 'paused', notes: [`chat=owner persisted provider 'gone' not registered; falling back to claude`] })
    const group = planner({ gate: gate(['claude', 'codex']) })
    expect(await group.p.planTurn(msg(), { kind: 'parallel', participants: ['claude', 'codex'] })).toEqual({ kind: 'paused', notes: [] })
  })
  it('quiet(预估)被挡也不回话、不记日志', async () => {
    const { p, notices, logs } = planner({ gate: gate(['codex']) })
    await p.planTurn(msg(), { kind: 'parallel', participants: ['claude', 'codex'] }, { quiet: true })
    expect(notices).toEqual([])
    expect(logs).toEqual([])
  })
  it('按这一轮实际的目标判:solo 钉了模型 ⇒ 带上那个模型;一组里的别家不带', async () => {
    const seen: CallTarget[] = []
    const { p } = planner({ row: { mode: { kind: 'solo', provider: 'claude', model: 'm-pinned' } }, gate: gate([], seen) })
    await p.planTurn(msg(), { kind: 'solo', provider: 'claude', model: 'm-pinned' })
    expect(seen.map(t => [t.provider, t.model])).toEqual([['claude', undefined]]) // 没有 provider 对象 ⇒ unresolved,但仍是这家
    const s2: CallTarget[] = []
    const withSession = planner({ row: { mode: { kind: 'solo', provider: 'claude', model: 'm-pinned' } }, gate: gate([], s2), effectiveTarget: true })
    await withSession.p.planTurn(msg(), { kind: 'solo', provider: 'claude', model: 'm-pinned' })
    expect(withSession.effective).toEqual([[{ alias: 'proj', providerId: 'claude', chatId: 'owner' }, 'm-pinned']])
    const s3: CallTarget[] = []
    const group = planner({ row: { mode: { kind: 'solo', provider: 'claude', model: 'm-pinned' } }, gate: gate([], s3), effectiveTarget: true })
    await group.p.planTurn(msg(), { kind: 'parallel', participants: ['claude', 'codex'] })
    expect(group.effective).toEqual([
      [{ alias: 'proj', providerId: 'claude', chatId: 'owner' }, 'm-pinned'],
      [{ alias: 'proj', providerId: 'codex', chatId: 'owner' }, undefined],
    ])
  })
})
