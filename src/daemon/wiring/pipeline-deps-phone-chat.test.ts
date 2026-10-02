import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPipelineDeps } from './pipeline-deps'
import { Ref } from '../../lib/lifecycle'
import { openTestDb, type Db } from '../../lib/db'
import { makeReplySinks } from '../reply-sinks'
import { makeChatMutex } from '../../core/async-mutex'
import { makeMatterStore } from '../../core/matters/store'
import { makeMessagesStore } from '../../lib/messages-store'
import type { IlinkAdapter } from '../ilink-glue'
import type { Bootstrap } from '../bootstrap/index'
import type { ChatPrefsStore } from '../chat-prefs'
import type { CareLedger } from '../companion/care-ledger'
import type { InboundMsg } from '../../core/prompt-format'
import type { Mode } from '../../core/conversation'

/**
 * 手机「跟 CC 说」的接线(plan 2026-10-01 Task 4):phoneChat 的 converse 必须是回合串行入口
 * companionConverse —— 与微信 / 桌面同一条(isInFlight 前置拒 + coordinator.submitTurn 持每 chat 锁)。
 * 钉住:手机一句走 submitTurn、微信一轮在飞时手机一句判 busy 不并跑、锁被微信占着时手机一句排队。
 */

// ownerChatId() 读 access.admins —— 纯内存替身,不碰真 access.json(MEMORY「Test pollution → live access.json」)。
vi.mock('../../lib/access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/access')>()),
  loadAccess: () => ({ dmPolicy: 'allowlist', admins: ['owner_chat'], allowFrom: ['owner_chat'] }),
  isAdmin: (chatId: string) => chatId === 'owner_chat',
}))

const fakeHealth = { health: { shouldSuspend: () => false, get: () => ({ consecutiveFailures: 0 }) } } as unknown as Bootstrap['health']
const RID = '00000000-0000-4000-8000-0000000000aa'
const settle = () => new Promise(r => setTimeout(r, 0))

describe('phoneChat 走 companionConverse(回合串行入口)', () => {
  let stateDir: string
  let db: Db

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'pipeline-deps-phone-chat-test-'))
    mkdirSync(join(stateDir, 'companion'), { recursive: true })
    writeFileSync(join(stateDir, 'companion', 'config.json'), JSON.stringify({ enabled: true, default_chat_id: 'owner_chat' }))
    db = openTestDb()
  })
  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }) })

  function setup(o: { inFlight?: boolean; submitTurn?: (msg: InboundMsg, opt?: { within?: (d: () => Promise<void>) => Promise<unknown> }) => Promise<unknown>; dispatchInner?: (msg: InboundMsg) => Promise<void> } = {}) {
    const replySinks = makeReplySinks()
    const dispatchInner = vi.fn(o.dispatchInner ?? (async (msg: InboundMsg) => { replySinks.capture(msg.chatId, 'cc reply') }))
    const submitTurn = vi.fn(o.submitTurn ?? (<T,>(msg: InboundMsg, opt?: { within?: (d: () => Promise<void>) => Promise<T> }) =>
      (opt?.within ? opt.within(() => dispatchInner(msg)) : dispatchInner(msg) as unknown as Promise<T>)))
    const ilink = { resolveAccountId: vi.fn(() => 'acct1'), sendMessage: vi.fn(async () => ({ msgId: '1' })) } as unknown as IlinkAdapter
    const boot = {
      sessionManager: { isInFlight: vi.fn(() => o.inFlight ?? false) } as unknown as Bootstrap['sessionManager'],
      sessionStore: {} as Bootstrap['sessionStore'],
      conversationStore: { upsertIdentity: vi.fn() } as unknown as Bootstrap['conversationStore'],
      registry: { get: vi.fn(), list: vi.fn(() => []), getCheapEval: vi.fn(() => null), has: vi.fn(() => false) } as unknown as Bootstrap['registry'],
      coordinator: {
        dispatch: vi.fn(async () => { throw new Error('unexpected: locking dispatch') }),
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
    const careLedger: CareLedger = { get: () => ({ noReplyCount: 0 }), claim: vi.fn(), claimHunt: vi.fn(), claimVisit: vi.fn(), claimMemory: vi.fn(), resetNoReply: vi.fn(), restore: vi.fn() }
    const matters = makeMatterStore(db)
    const built = buildPipelineDeps(
      { stateDir, db, ilink, boot, log: () => {}, chatPrefs, careLedger, replySinks, matters },
      { polling: new Ref('polling'), guard: new Ref('guard'), pipeline: new Ref('pipeline'), ingestNudge: new Ref('ingestNudge') },
    )
    return { ...built, submitTurn, dispatchInner, matters }
  }

  it('手机一句经 coordinator.submitTurn 跑在主人 chat 上,回话落库 source=phone,手机露面登记', async () => {
    const { phoneChat, submitTurn, matters } = setup()
    const job = phoneChat!.say(RID, 'hi from phone')
    expect(job.status).toBe('pending')
    for (let i = 0; i < 5 && phoneChat!.state().pending; i++) await settle()
    expect(phoneChat!.state()).toEqual({ pending: null, failed: null })
    expect(submitTurn).toHaveBeenCalledTimes(1)
    expect(submitTurn.mock.calls[0]![0]).toMatchObject({ chatId: 'owner_chat', text: 'hi from phone' })
    expect(matters.bindings(job.matterId).map(b => b.surface)).toContain('phone')
    await settle()
    const rows = await makeMessagesStore(db).listRange('owner_chat', { limit: 10 })
    expect(rows.map(r => [r.direction, r.text, r.source])).toEqual([['in', 'hi from phone', 'phone'], ['out', 'cc reply', 'phone']])
  })

  it('微信一轮正在主人会话上飞 ⇒ 手机一句判 busy,不进 submitTurn(不并跑)', async () => {
    const { phoneChat, submitTurn } = setup({ inFlight: true })
    phoneChat!.say(RID, 'hi')
    for (let i = 0; i < 5 && phoneChat!.state().pending; i++) await settle()
    expect(phoneChat!.state().failed).toMatchObject({ requestId: RID, status: 'failed', error: 'busy' })
    expect(submitTurn).not.toHaveBeenCalled()
  })

  it('每 chat 锁被微信一轮占着 ⇒ 手机一句排在它后面,不和它交叠', async () => {
    const mutex = makeChatMutex()
    const order: string[] = []
    let releaseWechat!: () => void
    const dispatchInner = async (msg: InboundMsg) => {
      if (msg.text === 'wechat') { order.push('wechat-start'); await new Promise<void>(r => { releaseWechat = r }); order.push('wechat-end') }
      else order.push('phone-turn')
    }
    const { phoneChat } = setup({
      dispatchInner,
      submitTurn: (msg, opt) => mutex.runExclusive(msg.chatId, () => (opt?.within ? opt.within(() => dispatchInner(msg)) : dispatchInner(msg))),
    })
    const wechat = mutex.runExclusive('owner_chat', () => dispatchInner({ chatId: 'owner_chat', userId: 'owner_chat', text: 'wechat', msgType: 'text', createTimeMs: 1, accountId: 'acct1' }))
    await settle()
    phoneChat!.say(RID, 'phone')
    for (let i = 0; i < 5; i++) await settle()
    expect(order).toEqual(['wechat-start'])
    releaseWechat()
    await wechat
    for (let i = 0; i < 5 && phoneChat!.state().pending; i++) await settle()
    expect(order).toEqual(['wechat-start', 'wechat-end', 'phone-turn'])
  })
})
