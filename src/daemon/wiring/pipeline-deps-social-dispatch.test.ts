import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The `dispatch.coordinator.dispatch` seam in pipeline-deps.ts intercepts an
// owner control command ("回信 <ch> <text>" / "派 <ref>" / "取消 <ref>") before
// it reaches a normal agent turn. `isAdmin` (src/lib/access.ts) reads
// access.json from the module-level STATE_DIR (src/lib/config.ts), which is
// NOT one of buildPipelineDeps's injectable opts — so, mirroring
// src/lib/access.test.ts, STATE_DIR is redirected to a temp dir via
// vi.mock BEFORE anything imports access.ts/config.ts, and pipeline-deps is
// loaded dynamically afterward so it (transitively) picks up the mock.
const ACCESS_STATE_DIR = mkdtempSync(join(tmpdir(), 'pipeline-deps-social-access-test-'))
// importOriginal + spread (fix round 2, hardening) — same rationale as
// pipeline-deps-pairing-dispatch.test.ts: a plain-object factory would
// silently drop UNDER_TEST_RUNNER (and any other config.ts export) in this
// module graph, defeating agy-mcp-config.ts's/providers.ts's test-runner
// guards (fix round 1) should this graph ever boot providers.
vi.mock('../../lib/config.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/config')>()
  return { ...actual, STATE_DIR: ACCESS_STATE_DIR }
})

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

// Connection-health (Task 9) — buildPipelineDeps dereferences boot.health.health
// unconditionally (llmHealth mw dep), so every `boot` fixture needs a minimal
// stand-in even though these tests never exercise the health machine itself.
const fakeHealth = {
  health: { shouldSuspend: () => false, get: () => ({ consecutiveFailures: 0 }) },
} as unknown as Bootstrap['health']

const ACCESS_FILE = join(ACCESS_STATE_DIR, 'access.json')
function writeAccess(admins: string[]): void {
  writeFileSync(ACCESS_FILE, JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [], admins }, null, 2))
}

// Shared cleanup for ACCESS_STATE_DIR — a single top-level afterAll (not
// nested in either describe below) so it fires once, after every test in
// this file has run, regardless of which describe block runs last.
afterAll(() => { rmSync(ACCESS_STATE_DIR, { recursive: true, force: true }) })

// Task 10 — the owner's WeChat "回信 <channel> <text>" reply sends an
// outbound letter on that pen-pal channel instead of dispatching a normal
// agent turn. boot.penpal is optional and the seam guards on it (Task 11
// supplies the REAL correspondent-backed penpal).
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
      health: fakeHealth,
    } as unknown as Bootstrap

    const ilink = {} as unknown as IlinkAdapter
    const chatPrefs: ChatPrefsStore = { get: () => ({}), set: () => ({}), list: () => [] }
    const careLedger: CareLedger = { get: () => ({ noReplyCount: 0 }), claim: vi.fn(), claimHunt: vi.fn(), claimVisit: vi.fn(), resetNoReply: vi.fn() }
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

// 派心愿 (spec 2026-09-04-wish-postcard) — the owner's WeChat "派 <ref>" /
// "取消 <ref>" reply sends / cancels a wish instead of dispatching a normal
// agent turn. This file's job is the WIRING: that pipeline-deps hands the
// router a `social` made of exactly `{ wish, penpal }` from `boot.social`,
// and that the router's outcomes reach the owner. (The per-outcome copy is
// unit-tested in command-router.test.ts.) `派` is ALREADY the delegate
// imperative (admin-commands.ts's DELEGATE_RE: 让/派 <hand> 执行/跑 <task>) —
// the mandatory regression case below proves the id-charset guard in
// parseSeekCommand keeps a delegate command from ever reaching the wish.
describe('pipeline-deps social dispatch seam (派/取消 wish)', () => {
  let stateDir: string
  beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'pipeline-deps-social-test-')); writeAccess(['op_chat']) })

  function socialWithWish() {
    const resolveRef = vi.fn((ref: string) => (ref.startsWith('3f9a2b') ? { ok: true as const, id: '3f9a2bcccc' } : { ok: false as const, reason: 'not_found' as const }))
    const send = vi.fn(async (_id: string) => ({ ok: true as const, sentTo: 2 }))
    const cancel = vi.fn((_id: string) => ({ ok: true as const, status: 'cancelled' as const }))
    const startVisit = vi.fn(async () => ({ ok: true as const, id: 'v1', channel: 'c1' }))
    const social = {
      wish: { propose: vi.fn(), send, cancel, list: vi.fn(() => []), resolveRef },
      penpal: {
        sendLetter: vi.fn(async () => ({ ok: true })), resendLetter: vi.fn(async () => ({ ok: true })),
        channelStore: {}, letterStore: {}, startVisit, activeVisit: () => null,
      },
    } as unknown as Bootstrap['social']
    return { social, resolveRef, send, cancel, startVisit }
  }

  function setup(social: Bootstrap['social']) {
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
      penpal: undefined,
      health: fakeHealth,
    } as unknown as Bootstrap

    const ilink = {} as unknown as IlinkAdapter
    const chatPrefs: ChatPrefsStore = { get: () => ({}), set: () => ({}), list: () => [] }
    const careLedger: CareLedger = { get: () => ({ noReplyCount: 0 }), claim: vi.fn(), claimHunt: vi.fn(), claimVisit: vi.fn(), resetNoReply: vi.fn() }
    const replySinks = makeReplySinks()
    const { pipelineDeps } = buildPipelineDeps(
      { stateDir, db, ilink, boot, log: () => {}, chatPrefs, careLedger, replySinks },
      { polling: new Ref('polling'), guard: new Ref('guard'), pipeline: new Ref('pipeline'), ingestNudge: new Ref('ingestNudge') },
    )
    return { pipelineDeps, coordinatorDispatch, sendAssistantText }
  }

  const msg = (text: string, chatId = 'op_chat'): InboundMsg => ({ chatId, userId: chatId, text, msgType: 'text', createTimeMs: Date.now(), accountId: 'acct1' })

  it('admin 派 <prefix> → wish.resolveRef among draft then wish.send(fullId), no coordinator dispatch', async () => {
    const { social, resolveRef, send } = socialWithWish()
    const { pipelineDeps, coordinatorDispatch, sendAssistantText } = setup(social)
    await pipelineDeps.dispatch.coordinator.dispatch(msg('派 3f9a2b'))
    expect(resolveRef).toHaveBeenCalledWith('3f9a2b', ['draft'])
    expect(send).toHaveBeenCalledWith('3f9a2bcccc')
    expect(coordinatorDispatch).not.toHaveBeenCalled()
    expect(sendAssistantText).toHaveBeenCalledTimes(1)
    const [chatId, text] = sendAssistantText.mock.calls[0]!
    expect(chatId).toBe('op_chat')
    expect(text).toContain('已派给 2 个朋友')
  })

  it('取消 <ref> → wish.resolveRef among draft+open then wish.cancel(fullId)', async () => {
    const { social, resolveRef, cancel } = socialWithWish()
    const { pipelineDeps, coordinatorDispatch, sendAssistantText } = setup(social)
    await pipelineDeps.dispatch.coordinator.dispatch(msg('取消 3f9a2bcccc'))
    expect(resolveRef).toHaveBeenCalledWith('3f9a2bcccc', ['draft', 'open'])
    expect(cancel).toHaveBeenCalledWith('3f9a2bcccc')
    expect(coordinatorDispatch).not.toHaveBeenCalled()
    expect(String(sendAssistantText.mock.calls[0]![1])).toContain('已作废')
  })

  it('派 <unknown> → no send, reply 这条心愿不存在或已处理', async () => {
    const { social, send } = socialWithWish()
    const { pipelineDeps, coordinatorDispatch, sendAssistantText } = setup(social)
    await pipelineDeps.dispatch.coordinator.dispatch(msg('派 deadbeef'))
    expect(send).not.toHaveBeenCalled()
    expect(coordinatorDispatch).not.toHaveBeenCalled()
    expect(String(sendAssistantText.mock.calls[0]![1])).toContain('这条心愿不存在或已处理')
  })

  it('non-admin 派 … falls through to boot.coordinator.dispatch (no wish action)', async () => {
    const { social, send } = socialWithWish()
    const { pipelineDeps, coordinatorDispatch } = setup(social)
    await pipelineDeps.dispatch.coordinator.dispatch(msg('派 3f9a2b', 'someone_else'))
    expect(send).not.toHaveBeenCalled()
    expect(coordinatorDispatch).toHaveBeenCalledTimes(1)
  })

  it('no boot.social → always a normal turn, even for a well-formed 派', async () => {
    const { pipelineDeps, coordinatorDispatch } = setup(undefined)
    await pipelineDeps.dispatch.coordinator.dispatch(msg('派 3f9a2b'))
    expect(coordinatorDispatch).toHaveBeenCalledTimes(1)
  })

  // Mandatory regression (I2 delegate-collision guard) — an admin delegate
  // command ("派 <hand> 跑 <task>") must NOT hit the wish. The id-charset
  // parser returns null on the non-id token, so this falls through the seam
  // toward normal dispatch (which real wiring precedes with makeMwAdmin's
  // DELEGATE_RE — this test drives the seam directly, so it asserts the belt,
  // not the suspenders).
  it('delegate coexistence: admin 派 家里 跑 拉日志 does NOT hit the wish; falls through to dispatch', async () => {
    const { social, resolveRef, send, cancel } = socialWithWish()
    const { pipelineDeps, coordinatorDispatch } = setup(social)
    await pipelineDeps.dispatch.coordinator.dispatch(msg('派 家里 跑 拉日志'))
    expect(resolveRef).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
    expect(coordinatorDispatch).toHaveBeenCalledTimes(1)
  })

  // 串门 rides the same `social` wire — proves pipeline-deps packs BOTH
  // members of `{ wish, penpal }`, not just the one 派 exercises.
  it('串门 reaches social.penpal.startVisit through the same wire', async () => {
    const { social, startVisit } = socialWithWish()
    const { pipelineDeps, coordinatorDispatch } = setup(social)
    await pipelineDeps.dispatch.coordinator.dispatch(msg('串门'))
    expect(startVisit).toHaveBeenCalled()
    expect(coordinatorDispatch).not.toHaveBeenCalled()
  })
})
