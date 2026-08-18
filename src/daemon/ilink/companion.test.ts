/**
 * makeCompanion's enable() default_chat_id fallback (fix round 1,
 * Important #2 — CONTROLLER RULING): guest-path hydration
 * (mw-access → routeChatToAccount) can now put a NOT-allowlisted
 * stranger's chatId into acctStore, so the raw "most recently set key"
 * fallback used to be able to pick a stranger as the proactive-care
 * destination. It must now be filtered to loadAccess().allowFrom.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ACCESS_STATE_DIR = mkdtempSync(join(tmpdir(), 'ilink-companion-access-test-'))
vi.mock('../../lib/config.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/config')>()
  return { ...actual, STATE_DIR: ACCESS_STATE_DIR }
})

const { makeCompanion } = await import('./companion')
const { _clearCache, _resetSnapshotForTest } = await import('../../lib/access')

import type { IlinkContext } from './context'

const ACCESS_FILE = join(ACCESS_STATE_DIR, 'access.json')
function writeAccess(allowFrom: string[]): void {
  writeFileSync(ACCESS_FILE, JSON.stringify({ dmPolicy: 'allowlist', allowFrom, admins: allowFrom }, null, 2))
  _clearCache()
  _resetSnapshotForTest()
}

function makeStubCtx(stateDir: string, acctKeys: string[]): IlinkContext {
  const data: Record<string, string> = {}
  for (const k of acctKeys) data[k] = 'acct1'
  return {
    stateDir,
    accounts: [],
    projectsFile: join(stateDir, 'projects.json'),
    ctxStore: { get: () => undefined, set: () => {}, all: () => ({}), flush: async () => {} } as never,
    acctStore: { get: (k: string) => data[k], set: (k: string, v: string) => { data[k] = v }, all: () => ({ ...data }), flush: async () => {} } as never,
    conversationStore: {} as never,
    sessionState: {} as never,
    pending: {} as never,
    sweepTimer: setInterval(() => {}, 1_000_000) as never,
    typingTickets: new Map(),
    typingTTLMs: 60_000,
    lastActiveRef: { current: null },
    resolveAccount: () => { throw new Error('stub') },
    assertChatRoutable: () => {},
  }
}

afterEach(() => { _clearCache(); _resetSnapshotForTest() })

describe('makeCompanion().enable() — default_chat_id acctStore fallback is allowFrom-filtered', () => {
  it('picks the allowlisted chat, skipping a hydrated stranger even though it is the most-recently-set acctStore key', async () => {
    writeAccess(['owner_chat'])
    const stateDir = mkdtempSync(join(tmpdir(), 'ilink-companion-test-'))
    try {
      // 'stranger_chat' was set AFTER 'owner_chat' (guest hydrate happened
      // later) — the raw "last key" fallback would have picked it.
      const ctx = makeStubCtx(stateDir, ['owner_chat', 'stranger_chat'])
      const companion = makeCompanion(ctx)
      const r = await companion.enable()
      expect(r.ok).toBe(true)
      const status = companion.status()
      expect(status.default_chat_id).toBe('owner_chat')
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('falls back to null (not a stranger) when NO acctStore key is allowlisted', async () => {
    writeAccess(['owner_chat'])   // owner_chat never actually messaged (not in acctStore)
    const stateDir = mkdtempSync(join(tmpdir(), 'ilink-companion-test-'))
    try {
      const ctx = makeStubCtx(stateDir, ['stranger_chat'])
      const companion = makeCompanion(ctx)
      await companion.enable()
      expect(companion.status().default_chat_id).toBeNull()
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('lastActiveRef.current still wins over the acctStore fallback when set (unchanged precedence)', async () => {
    writeAccess(['owner_chat'])
    const stateDir = mkdtempSync(join(tmpdir(), 'ilink-companion-test-'))
    try {
      const ctx = makeStubCtx(stateDir, ['owner_chat'])
      ctx.lastActiveRef.current = 'owner_chat'
      const companion = makeCompanion(ctx)
      await companion.enable()
      expect(companion.status().default_chat_id).toBe('owner_chat')
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})
