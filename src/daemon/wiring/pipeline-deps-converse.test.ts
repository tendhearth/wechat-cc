import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPipelineDeps, resolveOwnerSessionKey } from './pipeline-deps'
import { Ref } from '../../lib/lifecycle'
import { openTestDb, type Db } from '../../lib/db'
import type { IlinkAdapter } from '../ilink-glue'
import type { Bootstrap } from '../bootstrap/index'
import { makeReplySinks, type ReplySinks } from '../reply-sinks'
import { makeChatMutex } from '../../core/async-mutex'
import type { ChatPrefsStore } from '../chat-prefs'
import type { CareLedger } from '../companion/care-ledger'
import type { InboundMsg } from '../../core/prompt-format'
import type { Mode } from '../../core/conversation'

// Task 2 HIGH-severity fix (app-conversation-channel spec §3): companionConverse
// must refuse to start an app turn while a WeChat turn is already in flight on
// the owner's session — otherwise both dispatch concurrently on one
// AgentSession. This file covers (a) the pure key-resolution helper the guard
// is built on, (b) an end-to-end exercise of the companionConverse closure
// itself against a minimally-faked Bootstrap/IlinkAdapter, and (c) the
// session-serialization follow-up (Task 2 of that plan): the app turn now
// holds the per-chat lock across the ENTIRE sink open→dispatchInner→close
// lifetime, so a same-chat WeChat/tick turn queued behind it cannot start —
// and therefore cannot have its reply captured by the still-open app sink —
// until the app turn's sink is closed.

describe('resolveOwnerSessionKey', () => {
  const baseDeps = {
    resolveProject: (chatId: string) => (chatId === 'chat1' ? { alias: 'proj1', path: '/tmp/proj1' } : null),
    defaultProviderId: 'claude',
  }

  it('solo mode → provider from mode.provider', () => {
    const getMode = (): Mode => ({ kind: 'solo', provider: 'codex' })
    expect(resolveOwnerSessionKey('chat1', { ...baseDeps, getMode })).toEqual({ alias: 'proj1', providerId: 'codex' })
  })

  it('primary_tool mode → provider from mode.primary', () => {
    const getMode = (): Mode => ({ kind: 'primary_tool', primary: 'cursor' })
    expect(resolveOwnerSessionKey('chat1', { ...baseDeps, getMode })).toEqual({ alias: 'proj1', providerId: 'cursor' })
  })

  it('parallel/chatroom mode → first participant, falling back to defaultProviderId', () => {
    const getModeWithParticipants = (): Mode => ({ kind: 'parallel', participants: ['codex', 'cursor'] })
    expect(resolveOwnerSessionKey('chat1', { ...baseDeps, getMode: getModeWithParticipants })).toEqual({ alias: 'proj1', providerId: 'codex' })

    const getModeNoParticipants = (): Mode => ({ kind: 'chatroom' })
    expect(resolveOwnerSessionKey('chat1', { ...baseDeps, getMode: getModeNoParticipants })).toEqual({ alias: 'proj1', providerId: 'claude' })
  })

  it('unresolvable project → null (nothing to guard; dispatch would also drop it)', () => {
    const getMode = (): Mode => ({ kind: 'solo', provider: 'claude' })
    expect(resolveOwnerSessionKey('unknown-chat', { ...baseDeps, getMode })).toBeNull()
  })
})

describe('companionConverse in-flight guard (buildPipelineDeps)', () => {
  let stateDir: string
  let db: Db

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'pipeline-deps-converse-test-'))
    mkdirSync(join(stateDir, 'companion'), { recursive: true })
    writeFileSync(join(stateDir, 'companion', 'config.json'), JSON.stringify({ enabled: true, default_chat_id: 'owner_chat' }))
    db = openTestDb()
  })

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true })
  })

  function setup(opts: { inFlight: boolean; mode?: Mode }) {
    // `dispatch` (the LOCKING entry point) must never be called by
    // companionConverse — calling it from inside runExclusive would
    // self-deadlock (see pipeline-deps.ts). Failing loudly here catches a
    // regression back to the pre-Task-2 `coordinator.dispatch(synthetic)` call.
    const dispatch = vi.fn(async (_msg: InboundMsg) => {
      throw new Error('unexpected: companionConverse must call dispatchInner, not the locking dispatch')
    })
    const dispatchInner = vi.fn(async (_msg: InboundMsg) => {})
    // Pass-through runExclusive for the two guard-focused tests below — the
    // dedicated lock-spans-sink test further down uses a REAL makeChatMutex.
    const runExclusive = vi.fn(<T,>(_chatId: string, fn: () => Promise<T>) => fn())
    // D3: submitTurn owns the lock + dispatch. Mock the queue-policy path (solo
    // mode): runExclusive around the within hook, whose dispatch closure calls
    // dispatchInner (NOT the locking dispatch — see the guard above).
    const submitTurn = vi.fn(<T,>(msg: InboundMsg, o?: { within?: (d: () => Promise<void>) => Promise<T> }) =>
      runExclusive(msg.chatId, () => (o?.within ? o.within(() => dispatchInner(msg)) : dispatchInner(msg))))
    const isInFlight = vi.fn(() => opts.inFlight)
    const replySinksOpen = vi.fn((_chatId: string) => ({ close: () => 'reply text' }))
    const replySinks: ReplySinks = { open: replySinksOpen, capture: vi.fn(() => false) }

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
      sessionState: {} as IlinkAdapter['sessionState'],
      flush: vi.fn(async () => {}),
    } as unknown as IlinkAdapter

    const boot = {
      sessionManager: { isInFlight } as unknown as Bootstrap['sessionManager'],
      sessionStore: {} as Bootstrap['sessionStore'],
      conversationStore: { upsertIdentity: vi.fn() } as unknown as Bootstrap['conversationStore'],
      registry: { get: vi.fn(), list: vi.fn(() => []), getCheapEval: vi.fn(() => null), has: vi.fn(() => false) } as unknown as Bootstrap['registry'],
      coordinator: {
        dispatch,
        dispatchInner,
        runExclusive,
        submitTurn,
        getMode: vi.fn((): Mode => opts.mode ?? { kind: 'solo', provider: 'claude' }),
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
    } as unknown as Bootstrap

    const chatPrefs: ChatPrefsStore = { get: () => ({}), set: () => ({}), list: () => [] }
    const careLedger: CareLedger = { get: () => ({ noReplyCount: 0 }), claim: vi.fn(), claimHunt: vi.fn(), resetNoReply: vi.fn() }

    const { companionConverse } = buildPipelineDeps(
      {
        stateDir,
        db,
        ilink,
        boot,
        log: () => {},
        chatPrefs,
        careLedger,
        replySinks,
      },
      {
        polling: new Ref('polling'),
        guard: new Ref('guard'),
        pipeline: new Ref('pipeline'),
        ingestNudge: new Ref('ingestNudge'),
      },
    )

    return { companionConverse, dispatch, dispatchInner, runExclusive, isInFlight, replySinksOpen }
  }

  it('refuses the app turn (reply_sink_busy) when the owner session is already in flight (e.g. a WeChat turn), WITHOUT dispatching, locking, or opening a reply sink', async () => {
    const { companionConverse, dispatch, dispatchInner, runExclusive, isInFlight, replySinksOpen } = setup({ inFlight: true })

    await expect(companionConverse('how are you')).rejects.toThrow('reply_sink_busy')

    expect(isInFlight).toHaveBeenCalledWith({ alias: 'proj1', providerId: 'claude', chatId: 'owner_chat' })
    expect(dispatch).not.toHaveBeenCalled()
    expect(dispatchInner).not.toHaveBeenCalled()
    expect(runExclusive).not.toHaveBeenCalled()
    expect(replySinksOpen).not.toHaveBeenCalled()
  })

  it('proceeds to runExclusive → open the reply sink → dispatchInner when the owner session is NOT in flight', async () => {
    const { companionConverse, dispatch, dispatchInner, runExclusive, replySinksOpen } = setup({ inFlight: false })

    const result = await companionConverse('how are you')

    expect(result).toEqual({ reply: 'reply text' })
    expect(runExclusive).toHaveBeenCalledTimes(1)
    expect(runExclusive.mock.calls[0]![0]).toBe('owner_chat')
    expect(dispatchInner).toHaveBeenCalledTimes(1)
    expect(replySinksOpen).toHaveBeenCalledWith('owner_chat')
    // The locking `dispatch` is never used by companionConverse — only
    // runExclusive + dispatchInner (self-deadlock avoidance).
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('rejects the app turn when the owner chat is in chatroom mode (D3 review follow-up) — no dispatch, no sink', async () => {
    const { companionConverse, dispatchInner, runExclusive, replySinksOpen } =
      setup({ inFlight: false, mode: { kind: 'chatroom', participants: ['claude', 'codex'] } })
    await expect(companionConverse('hi')).rejects.toThrow('owner_chat_in_chatroom_mode')
    expect(dispatchInner).not.toHaveBeenCalled()
    expect(runExclusive).not.toHaveBeenCalled()
    expect(replySinksOpen).not.toHaveBeenCalled()
  })
})

// Session-serialization design, Task 2: the app turn now holds the per-chat
// mutex across the sink's ENTIRE open→dispatchInner→close lifetime. This
// suite wires a REAL makeChatMutex + REAL makeReplySinks (not mocks) so the
// serialization guarantee is exercised end to end, not merely asserted by
// call-order stubs: a same-chat WeChat turn fired mid-app-turn goes through
// the LOCKING `coordinator.dispatch` (exactly like a real inbound would) and
// must queue behind the app turn's runExclusive call.
describe('companionConverse lock spans the sink lifetime (real mutex + real replySinks)', () => {
  let stateDir: string
  let db: Db

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'pipeline-deps-converse-lock-test-'))
    mkdirSync(join(stateDir, 'companion'), { recursive: true })
    writeFileSync(join(stateDir, 'companion', 'config.json'), JSON.stringify({ enabled: true, default_chat_id: 'owner_chat' }))
    db = openTestDb()
  })

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('a same-chat dispatch fired mid-app-turn does not start until the app sink is closed, and does not contaminate the app reply', async () => {
    const mutex = makeChatMutex()
    const replySinks = makeReplySinks()
    const order: string[] = []
    const ilinkSendMessage = vi.fn(async (_chatId: string, _text: string) => ({ msgId: '1' }))

    // eslint-disable-next-line prefer-const -- `coordinator` is referenced by
    // dispatchInnerImpl's closure but only ever CALLED after assignment below.
    let coordinator: Bootstrap['coordinator']
    // Captured so the test can await the fired-off WeChat turn to
    // completion (it's intentionally NOT awaited inside dispatchInnerImpl —
    // a real WeChat poll-loop inbound wouldn't block on it either).
    let wechatDispatchPromise: Promise<void> | undefined

    const dispatchInnerImpl = vi.fn(async (msg: InboundMsg) => {
      if (msg.text === 'how are you') {
        // This is the APP turn, running inside companionConverse's
        // runExclusive critical section. Simulate its agent calling the
        // `reply` tool (captured by the still-open app sink), THEN fire a
        // WeChat inbound racing on the SAME chat — via the LOCKING
        // `dispatch`, exactly like a real WeChat poll-loop turn would.
        order.push('app-turn-started')
        replySinks.capture(msg.chatId, 'app reply text')
        wechatDispatchPromise = coordinator.dispatch({ ...msg, text: 'wechat inbound', userId: 'someone_else' })
        order.push('app-turn-finishing')
        return
      }
      // This is the WeChat turn. If it starts before the app sink closes,
      // replySinks.capture would (wrongly) steal its reply into the app's
      // sink; the lock-spans-sink fix makes that impossible — it can only
      // ever observe the sink as already closed here.
      order.push('wechat-turn-started')
      if (!replySinks.capture(msg.chatId, 'wechat reply text')) {
        await ilinkSendMessage(msg.chatId, 'wechat reply text')
      }
      order.push('wechat-turn-finished')
    })

    coordinator = {
      dispatch: (msg: InboundMsg) => mutex.runExclusive(msg.chatId, () => dispatchInnerImpl(msg)),
      dispatchInner: dispatchInnerImpl,
      runExclusive: mutex.runExclusive.bind(mutex),
      // D3: submitTurn owns lock + dispatch (real mutex here) — the app turn's
      // within hook (sink open→dispatch→close) runs inside runExclusive, so the
      // mid-turn WeChat dispatch queues behind it exactly as before.
      submitTurn: (<T,>(msg: InboundMsg, o?: { within?: (d: () => Promise<void>) => Promise<T> }) =>
        mutex.runExclusive(msg.chatId, () => (o?.within ? o.within(() => dispatchInnerImpl(msg)) : dispatchInnerImpl(msg)) as Promise<T>)),
      getMode: vi.fn((): Mode => ({ kind: 'solo', provider: 'claude' })),
      cancel: vi.fn(() => false),
    } as unknown as Bootstrap['coordinator']

    const ilink = {
      sendMessage: ilinkSendMessage,
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
      sessionState: {} as IlinkAdapter['sessionState'],
      flush: vi.fn(async () => {}),
    } as unknown as IlinkAdapter

    const boot = {
      sessionManager: { isInFlight: () => false } as unknown as Bootstrap['sessionManager'],
      sessionStore: {} as Bootstrap['sessionStore'],
      conversationStore: { upsertIdentity: vi.fn() } as unknown as Bootstrap['conversationStore'],
      registry: { get: vi.fn(), list: vi.fn(() => []), getCheapEval: vi.fn(() => null), has: vi.fn(() => false) } as unknown as Bootstrap['registry'],
      coordinator,
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
    } as unknown as Bootstrap

    const chatPrefs: ChatPrefsStore = { get: () => ({}), set: () => ({}), list: () => [] }
    const careLedger: CareLedger = { get: () => ({ noReplyCount: 0 }), claim: vi.fn(), claimHunt: vi.fn(), resetNoReply: vi.fn() }

    const { companionConverse } = buildPipelineDeps(
      { stateDir, db, ilink, boot, log: () => {}, chatPrefs, careLedger, replySinks },
      { polling: new Ref('polling'), guard: new Ref('guard'), pipeline: new Ref('pipeline'), ingestNudge: new Ref('ingestNudge') },
    )

    const result = await companionConverse('how are you')
    // Wait for the fired-off WeChat turn to finish too — it's intentionally
    // not awaited by the app turn (a real inbound wouldn't be either), but
    // the test needs it settled before asserting `order`/`ilinkSendMessage`.
    await wechatDispatchPromise

    // The app reply is exactly the app turn's own captured text — never the
    // WeChat turn's, because the WeChat turn cannot even start until the app
    // sink has already been closed.
    expect(result).toEqual({ reply: 'app reply text' })
    // Strict ordering: the WeChat turn's dispatchInner body runs strictly
    // AFTER the app turn's dispatchInner body has fully finished (which is
    // what lets companionConverse close the sink) — proving runExclusive's
    // lock spans the sink, not just the isInFlight pre-check.
    expect(order).toEqual(['app-turn-started', 'app-turn-finishing', 'wechat-turn-started', 'wechat-turn-finished'])
    // By the time the WeChat turn ran, the app sink was already closed, so
    // its reply correctly fell through to the real WeChat send path.
    expect(ilinkSendMessage).toHaveBeenCalledWith('owner_chat', 'wechat reply text')
  })
})
