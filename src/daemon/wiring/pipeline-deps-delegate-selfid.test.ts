import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// T2/T6 identity-split review finding: pipeline-deps' `delegateToHand`
// closure used to independently resolve `process.env.WECHAT_A2A_SELF_ID ||
// 'wechat-cc'` for the exec/hands delegate path, while wireSocial /
// wirePairing self-reported `boot.selfId` (the real resolveSelfAgentId
// result). A slug-minting daemon would then broadcast TWO different
// identities to its peers. The fix threads `boot.selfId` — resolved once at
// bootstrap — into this closure too (src/daemon/wiring/pipeline-deps.ts).
// This test drives the real "让 <hand> 执行 <task>" admin-command path and
// asserts the outbound /a2a/exec call carries `boot.selfId`, not a
// WECHAT_A2A_SELF_ID env fallback.
//
// Same STATE_DIR-mocking recipe as pipeline-deps-social-dispatch.test.ts:
// isAdmin/loadAccess read from the module-level STATE_DIR (src/lib/config.ts),
// which isn't one of buildPipelineDeps's injectable opts, so it's redirected
// via vi.mock BEFORE anything imports config.ts, and pipeline-deps is loaded
// dynamically afterward so it (transitively) picks up the mock.
const ACCESS_STATE_DIR = mkdtempSync(join(tmpdir(), 'pipeline-deps-delegate-selfid-access-'))
vi.mock('../../lib/config.ts', () => ({
  STATE_DIR: ACCESS_STATE_DIR,
  ILINK_BASE_URL: 'https://ilinkai.weixin.qq.com',
  ILINK_APP_ID: 'bot',
  ILINK_BOT_TYPE: '3',
  LONG_POLL_TIMEOUT_MS: 35_000,
}))

// The dynamic imports inside delegateToHand (`../../core/a2a-delegate` for
// the actual HTTP POST, `../../core/a2a-client` for the client factory) are
// mocked so the test never touches the network — and so the mocked
// `delegateToHand` can capture exactly what `selfId` it was called with.
const doDelegateSpy = vi.fn(async () => ({ ok: true as const, response: 'done' }))
vi.mock('../../core/a2a-delegate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/a2a-delegate')>()
  return { ...actual, delegateToHand: doDelegateSpy }
})
vi.mock('../../core/a2a-client', () => ({
  createA2AClient: () => ({ send: vi.fn() }),
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
import type { A2AAgentRecord } from '../../lib/agent-config'

const ACCESS_FILE = join(ACCESS_STATE_DIR, 'access.json')
function writeAccess(admins: string[]): void {
  writeFileSync(ACCESS_FILE, JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [], admins }, null, 2))
}

afterAll(() => { rmSync(ACCESS_STATE_DIR, { recursive: true, force: true }) })

async function pollFor<T>(fn: () => T | null, tries = 50, gapMs = 10): Promise<T | null> {
  for (let i = 0; i < tries; i++) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, gapMs)) }
  return fn()
}

describe('pipeline-deps delegateToHand selfId (T2/T6 identity-split fix)', () => {
  let stateDir: string
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'pipeline-deps-delegate-selfid-'))
    writeAccess(['op_chat'])
    doDelegateSpy.mockClear()
  })

  const pushHand: A2AAgentRecord = {
    id: 'home', name: '家里', url: 'http://127.0.0.1:1/a2a',
    inbound_api_key: 'k'.repeat(16), outbound_api_key: 'o'.repeat(16),
    capabilities: ['exec'], paused: false, transport: 'push',
  }

  function setup(selfId: string) {
    const db = openTestDb()
    const sendMessage = vi.fn(async (_chatId: string, _text: string) => ({ msgId: 'm1' }))
    const boot = {
      sessionManager: { isInFlight: vi.fn(() => false) } as unknown as Bootstrap['sessionManager'],
      sessionStore: { get: vi.fn(), delete: vi.fn() } as unknown as Bootstrap['sessionStore'],
      conversationStore: { upsertIdentity: vi.fn() } as unknown as Bootstrap['conversationStore'],
      registry: { get: vi.fn(), list: vi.fn(() => []), getCheapEval: vi.fn(() => null), has: vi.fn(() => false) } as unknown as Bootstrap['registry'],
      coordinator: { dispatch: vi.fn(), getMode: vi.fn(), cancel: vi.fn(() => false) } as unknown as Bootstrap['coordinator'],
      resolve: vi.fn(() => null),
      formatInbound: vi.fn() as unknown as Bootstrap['formatInbound'],
      sdkOptionsForProject: vi.fn() as unknown as Bootstrap['sdkOptionsForProject'],
      buildInstructions: vi.fn(() => ''),
      defaultProviderId: 'claude',
      agentProviderKind: 'claude',
      dispatchDelegate: vi.fn() as unknown as Bootstrap['dispatchDelegate'],
      // Present (unlike the social-dispatch fixtures) so the `!a2a` early
      // return in delegateToHand is NOT taken — the closure under test runs.
      a2aDeps: {
        registry: { list: () => [pushHand] },
        client: {},
        eventsStore: {},
        recordEvent: vi.fn(),
        serverEnabled: true,
        baseUrl: null,
      } as unknown as Bootstrap['a2aDeps'],
      a2aServer: null,
      agentConfig: { bot_name: null } as unknown as Bootstrap['agentConfig'],
      sendAssistantText: vi.fn(),
      social: undefined,
      penpal: undefined,
      // The field under test: bootstrap/index.ts resolves this ONCE
      // (resolveSelfAgentId) and it's what delegateToHand must now read,
      // instead of process.env.WECHAT_A2A_SELF_ID.
      selfId,
    } as unknown as Bootstrap

    const ilink = { sendMessage } as unknown as IlinkAdapter
    const chatPrefs: ChatPrefsStore = { get: () => ({}), set: () => ({}), list: () => [] }
    const careLedger: CareLedger = { get: () => ({ noReplyCount: 0 }), claim: vi.fn(), claimHunt: vi.fn(), resetNoReply: vi.fn() }
    const replySinks = makeReplySinks()
    const { pipelineDeps } = buildPipelineDeps(
      { stateDir, db, ilink, boot, log: () => {}, chatPrefs, careLedger, replySinks },
      { polling: new Ref('polling'), guard: new Ref('guard'), pipeline: new Ref('pipeline'), ingestNudge: new Ref('ingestNudge') },
    )
    return { pipelineDeps }
  }

  const delegateMsg: InboundMsg = { chatId: 'op_chat', userId: 'op_chat', text: '让 家里 执行 打扫一下', msgType: 'text', createTimeMs: Date.now(), accountId: 'acct1' }

  it('delegateToHand calls a2a-delegate with boot.selfId, not an env fallback', async () => {
    const prevEnv = process.env.WECHAT_A2A_SELF_ID
    // Deliberately UNSET / different from boot.selfId — proves the closure
    // is no longer reading this env var for its own resolution (the daemon
    // may still respect it upstream inside resolveSelfAgentId itself, but
    // delegateToHand must not re-derive it independently).
    delete process.env.WECHAT_A2A_SELF_ID
    try {
      const { pipelineDeps } = setup('cc-boot-resolved-1234')
      const handled = await pipelineDeps.admin.adminHandler.handle(delegateMsg)
      expect(handled).toBe(true) // fire-and-forget ack — runDelegate continues in the background

      const call = await pollFor(() => doDelegateSpy.mock.calls[0] ?? null)
      expect(call).not.toBeNull()
      const [, req] = call as unknown as [unknown, { selfId: string; hand: A2AAgentRecord; prompt: string }]
      expect(req.selfId).toBe('cc-boot-resolved-1234')
      expect(req.hand.id).toBe('home')
    } finally {
      if (prevEnv === undefined) delete process.env.WECHAT_A2A_SELF_ID
      else process.env.WECHAT_A2A_SELF_ID = prevEnv
    }
  })

  it('still uses boot.selfId even when WECHAT_A2A_SELF_ID is set to something else', async () => {
    const prevEnv = process.env.WECHAT_A2A_SELF_ID
    process.env.WECHAT_A2A_SELF_ID = 'env-var-stale-identity'
    try {
      const { pipelineDeps } = setup('cc-boot-resolved-5678')
      await pipelineDeps.admin.adminHandler.handle(delegateMsg)
      const call = await pollFor(() => doDelegateSpy.mock.calls[0] ?? null)
      expect(call).not.toBeNull()
      const [, req] = call as unknown as [unknown, { selfId: string }]
      // The env var must NOT leak into this call — boot.selfId wins.
      expect(req.selfId).toBe('cc-boot-resolved-5678')
      expect(req.selfId).not.toBe('env-var-stale-identity')
    } finally {
      if (prevEnv === undefined) delete process.env.WECHAT_A2A_SELF_ID
      else process.env.WECHAT_A2A_SELF_ID = prevEnv
    }
  })
})
