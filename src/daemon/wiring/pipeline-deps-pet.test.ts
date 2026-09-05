import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPipelineDeps } from './pipeline-deps'
import { Ref } from '../../lib/lifecycle'
import { openTestDb, type Db } from '../../lib/db'
import { makePetSignals, type PetSignals } from '../pet-signals'
import { makeReplySinks } from '../reply-sinks'
import type { IlinkAdapter } from '../ilink-glue'
import type { Bootstrap } from '../bootstrap/index'
import type { ChatPrefsStore } from '../chat-prefs'
import type { CareLedger } from '../companion/care-ledger'
import type { InboundMsg } from '../../core/prompt-format'
import type { Mode } from '../../core/conversation'
import type { PendingPermissionView } from '../pending-permissions'

// 命令路由的「待批准」分支要求 access.admins 非空 + isAdmin(chatId)。这是
// 让 commandRouter.tryHandle 返回 true 的最窄一条路(纯内存,不碰真 access.json
// —— 见 MEMORY「Test pollution → live access.json」)。
vi.mock('../../lib/access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/access')>()),
  loadAccess: () => ({ admins: ['owner_chat'], allowFrom: ['owner_chat'] }),
  isAdmin: (chatId: string) => chatId === 'owner_chat',
}))

const fakeHealth = {
  health: { shouldSuspend: () => false, get: () => ({ consecutiveFailures: 0 }) },
} as unknown as Bootstrap['health']

const perm = (hash: string, chatId: string): PendingPermissionView =>
  ({ hash, chatId, prompt: 'Bash: ls', since: '2026-09-05T10:00:00.000Z', expires_at: '2026-09-05T10:01:00.000Z' })

describe('petTurn / 回合起止配对 (CC 桌宠 Phase B, fix round 1)', () => {
  let stateDir: string
  let db: Db

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'pipeline-deps-pet-test-'))
    db = openTestDb()
  })
  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }) })

  function writeOwner(chatId: string): void {
    mkdirSync(join(stateDir, 'companion'), { recursive: true })
    writeFileSync(join(stateDir, 'companion', 'config.json'), JSON.stringify({ enabled: true, default_chat_id: chatId }))
  }

  function setup(opts: {
    inFlight?: boolean
    pending?: PendingPermissionView[]
    petSignals?: PetSignals
    onDispatch?: (msg: InboundMsg) => Promise<void>
  } = {}) {
    const petSignals = opts.petSignals ?? makePetSignals(() => 1000)
    const coordinatorDispatch = vi.fn(opts.onDispatch ?? (async () => {}))
    const dispatchInner = vi.fn(async () => {})
    const submitTurn = vi.fn(<T,>(_msg: InboundMsg, o?: { within?: (d: () => Promise<void>) => Promise<T> }) =>
      (o?.within ? o.within(() => dispatchInner()) : dispatchInner() as unknown as Promise<T>))

    const ilink = {
      sendMessage: vi.fn(async () => ({ msgId: '1' })),
      sendFile: vi.fn(async () => {}),
      editMessage: vi.fn(async () => {}),
      broadcast: vi.fn(async () => ({ ok: 0, failed: 0 })),
      sharePage: vi.fn(async () => ({ url: '', slug: '' })),
      resurfacePage: vi.fn(async () => null),
      setUserName: vi.fn(async () => {}),
      resolveUserName: vi.fn(() => undefined),
      resolveAccountId: vi.fn(() => 'acct1'),
      projects: {} as IlinkAdapter['projects'],
      voice: {} as IlinkAdapter['voice'],
      companion: {} as IlinkAdapter['companion'],
      askUser: vi.fn(async () => 'timeout' as const),
      loadProjects: vi.fn(() => ({ projects: {}, current: null })),
      lastActiveChatId: vi.fn(() => null),
      markChatActive: vi.fn(),
      captureContextToken: vi.fn(),
      sendTyping: vi.fn(async () => {}),
      getUpdatesForLoop: vi.fn(async () => ({})),
      handlePermissionReply: vi.fn(() => false),
      listPendingPermissions: vi.fn(() => opts.pending ?? []),
      resolvePermission: vi.fn(() => false),
      sessionState: {} as IlinkAdapter['sessionState'],
      flush: vi.fn(async () => {}),
    } as unknown as IlinkAdapter

    const boot = {
      sessionManager: { isInFlight: vi.fn(() => opts.inFlight ?? false) } as unknown as Bootstrap['sessionManager'],
      sessionStore: {} as Bootstrap['sessionStore'],
      conversationStore: { upsertIdentity: vi.fn() } as unknown as Bootstrap['conversationStore'],
      registry: { get: vi.fn(), list: vi.fn(() => []), getCheapEval: vi.fn(() => null), has: vi.fn(() => false) } as unknown as Bootstrap['registry'],
      coordinator: {
        dispatch: coordinatorDispatch,
        dispatchInner,
        runExclusive: vi.fn(<T,>(_c: string, fn: () => Promise<T>) => fn()),
        submitTurn,
        getMode: vi.fn((): Mode => ({ kind: 'solo', provider: 'claude' })),
        cancel: vi.fn(() => false),
      } as unknown as Bootstrap['coordinator'],
      resolve: vi.fn((chatId: string) => (chatId === 'owner_chat' ? { alias: 'proj1', path: '/tmp/proj1' } : null)),
      formatInbound: vi.fn() as unknown as Bootstrap['formatInbound'],
      sdkOptionsForProject: vi.fn() as unknown as Bootstrap['sdkOptionsForProject'],
      buildInstructions: vi.fn(() => ''),
      defaultProviderId: 'claude',
      agentProviderKind: 'claude',
      dispatchDelegate: vi.fn() as unknown as Bootstrap['dispatchDelegate'],
      a2aDeps: undefined,
      a2aServer: null,
      agentConfig: { bot_name: null } as unknown as Bootstrap['agentConfig'],
      health: fakeHealth,
      markInboundActivity: vi.fn(),
    } as unknown as Bootstrap

    const chatPrefs: ChatPrefsStore = { get: () => ({}), set: () => ({}), list: () => [] }
    const careLedger: CareLedger = { get: () => ({ noReplyCount: 0 }), claim: vi.fn(), claimHunt: vi.fn(), claimVisit: vi.fn(), resetNoReply: vi.fn() }

    const built = buildPipelineDeps(
      { stateDir, db, ilink, boot, log: () => {}, chatPrefs, careLedger, replySinks: makeReplySinks(), petSignals },
      { polling: new Ref('polling'), guard: new Ref('guard'), pipeline: new Ref('pipeline'), ingestNudge: new Ref('ingestNudge') },
    )
    return { ...built, petSignals, coordinatorDispatch, ilink, boot }
  }

  const inbound = (chatId: string, text: string): InboundMsg =>
    ({ chatId, userId: chatId, text, msgType: 'text', createTimeMs: 1000, accountId: 'acct1' })

  it('待决权限只报主人自己那些(别的会话的 hash 是一张批准券,不该露给桌面)', async () => {
    writeOwner('owner_chat')
    const { petTurn } = setup({ pending: [perm('aaaaa', 'owner_chat'), perm('bbbbb', 'stranger@chat')] })
    const body = await petTurn()
    expect(body.pending_permissions.map(p => p.hash)).toEqual(['aaaaa'])
    expect(body.turn.phase).toBe('permission')
  })

  it('还没配主人 → 一条待决权限都不报(没有「谁能拍板」可言)', async () => {
    const { petTurn } = setup({ pending: [perm('aaaaa', 'someone')] })
    const body = await petTurn()
    expect(body.pending_permissions).toEqual([])
    expect(body.turn).toEqual({ phase: 'idle', since: null })
  })

  it('isInFlight 抬起来但没有起飞标记(tick 自发轮次)→ 不算 turn 相位', async () => {
    writeOwner('owner_chat')
    const { petTurn } = setup({ inFlight: true })
    expect((await petTurn()).turn).toEqual({ phase: 'idle', since: null })
  })

  it('入站起飞 + 会话在飞 → thinking,since 是起飞那一刻', async () => {
    writeOwner('owner_chat')
    const petSignals = makePetSignals(() => 1000)
    // 起飞标记由入站 dispatch 记下(见下一条);这里直接摆好这个状态。
    petSignals.noteTurnStart('owner_chat')
    const { petTurn } = setup({ inFlight: true, petSignals })
    expect((await petTurn()).turn).toEqual({ phase: 'thinking', since: '1970-01-01T00:00:01.000Z' })
  })

  it('被命令路由接走的消息不算一个回合:没起飞标记,也没进 coordinator', async () => {
    const { pipelineDeps, petSignals, coordinatorDispatch } = setup()
    await pipelineDeps.dispatch.coordinator.dispatch(inbound('owner_chat', '待批准'))
    expect(coordinatorDispatch).not.toHaveBeenCalled()
    expect(petSignals.snapshot('owner_chat').inFlightSinceMs).toBeNull()
  })

  it('正常入站:进 coordinator 时起飞,回来时落地(抛错也落地)', async () => {
    let seenDuringDispatch: number | null = null
    const { pipelineDeps, petSignals } = setup({
      onDispatch: async (msg) => { seenDuringDispatch = petSignals.snapshot(msg.chatId).inFlightSinceMs },
    })
    // onDispatch 只在下面这一行里被调用 —— 那时 petSignals 早已初始化。
    await pipelineDeps.dispatch.coordinator.dispatch(inbound('owner_chat', '你好'))
    expect(seenDuringDispatch).toBe(1000)
    expect(petSignals.snapshot('owner_chat').inFlightSinceMs).toBeNull()

    const boom = setup({ onDispatch: async () => { throw new Error('boom') } })
    await expect(boom.pipelineDeps.dispatch.coordinator.dispatch(inbound('owner_chat', '你好'))).rejects.toThrow('boom')
    expect(boom.petSignals.snapshot('owner_chat').inFlightSinceMs).toBeNull()
  })

  it('converse 也成对:主人联系记一笔,回合结束撤掉起飞标记', async () => {
    writeOwner('owner_chat')
    const { companionConverse, petSignals } = setup()
    await companionConverse('在吗')
    expect(petSignals.snapshot('owner_chat').inFlightSinceMs).toBeNull()
    expect(petSignals.snapshot('owner_chat').lastContactMs).toBe(1000)
  })
})
