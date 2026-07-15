import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Agent-social M1 (T7b-2) — the `dispatch.coordinator.dispatch` seam in
// pipeline-deps.ts intercepts the operator's WeChat "是/否" reply before it
// reaches a normal agent turn. `isAdmin` (src/lib/access.ts) reads
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

// P2 added seekStore/echoStore to boot.social's type; these dispatch tests
// don't exercise the stores, so a minimal no-op stub keeps setup() type-clean.
const socialStoreStubs = {
  seekStore: { create() {}, update() {}, list: () => [], get: () => null },
  echoStore: { create() {}, setStatus() {}, listForSeek: () => [], listAll: () => [], get: () => null },
} satisfies {
  seekStore: import('../../core/social-seek-store').SeekStore
  echoStore: import('../../core/social-echo-store').EchoStore
}

const { buildPipelineDeps } = await import('./pipeline-deps')
const { createPendingConfirms } = await import('../../core/pending-confirm')
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

describe('pipeline-deps social dispatch seam (T7b-2)', () => {
  let stateDir: string

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'pipeline-deps-social-test-'))
    writeAccess(['op_chat'])
  })

  afterAll(() => {
    rmSync(ACCESS_STATE_DIR, { recursive: true, force: true })
  })

  function setup(social: Bootstrap['social']) {
    const db = openTestDb()
    const coordinatorDispatch = vi.fn(async (_msg: InboundMsg) => {})
    const boot = {
      sessionManager: { isInFlight: vi.fn(() => false) } as unknown as Bootstrap['sessionManager'],
      sessionStore: {} as Bootstrap['sessionStore'],
      conversationStore: { upsertIdentity: vi.fn() } as unknown as Bootstrap['conversationStore'],
      registry: { get: vi.fn(), list: vi.fn(() => []), getCheapEval: vi.fn(() => null), has: vi.fn(() => false) } as unknown as Bootstrap['registry'],
      coordinator: {
        dispatch: coordinatorDispatch,
        getMode: vi.fn((): Mode => ({ kind: 'solo', provider: 'claude' })),
        cancel: vi.fn(() => false),
      } as unknown as Bootstrap['coordinator'],
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
      social,
    } as unknown as Bootstrap

    const ilink = {} as unknown as IlinkAdapter
    const chatPrefs: ChatPrefsStore = { get: () => ({}), set: () => ({}), list: () => [] }
    const careLedger: CareLedger = { get: () => ({ noReplyCount: 0 }), claim: vi.fn(), claimHunt: vi.fn(), resetNoReply: vi.fn() }
    const replySinks = makeReplySinks()

    const { pipelineDeps } = buildPipelineDeps(
      { stateDir, db, ilink, boot, log: () => {}, chatPrefs, careLedger, replySinks },
      { polling: new Ref('polling'), guard: new Ref('guard'), pipeline: new Ref('pipeline'), ingestNudge: new Ref('ingestNudge') },
    )

    return { pipelineDeps, coordinatorDispatch }
  }

  const baseMsg: InboundMsg = {
    chatId: 'op_chat',
    userId: 'op_chat',
    text: '是',
    msgType: 'text',
    createTimeMs: Date.now(),
    accountId: 'acct1',
  }

  it('a clear "是" from the admin chat with a pending confirm is consumed — NOT dispatched as a normal turn', async () => {
    const pendingConfirms = createPendingConfirms()
    const answer = pendingConfirms.ask('op_chat:intent-1', 5 * 60_000)
    const { pipelineDeps, coordinatorDispatch } = setup({ broker: { seek: vi.fn() }, pendingConfirms, ...socialStoreStubs })

    await pipelineDeps.dispatch.coordinator.dispatch(baseMsg)

    expect(await answer).toBe(true)
    expect(coordinatorDispatch).not.toHaveBeenCalled()
  })

  it('a clear "否" resolves the pending confirm to false and is not dispatched', async () => {
    const pendingConfirms = createPendingConfirms()
    const answer = pendingConfirms.ask('op_chat:intent-1', 5 * 60_000)
    const { pipelineDeps, coordinatorDispatch } = setup({ broker: { seek: vi.fn() }, pendingConfirms, ...socialStoreStubs })

    await pipelineDeps.dispatch.coordinator.dispatch({ ...baseMsg, text: '否' })

    expect(await answer).toBe(false)
    expect(coordinatorDispatch).not.toHaveBeenCalled()
  })

  it('an unclear reply falls through to a normal turn and leaves the pending confirm untouched', async () => {
    const pendingConfirms = createPendingConfirms()
    const answer = pendingConfirms.ask('op_chat:intent-1', 50)
    const { pipelineDeps, coordinatorDispatch } = setup({ broker: { seek: vi.fn() }, pendingConfirms, ...socialStoreStubs })

    await pipelineDeps.dispatch.coordinator.dispatch({ ...baseMsg, text: 'what time works for you?' })

    expect(coordinatorDispatch).toHaveBeenCalledTimes(1)
    expect(pendingConfirms.hasPending('op_chat')).toBe(true)
    // let the short timeout fire so it doesn't leak past the test
    expect(await answer).toBe(false)
  })

  it('no boot.social at all → always falls through to a normal turn', async () => {
    const { pipelineDeps, coordinatorDispatch } = setup(undefined)

    await pipelineDeps.dispatch.coordinator.dispatch(baseMsg)

    expect(coordinatorDispatch).toHaveBeenCalledTimes(1)
  })

  it('a non-admin chat with a pending confirm under a DIFFERENT key is never consumed, even on "是"', async () => {
    const pendingConfirms = createPendingConfirms()
    const answer = pendingConfirms.ask('op_chat:intent-1', 50)
    const { pipelineDeps, coordinatorDispatch } = setup({ broker: { seek: vi.fn() }, pendingConfirms, ...socialStoreStubs })

    await pipelineDeps.dispatch.coordinator.dispatch({ ...baseMsg, chatId: 'someone_else', userId: 'someone_else', text: '是' })

    expect(coordinatorDispatch).toHaveBeenCalledTimes(1)
    expect(pendingConfirms.hasPending('op_chat')).toBe(true)
    expect(await answer).toBe(false)
  })
})
