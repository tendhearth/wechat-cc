import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPipelineDeps, resolveOwnerSessionKey } from './pipeline-deps'
import { Ref } from '../../lib/lifecycle'
import { openTestDb, type Db } from '../../lib/db'
import type { IlinkAdapter } from '../ilink-glue'
import type { Bootstrap } from '../bootstrap/index'
import type { ReplySinks } from '../reply-sinks'
import type { ChatPrefsStore } from '../chat-prefs'
import type { CareLedger } from '../companion/care-ledger'
import type { InboundMsg } from '../../core/prompt-format'
import type { Mode } from '../../core/conversation'

// Task 2 HIGH-severity fix (app-conversation-channel spec §3): companionConverse
// must refuse to start an app turn while a WeChat turn is already in flight on
// the owner's session — otherwise both dispatch concurrently on one
// AgentSession. This file covers (a) the pure key-resolution helper the guard
// is built on, and (b) an end-to-end exercise of the companionConverse closure
// itself against a minimally-faked Bootstrap/IlinkAdapter.

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

  function setup(opts: { inFlight: boolean }) {
    const dispatch = vi.fn(async (_msg: InboundMsg) => {})
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
      },
    )

    return { companionConverse, dispatch, isInFlight, replySinksOpen }
  }

  it('refuses the app turn (reply_sink_busy) when the owner session is already in flight (e.g. a WeChat turn), WITHOUT dispatching or opening a reply sink', async () => {
    const { companionConverse, dispatch, isInFlight, replySinksOpen } = setup({ inFlight: true })

    await expect(companionConverse('how are you')).rejects.toThrow('reply_sink_busy')

    expect(isInFlight).toHaveBeenCalledWith({ alias: 'proj1', providerId: 'claude', chatId: 'owner_chat' })
    expect(dispatch).not.toHaveBeenCalled()
    expect(replySinksOpen).not.toHaveBeenCalled()
  })

  it('proceeds to dispatch + open the reply sink when the owner session is NOT in flight', async () => {
    const { companionConverse, dispatch, replySinksOpen } = setup({ inFlight: false })

    const result = await companionConverse('how are you')

    expect(result).toEqual({ reply: 'reply text' })
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(replySinksOpen).toHaveBeenCalledWith('owner_chat')
  })
})
