import { describe, it, expect, vi, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Guest path (spec docs/superpowers/specs/2026-08-18-guest-path-design.md
// §2) — buildPipelineDeps wires `pipelineDeps.access`'s five guest fields
// (guestRequests, hydrateChatRoute, sendMessage, notifyOwner, budget). This
// file exercises the REAL closures it returns, not a reimplementation.
//
// isAdmin/loadAccess (via notifyOwnerOfGuest → resolveAdminChatId) read
// access.json off the module-level STATE_DIR (src/lib/config.ts), which is
// NOT one of buildPipelineDeps's injectable opts — so STATE_DIR is
// redirected to a temp dir via vi.mock BEFORE anything imports
// access.ts/config.ts, mirroring pipeline-deps-pairing-dispatch.test.ts.
const ACCESS_STATE_DIR = mkdtempSync(join(tmpdir(), 'pipeline-deps-guest-access-test-'))
vi.mock('../../lib/config.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/config')>()
  return { ...actual, STATE_DIR: ACCESS_STATE_DIR }
})

const { buildPipelineDeps } = await import('./pipeline-deps')
const { Ref } = await import('../../lib/lifecycle')
const { openTestDb } = await import('../../lib/db')
const { makeReplySinks } = await import('../reply-sinks')
// loadAccess() has a 5s in-process TTL cache (src/lib/access.ts) — this
// file's tests write DIFFERENT admins lists to the SAME access.json within
// milliseconds of each other, so the cache must be reset per-setup or a
// later test would silently read an earlier test's stale admins snapshot.
const { _clearCache, _resetSnapshotForTest } = await import('../../lib/access')

import type { Bootstrap } from '../bootstrap/index'
import type { IlinkAdapter } from '../ilink-glue'
import type { ChatPrefsStore } from '../chat-prefs'
import type { CareLedger } from '../companion/care-ledger'
import type { InboundMsg } from '../../core/prompt-format'

const fakeHealth = {
  health: { shouldSuspend: () => false, get: () => ({ consecutiveFailures: 0 }) },
} as unknown as Bootstrap['health']

const ACCESS_FILE = join(ACCESS_STATE_DIR, 'access.json')
function writeAccess(admins: string[]): void {
  writeFileSync(ACCESS_FILE, JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [], admins }, null, 2))
}

afterAll(() => { rmSync(ACCESS_STATE_DIR, { recursive: true, force: true }) })

function setup(admins: string[] = ['admin_chat']) {
  writeAccess(admins)
  _clearCache()
  _resetSnapshotForTest()
  const stateDir = mkdtempSync(join(tmpdir(), 'pipeline-deps-guest-access-real-'))
  const db = openTestDb()
  const boot = {
    sessionManager: { isInFlight: () => false } as unknown as Bootstrap['sessionManager'],
    sessionStore: {} as Bootstrap['sessionStore'],
    conversationStore: { upsertIdentity: () => {} } as unknown as Bootstrap['conversationStore'],
    registry: { get: () => undefined, list: () => [], getCheapEval: () => null, has: () => false } as unknown as Bootstrap['registry'],
    coordinator: { dispatch: async () => {}, getMode: () => ({ kind: 'solo', provider: 'claude' }), cancel: () => false } as unknown as Bootstrap['coordinator'],
    resolve: () => null,
    formatInbound: (() => {}) as unknown as Bootstrap['formatInbound'],
    sdkOptionsForProject: (() => {}) as unknown as Bootstrap['sdkOptionsForProject'],
    buildInstructions: () => '',
    defaultProviderId: 'claude',
    agentProviderKind: 'claude',
    dispatchDelegate: (() => {}) as unknown as Bootstrap['dispatchDelegate'],
    a2aDeps: undefined,
    a2aServer: null,
    agentConfig: { bot_name: null } as unknown as Bootstrap['agentConfig'],
    sendAssistantText: async () => {},
    social: undefined,
    penpal: undefined,
    pairing: undefined,
    health: fakeHealth,
  } as unknown as Bootstrap

  const routeChatToAccount = vi.fn()
  const captureContextToken = vi.fn()
  const markChatActive = vi.fn()
  const sendMessage = vi.fn(async (_c: string, _t: string) => ({ msgId: 'sent:1' }))
  const ilink = {
    routeChatToAccount,
    captureContextToken,
    markChatActive,
    sendMessage,
  } as unknown as IlinkAdapter

  const chatPrefs: ChatPrefsStore = { get: () => ({}), set: () => ({}), list: () => [] }
  const careLedger: CareLedger = { get: () => ({ noReplyCount: 0 }), claim: () => {}, claimHunt: () => {}, resetNoReply: () => {} } as unknown as CareLedger
  const replySinks = makeReplySinks()

  const { pipelineDeps } = buildPipelineDeps(
    { stateDir, db, ilink, boot, log: () => {}, chatPrefs, careLedger, replySinks },
    { polling: new Ref('polling'), guard: new Ref('guard'), pipeline: new Ref('pipeline'), ingestNudge: new Ref('ingestNudge') },
  )
  return { pipelineDeps, stateDir, routeChatToAccount, captureContextToken, markChatActive, sendMessage }
}

const guestMsg: InboundMsg = {
  chatId: 'guest_chat',
  userId: 'guest_chat',
  text: 'hi',
  msgType: 'text',
  createTimeMs: 1,
  accountId: 'acct1',
  contextToken: 'ctx-tok',
}

describe('pipeline-deps guest-access wiring (spec §2)', () => {
  it('all five guest fields are present on pipelineDeps.access', () => {
    const { pipelineDeps, stateDir } = setup()
    try {
      expect(pipelineDeps.access.guestRequests).toBeDefined()
      expect(pipelineDeps.access.hydrateChatRoute).toBeDefined()
      expect(pipelineDeps.access.sendMessage).toBeDefined()
      expect(pipelineDeps.access.notifyOwner).toBeDefined()
      expect(pipelineDeps.access.budget).toBeDefined()
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('hydrateChatRoute routes the account + captures the context token WITHOUT ever calling markChatActive (lastActiveRef stays untouched)', () => {
    const { pipelineDeps, stateDir, routeChatToAccount, captureContextToken, markChatActive } = setup()
    try {
      pipelineDeps.access.hydrateChatRoute!(guestMsg)
      expect(routeChatToAccount).toHaveBeenCalledWith('guest_chat', 'acct1')
      expect(captureContextToken).toHaveBeenCalledWith('guest_chat', 'ctx-tok')
      expect(markChatActive).not.toHaveBeenCalled()
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('hydrateChatRoute skips captureContextToken when the inbound carries no context token', () => {
    const { pipelineDeps, stateDir, routeChatToAccount, captureContextToken } = setup()
    try {
      pipelineDeps.access.hydrateChatRoute!({ ...guestMsg, contextToken: undefined })
      expect(routeChatToAccount).toHaveBeenCalledWith('guest_chat', 'acct1')
      expect(captureContextToken).not.toHaveBeenCalled()
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('sendMessage delegates straight to ilink.sendMessage', async () => {
    const { pipelineDeps, stateDir, sendMessage } = setup()
    try {
      const r = await pipelineDeps.access.sendMessage!('guest_chat', 'hello')
      expect(sendMessage).toHaveBeenCalledWith('guest_chat', 'hello')
      expect(r).toEqual({ msgId: 'sent:1' })
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('notifyOwner resolves the admin chat via resolveAdminChatId and sends directly (never through a prompt)', async () => {
    const { pipelineDeps, stateDir, sendMessage } = setup(['admin_chat'])
    try {
      const r = await pipelineDeps.access.notifyOwner!('👋 someone wants to chat')
      expect(sendMessage).toHaveBeenCalledWith('admin_chat', '👋 someone wants to chat')
      expect(r).toEqual({ msgId: 'sent:1' })
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('notifyOwner errors cleanly (no send) when there is no resolvable admin chat', async () => {
    const { pipelineDeps, stateDir, sendMessage } = setup([])
    try {
      const r = await pipelineDeps.access.notifyOwner!('👋 someone wants to chat')
      expect(sendMessage).not.toHaveBeenCalled()
      expect(r.error).toBeTruthy()
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('budget is a real per-sender token bucket — perSender:3 within the hour, 4th call in the window is refused', () => {
    const { pipelineDeps, stateDir } = setup()
    try {
      const budget = pipelineDeps.access.budget!
      expect(budget.withinBudget('guest_chat')).toBe(true)
      expect(budget.withinBudget('guest_chat')).toBe(true)
      expect(budget.withinBudget('guest_chat')).toBe(true)
      expect(budget.withinBudget('guest_chat')).toBe(false)
      // A different sender has its own independent bucket.
      expect(budget.withinBudget('other_chat')).toBe(true)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('guestRequests is a real durable store — upsertRequest is idempotent for the same chatId and persists to guest-requests.json under stateDir', () => {
    const { pipelineDeps, stateDir } = setup()
    try {
      const store = pipelineDeps.access.guestRequests!
      const first = store.upsertRequest({ chatId: 'guest_chat', firstMsg: guestMsg, contextToken: 'ctx-tok', accountId: 'acct1' })
      expect(first.fresh).toBe(true)
      const second = store.upsertRequest({ chatId: 'guest_chat', firstMsg: guestMsg, contextToken: 'ctx-tok', accountId: 'acct1' })
      expect(second.fresh).toBe(false)
      expect(second.request.code).toBe(first.request.code)
      expect(existsSync(join(stateDir, 'guest-requests.json'))).toBe(true)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})
