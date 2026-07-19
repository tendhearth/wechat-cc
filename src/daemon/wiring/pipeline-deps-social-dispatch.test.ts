import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Async foraging spine (Task 9) — the `dispatch.coordinator.dispatch` seam in
// pipeline-deps.ts intercepts the operator's WeChat "揭晓 <id>" reply before
// it reaches a normal agent turn. `isAdmin` (src/lib/access.ts) reads
// access.json from the module-level STATE_DIR (src/lib/config.ts), which is
// NOT one of buildPipelineDeps's injectable opts — so, mirroring
// src/lib/access.test.ts, STATE_DIR is redirected to a temp dir via
// vi.mock BEFORE anything imports access.ts/config.ts, and pipeline-deps is
// loaded dynamically afterward so it (transitively) picks up the mock.
const ACCESS_STATE_DIR = mkdtempSync(join(tmpdir(), 'pipeline-deps-social-access-test-'))
vi.mock('../../lib/config.ts', () => ({
  STATE_DIR: ACCESS_STATE_DIR,
  ILINK_BASE_URL: 'https://ilinkai.weixin.qq.com',
  ILINK_APP_ID: 'bot',
  ILINK_BOT_TYPE: '3',
  LONG_POLL_TIMEOUT_MS: 35_000,
}))

const { buildPipelineDeps } = await import('./pipeline-deps')
const { Ref } = await import('../../lib/lifecycle')
const { openTestDb } = await import('../../lib/db')
const { makeReplySinks } = await import('../reply-sinks')

import type { Bootstrap } from '../bootstrap/index'
import type { IlinkAdapter } from '../ilink-glue'
import type { ChatPrefsStore } from '../chat-prefs'
import type { CareLedger } from '../companion/care-ledger'
import type { InboundMsg } from '../../core/prompt-format'
import type { Mode } from '../../core/conversation'

const ACCESS_FILE = join(ACCESS_STATE_DIR, 'access.json')
function writeAccess(admins: string[]): void {
  writeFileSync(ACCESS_FILE, JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [], admins }, null, 2))
}

// A revealer stub that records calls and lets the test choose whether the echo
// lookup "exists" (non-null) so the pledge fallback path is exercised.
// `pledgeReturns` additionally lets a test drive BOTH lookups to null (T9:
// neither an echo nor a pledge matched — a typo'd/expired/already-connected
// id), which must NOT stay silent.
function makeRevealerStub(echoReturns: 'ok' | 'null', pledgeReturns: 'ok' | 'null' = 'ok') {
  const calls: Array<[string, string]> = []
  return {
    calls,
    revealer: {
      revealEcho: vi.fn(async (id: string) => { calls.push(['echo', id]); return echoReturns === 'ok' ? { state: 'connected' as const } : null }),
      revealPledge: vi.fn(async (id: string) => { calls.push(['pledge', id]); return pledgeReturns === 'ok' ? { state: 'awaiting_peer' as const } : null }),
      onInboundReveal: vi.fn(() => ({ mutual: false })),
    },
  }
}

// Shared cleanup for ACCESS_STATE_DIR — a single top-level afterAll (not
// nested in either describe below) so it fires once, after every test in
// this file has run, regardless of which describe block runs last.
afterAll(() => { rmSync(ACCESS_STATE_DIR, { recursive: true, force: true }) })

describe('pipeline-deps social dispatch seam (揭晓 reveal)', () => {
  let stateDir: string
  beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'pipeline-deps-social-test-')); writeAccess(['op_chat']) })

  function setup(social: Bootstrap['social'], penpal?: Bootstrap['penpal']) {
    const db = openTestDb()
    const coordinatorDispatch = vi.fn(async (_msg: InboundMsg) => {})
    const sendAssistantText = vi.fn(async (_chatId: string, _text: string) => {})
    const boot = {
      sessionManager: { isInFlight: vi.fn(() => false) } as unknown as Bootstrap['sessionManager'],
      sessionStore: {} as Bootstrap['sessionStore'],
      conversationStore: { upsertIdentity: vi.fn() } as unknown as Bootstrap['conversationStore'],
      registry: { get: vi.fn(), list: vi.fn(() => []), getCheapEval: vi.fn(() => null), has: vi.fn(() => false) } as unknown as Bootstrap['registry'],
      coordinator: { dispatch: coordinatorDispatch, getMode: vi.fn((): Mode => ({ kind: 'solo', provider: 'claude' })), cancel: vi.fn(() => false) } as unknown as Bootstrap['coordinator'],
      resolve: vi.fn(() => null),
      formatInbound: vi.fn() as unknown as Bootstrap['formatInbound'],
      sdkOptionsForProject: vi.fn() as unknown as Bootstrap['sdkOptionsForProject'],
      buildInstructions: vi.fn(() => ''),
      defaultProviderId: 'claude',
      agentProviderKind: 'claude',
      dispatchDelegate: vi.fn() as unknown as Bootstrap['dispatchDelegate'],
      a2aDeps: undefined,
      a2aServer: null,
      agentConfig: { bot_name: null } as unknown as Bootstrap['agentConfig'],
      sendAssistantText,
      social,
      penpal,
    } as unknown as Bootstrap

    const ilink = {} as unknown as IlinkAdapter
    const chatPrefs: ChatPrefsStore = { get: () => ({}), set: () => ({}), list: () => [] }
    const careLedger: CareLedger = { get: () => ({ noReplyCount: 0 }), claim: vi.fn(), claimHunt: vi.fn(), resetNoReply: vi.fn() }
    const replySinks = makeReplySinks()
    const { pipelineDeps } = buildPipelineDeps(
      { stateDir, db, ilink, boot, log: () => {}, chatPrefs, careLedger, replySinks },
      { polling: new Ref('polling'), guard: new Ref('guard'), pipeline: new Ref('pipeline'), ingestNudge: new Ref('ingestNudge') },
    )
    return { pipelineDeps, coordinatorDispatch, sendAssistantText }
  }

  // Minimal social object satisfying Bootstrap['social'] for the seam (only
  // `revealer` is exercised; the rest are no-op stubs).
  function socialWith(revealer: any): Bootstrap['social'] {
    return {
      broker: { seek: vi.fn(async () => ({ intent_id: 'x' })) },
      seekStore: { create() {}, update() {}, list: () => [], get: () => null },
      echoStore: { create() {}, setStatus() {}, setSelfRevealed() {}, setPeerRevealed() {}, setRevealedIdentity() {}, listForSeek: () => [], listAll: () => [], get: () => null },
      pledgeStore: { create() {}, get: () => null, list: () => [], setSelfRevealed() {}, setPeerRevealed() {} },
      revealer,
    } as unknown as Bootstrap['social']
  }

  const baseMsg: InboundMsg = { chatId: 'op_chat', userId: 'op_chat', text: '揭晓 i1:ccb', msgType: 'text', createTimeMs: Date.now(), accountId: 'acct1' }

  it('a "揭晓 <id>" from the admin chat triggers revealEcho and is NOT dispatched as a normal turn', async () => {
    const { calls, revealer } = makeRevealerStub('ok')
    const { pipelineDeps, coordinatorDispatch, sendAssistantText } = setup(socialWith(revealer))
    await pipelineDeps.dispatch.coordinator.dispatch(baseMsg)
    expect(calls).toEqual([['echo', 'i1:ccb']])
    expect(coordinatorDispatch).not.toHaveBeenCalled()
    // T9 — the id WAS found (revealEcho succeeded), so no "not found" reply.
    expect(sendAssistantText).not.toHaveBeenCalled()
  })

  it('falls back to revealPledge when the echo lookup returns null', async () => {
    const { calls, revealer } = makeRevealerStub('null')
    const { pipelineDeps, coordinatorDispatch, sendAssistantText } = setup(socialWith(revealer))
    await pipelineDeps.dispatch.coordinator.dispatch(baseMsg)
    expect(calls).toEqual([['echo', 'i1:ccb'], ['pledge', 'i1:ccb']])
    expect(coordinatorDispatch).not.toHaveBeenCalled()
    // The pledge fallback DID find it, so still no "not found" reply.
    expect(sendAssistantText).not.toHaveBeenCalled()
  })

  // T9 — a typo'd/expired/already-connected id matches neither the echo NOR
  // the pledge side. Previously the message was silently consumed; now the
  // operator gets a one-line "not found" reply instead of dead silence.
  it('replies with a "not found" message when BOTH revealEcho and revealPledge return null', async () => {
    const { calls, revealer } = makeRevealerStub('null', 'null')
    const { pipelineDeps, coordinatorDispatch, sendAssistantText } = setup(socialWith(revealer))
    await pipelineDeps.dispatch.coordinator.dispatch(baseMsg)
    expect(calls).toEqual([['echo', 'i1:ccb'], ['pledge', 'i1:ccb']])
    expect(coordinatorDispatch).not.toHaveBeenCalled()
    expect(sendAssistantText).toHaveBeenCalledTimes(1)
    const [chatId, text] = sendAssistantText.mock.calls[0]!
    expect(chatId).toBe('op_chat')
    expect(text).toContain('i1:ccb')
  })

  it('a non-command message falls through to a normal turn', async () => {
    const { revealer } = makeRevealerStub('ok')
    const { pipelineDeps, coordinatorDispatch } = setup(socialWith(revealer))
    await pipelineDeps.dispatch.coordinator.dispatch({ ...baseMsg, text: '今天几点见面?' })
    expect(coordinatorDispatch).toHaveBeenCalledTimes(1)
    expect(revealer.revealEcho).not.toHaveBeenCalled()
  })

  it('no boot.social → always a normal turn', async () => {
    const { pipelineDeps, coordinatorDispatch } = setup(undefined)
    await pipelineDeps.dispatch.coordinator.dispatch(baseMsg)
    expect(coordinatorDispatch).toHaveBeenCalledTimes(1)
  })

  it('a 揭晓 from a NON-admin chat is never consumed', async () => {
    const { revealer } = makeRevealerStub('ok')
    const { pipelineDeps, coordinatorDispatch } = setup(socialWith(revealer))
    await pipelineDeps.dispatch.coordinator.dispatch({ ...baseMsg, chatId: 'someone_else', userId: 'someone_else' })
    expect(coordinatorDispatch).toHaveBeenCalledTimes(1)
    expect(revealer.revealEcho).not.toHaveBeenCalled()
  })
})

// Task 10 — the owner's WeChat "回信 <channel> <text>" reply sends an
// outbound letter on that pen-pal channel instead of dispatching a normal
// agent turn. Mirrors the 揭晓 harness above; boot.penpal is optional and the
// seam guards on it (Task 11 supplies the REAL correspondent-backed penpal).
describe('pipeline-deps social dispatch seam (回信 letter reply)', () => {
  let stateDir: string
  beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'pipeline-deps-social-test-')); writeAccess(['op_chat']) })

  function setup(penpal: Bootstrap['penpal']) {
    const db = openTestDb()
    const coordinatorDispatch = vi.fn(async (_msg: InboundMsg) => {})
    const sendAssistantText = vi.fn(async (_chatId: string, _text: string) => {})
    const boot = {
      sessionManager: { isInFlight: vi.fn(() => false) } as unknown as Bootstrap['sessionManager'],
      sessionStore: {} as Bootstrap['sessionStore'],
      conversationStore: { upsertIdentity: vi.fn() } as unknown as Bootstrap['conversationStore'],
      registry: { get: vi.fn(), list: vi.fn(() => []), getCheapEval: vi.fn(() => null), has: vi.fn(() => false) } as unknown as Bootstrap['registry'],
      coordinator: { dispatch: coordinatorDispatch, getMode: vi.fn((): Mode => ({ kind: 'solo', provider: 'claude' })), cancel: vi.fn(() => false) } as unknown as Bootstrap['coordinator'],
      resolve: vi.fn(() => null),
      formatInbound: vi.fn() as unknown as Bootstrap['formatInbound'],
      sdkOptionsForProject: vi.fn() as unknown as Bootstrap['sdkOptionsForProject'],
      buildInstructions: vi.fn(() => ''),
      defaultProviderId: 'claude',
      agentProviderKind: 'claude',
      dispatchDelegate: vi.fn() as unknown as Bootstrap['dispatchDelegate'],
      a2aDeps: undefined,
      a2aServer: null,
      agentConfig: { bot_name: null } as unknown as Bootstrap['agentConfig'],
      sendAssistantText,
      social: undefined,
      penpal,
    } as unknown as Bootstrap

    const ilink = {} as unknown as IlinkAdapter
    const chatPrefs: ChatPrefsStore = { get: () => ({}), set: () => ({}), list: () => [] }
    const careLedger: CareLedger = { get: () => ({ noReplyCount: 0 }), claim: vi.fn(), claimHunt: vi.fn(), resetNoReply: vi.fn() }
    const replySinks = makeReplySinks()
    const { pipelineDeps } = buildPipelineDeps(
      { stateDir, db, ilink, boot, log: () => {}, chatPrefs, careLedger, replySinks },
      { polling: new Ref('polling'), guard: new Ref('guard'), pipeline: new Ref('pipeline'), ingestNudge: new Ref('ingestNudge') },
    )
    return { pipelineDeps, coordinatorDispatch, sendAssistantText }
  }

  function fakePenpal(ok: boolean): Bootstrap['penpal'] {
    return { sendLetter: vi.fn(async (_channel: string, _text: string) => ({ ok, ...(ok ? {} : { error: 'channel_not_open' }) })) }
  }

  const letterMsg: InboundMsg = { chatId: 'op_chat', userId: 'op_chat', text: '回信 c1 你好啊', msgType: 'text', createTimeMs: Date.now(), accountId: 'acct1' }

  it('a "回信 <channel> <text>" from the admin chat calls sendLetter and is NOT dispatched as a normal turn', async () => {
    const penpal = fakePenpal(true)
    const { pipelineDeps, coordinatorDispatch, sendAssistantText } = setup(penpal)
    await pipelineDeps.dispatch.coordinator.dispatch(letterMsg)
    expect(penpal!.sendLetter).toHaveBeenCalledWith('c1', '你好啊')
    expect(coordinatorDispatch).not.toHaveBeenCalled()
    expect(sendAssistantText).not.toHaveBeenCalled()
  })

  it('a "回信" from a NON-admin chat is never consumed', async () => {
    const penpal = fakePenpal(true)
    const { pipelineDeps, coordinatorDispatch } = setup(penpal)
    await pipelineDeps.dispatch.coordinator.dispatch({ ...letterMsg, chatId: 'someone_else', userId: 'someone_else' })
    expect(coordinatorDispatch).toHaveBeenCalledTimes(1)
    expect(penpal!.sendLetter).not.toHaveBeenCalled()
  })

  it('replies with a gentle failure message when sendLetter returns { ok: false }', async () => {
    const penpal = fakePenpal(false)
    const { pipelineDeps, coordinatorDispatch, sendAssistantText } = setup(penpal)
    await pipelineDeps.dispatch.coordinator.dispatch(letterMsg)
    expect(coordinatorDispatch).not.toHaveBeenCalled()
    expect(sendAssistantText).toHaveBeenCalledTimes(1)
    const [chatId, text] = sendAssistantText.mock.calls[0]!
    expect(chatId).toBe('op_chat')
    expect(text).toMatch(/没找到这条笔友通道|发送失败/)
  })

  it('no boot.penpal → always a normal turn, even for a well-formed 回信', async () => {
    const { pipelineDeps, coordinatorDispatch } = setup(undefined)
    await pipelineDeps.dispatch.coordinator.dispatch(letterMsg)
    expect(coordinatorDispatch).toHaveBeenCalledTimes(1)
  })

  it('a non-command message falls through to a normal turn', async () => {
    const penpal = fakePenpal(true)
    const { pipelineDeps, coordinatorDispatch } = setup(penpal)
    await pipelineDeps.dispatch.coordinator.dispatch({ ...letterMsg, text: '今天几点见面?' })
    expect(coordinatorDispatch).toHaveBeenCalledTimes(1)
    expect(penpal!.sendLetter).not.toHaveBeenCalled()
  })
})
