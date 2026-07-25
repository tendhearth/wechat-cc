import { describe, it, expect, vi, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Pairing-code (spec §7) — the `dispatch.coordinator.dispatch` seam in
// pipeline-deps.ts intercepts the owner's WeChat "配对" / "配对 <code>" reply
// before it reaches a normal agent turn. Mirrors
// pipeline-deps-social-dispatch.test.ts's harness (揭晓/回信): `isAdmin`
// reads access.json from the module-level STATE_DIR (src/lib/config.ts),
// which is NOT one of buildPipelineDeps's injectable opts — so STATE_DIR is
// redirected to a temp dir via vi.mock BEFORE anything imports
// access.ts/config.ts, and pipeline-deps is loaded dynamically afterward so
// it (transitively) picks up the mock.
const ACCESS_STATE_DIR = mkdtempSync(join(tmpdir(), 'pipeline-deps-pairing-access-test-'))
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

afterAll(() => { rmSync(ACCESS_STATE_DIR, { recursive: true, force: true }) })

describe('pipeline-deps pairing dispatch seam (配对 pairing-code)', () => {
  function setup(pairing: Bootstrap['pairing'], admins: string[] = ['op_chat']) {
    writeAccess(admins)
    const stateDir = mkdtempSync(join(tmpdir(), 'pipeline-deps-pairing-test-'))
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
      penpal: undefined,
      pairing,
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

  function fakePairing(overrides: Partial<{ start: any; accept: any }> = {}): Bootstrap['pairing'] {
    return {
      start: vi.fn(async () => ({ ok: true, code: '483921', expiresAt: 0 })),
      accept: vi.fn(async () => ({ ok: true, peer: { self_id: 'cc-x', name: 'Bob' } })),
      stop: vi.fn(),
      ...overrides,
    } as unknown as Bootstrap['pairing']
  }

  const startMsg: InboundMsg = { chatId: 'op_chat', userId: 'op_chat', text: '配对', msgType: 'text', createTimeMs: Date.now(), accountId: 'acct1' }
  const acceptMsg: InboundMsg = { chatId: 'op_chat', userId: 'op_chat', text: '配对 483921', msgType: 'text', createTimeMs: Date.now(), accountId: 'acct1' }

  it('admin "配对" → start(), replies with the code, no normal turn', async () => {
    const pairing = fakePairing()
    const { pipelineDeps, coordinatorDispatch, sendAssistantText } = setup(pairing)
    await pipelineDeps.dispatch.coordinator.dispatch(startMsg)
    expect(pairing!.start).toHaveBeenCalled()
    expect(coordinatorDispatch).not.toHaveBeenCalled()
    expect(sendAssistantText).toHaveBeenCalledTimes(1)
    const [chatId, text] = sendAssistantText.mock.calls[0]!
    expect(chatId).toBe('op_chat')
    expect(text).toContain('483921')
  })

  it('admin "配对 <code>" → accept(code), success reply names the peer', async () => {
    const pairing = fakePairing()
    const { pipelineDeps, coordinatorDispatch, sendAssistantText } = setup(pairing)
    await pipelineDeps.dispatch.coordinator.dispatch(acceptMsg)
    expect(pairing!.accept).toHaveBeenCalledWith('483921')
    expect(coordinatorDispatch).not.toHaveBeenCalled()
    expect(sendAssistantText).toHaveBeenCalledTimes(1)
    const [chatId, text] = sendAssistantText.mock.calls[0]!
    expect(chatId).toBe('op_chat')
    expect(text).toContain('Bob')
  })

  it('accept() self_pair failure gets the "own code" reply', async () => {
    const pairing = fakePairing({ accept: vi.fn(async () => ({ ok: false, reason: 'self_pair' })) })
    const { pipelineDeps, sendAssistantText } = setup(pairing)
    await pipelineDeps.dispatch.coordinator.dispatch(acceptMsg)
    expect(sendAssistantText).toHaveBeenCalledTimes(1)
    const [, text] = sendAssistantText.mock.calls[0]!
    expect(text).toContain('自己的码')
  })

  it('accept() id_conflict failure gets the upgrade-identity reply (single message — engine no longer double-notifies)', async () => {
    const pairing = fakePairing({ accept: vi.fn(async () => ({ ok: false, reason: 'id_conflict' })) })
    const { pipelineDeps, sendAssistantText } = setup(pairing)
    await pipelineDeps.dispatch.coordinator.dispatch(acceptMsg)
    expect(sendAssistantText).toHaveBeenCalledTimes(1)
    const [, text] = sendAssistantText.mock.calls[0]!
    expect(text).toContain('撞名')
  })

  it('accept() expired_or_wrong failure gets the "wrong or expired" reply', async () => {
    const pairing = fakePairing({ accept: vi.fn(async () => ({ ok: false, reason: 'expired_or_wrong' })) })
    const { pipelineDeps, sendAssistantText } = setup(pairing)
    await pipelineDeps.dispatch.coordinator.dispatch(acceptMsg)
    expect(sendAssistantText).toHaveBeenCalledTimes(1)
    const [, text] = sendAssistantText.mock.calls[0]!
    expect(text).toContain('码不对或已过期')
  })

  // relay_drop_failed gets its OWN distinct copy — folding it into the
  // generic "码不对或已过期" would be honest-sounding but WRONG: the code
  // was fine, the card just never reached the relay. Distinct from
  // expired_or_wrong below (single call, single message — the engine no
  // longer notifies on this SYNC outcome, see pairing.ts's notify doc
  // comment).
  it('accept() relay_drop_failed failure gets its OWN distinct reply (not folded into "expired")', async () => {
    const pairing = fakePairing({ accept: vi.fn(async () => ({ ok: false, reason: 'relay_drop_failed' })) })
    const { pipelineDeps, sendAssistantText } = setup(pairing)
    await pipelineDeps.dispatch.coordinator.dispatch(acceptMsg)
    expect(sendAssistantText).toHaveBeenCalledTimes(1)
    const [, text] = sendAssistantText.mock.calls[0]!
    expect(text).toContain('没能投到中继')
    expect(text).not.toContain('码不对或已过期')
  })

  // start()'s relay_drop_failed is also a SYNC outcome now — the engine no
  // longer notifies internally (pairing.ts), so the dispatch seam must
  // render the honest failure reply itself instead of staying silent.
  it('start() relay_drop_failed renders its own honest failure reply (single message)', async () => {
    const pairing = fakePairing({ start: vi.fn(async () => ({ ok: false, reason: 'relay_drop_failed' })) })
    const { pipelineDeps, coordinatorDispatch, sendAssistantText } = setup(pairing)
    await pipelineDeps.dispatch.coordinator.dispatch(startMsg)
    expect(pairing!.start).toHaveBeenCalled()
    expect(coordinatorDispatch).not.toHaveBeenCalled()
    expect(sendAssistantText).toHaveBeenCalledTimes(1)
    const [chatId, text] = sendAssistantText.mock.calls[0]!
    expect(chatId).toBe('op_chat')
    expect(text).toContain('稍后再试')
  })

  it('a non-command message falls through to a normal turn', async () => {
    const pairing = fakePairing()
    const { pipelineDeps, coordinatorDispatch } = setup(pairing)
    await pipelineDeps.dispatch.coordinator.dispatch({ ...startMsg, text: '今天几点见面?' })
    expect(coordinatorDispatch).toHaveBeenCalledTimes(1)
    expect(pairing!.start).not.toHaveBeenCalled()
  })

  it('no boot.pairing → always a normal turn, even for a well-formed 配对', async () => {
    const { pipelineDeps, coordinatorDispatch } = setup(undefined)
    await pipelineDeps.dispatch.coordinator.dispatch(startMsg)
    expect(coordinatorDispatch).toHaveBeenCalledTimes(1)
  })

  it('a 配对 from a NON-admin chat is never consumed', async () => {
    const pairing = fakePairing()
    const { pipelineDeps, coordinatorDispatch } = setup(pairing)
    await pipelineDeps.dispatch.coordinator.dispatch({ ...startMsg, chatId: 'someone_else', userId: 'someone_else' })
    expect(coordinatorDispatch).toHaveBeenCalledTimes(1)
    expect(pairing!.start).not.toHaveBeenCalled()
  })
})
