/**
 * Regression test for fix round 1's CRITICAL finding: appendAllowFrom
 * (src/lib/access.ts) writes allowFrom straight to disk, but loadAccess()
 * has its own 5s in-process TTL cache that was NOT invalidated by that
 * write. The guest-path 允许 command flow calls appendAllowFrom() and then
 * IMMEDIATELY redispatches the guest's original message back through the
 * full inbound pipeline in the same tick — so mw-access's own loadAccess()
 * call for that redispatch could still see a cache populated (by any
 * recent, unrelated inbound) from BEFORE the write, read the guest chat as
 * still not-allowlisted, fall into the guest branch again, and be silently
 * swallowed by its own seenMessage dedup (the id was already recorded seen
 * the first time this exact message went through).
 *
 * This exercises the REAL loadAccess/appendAllowFrom from src/lib/access.ts
 * together with the REAL makeMwAccess — deliberately warming the cache
 * BEFORE calling appendAllowFrom, so the fix (nulling the cache inside
 * appendAllowFrom) is what has to save the day, not test setup avoiding
 * the stale-cache window via _clearCache().
 */
import { describe, it, expect, vi, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ACCESS_STATE_DIR = mkdtempSync(join(tmpdir(), 'mw-access-cache-test-'))
vi.mock('../../lib/config.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/config')>()
  return { ...actual, STATE_DIR: ACCESS_STATE_DIR }
})

const { loadAccess, appendAllowFrom } = await import('../../lib/access')
const { makeMwAccess } = await import('./mw-access')

import type { InboundCtx } from './types'
import type { InboundMsg } from '../../core/prompt-format'

const ACCESS_FILE = join(ACCESS_STATE_DIR, 'access.json')

afterAll(() => { rmSync(ACCESS_STATE_DIR, { recursive: true, force: true }) })

// access.ts's loadAccess() cache is MODULE-scoped, so test order within
// this file matters: the sanity check runs FIRST (on its own clean cache
// state, proving the TTL really does serve stale data when nothing busts
// it), and the actual regression runs SECOND, deliberately relying on the
// cache the sanity check leaves warm — exactly the "some recent unrelated
// inbound already called loadAccess()" precondition the CRITICAL finding
// describes.
describe('mw-access + access.ts cache-bust regression (CRITICAL finding, fix round 1)', () => {
  it('sanity check: loadAccess() really does serve a stale snapshot within the 5s TTL when nothing busts the cache', () => {
    writeFileSync(ACCESS_FILE, JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['admin_chat'], admins: ['admin_chat'] }, null, 2))
    const snap1 = loadAccess()
    expect(snap1.allowFrom).not.toContain('someone_new')
    // Out-of-band disk edit that bypasses appendAllowFrom entirely.
    writeFileSync(ACCESS_FILE, JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['admin_chat', 'someone_new'], admins: ['admin_chat'] }, null, 2))
    const snap2 = loadAccess()
    expect(snap2.allowFrom).not.toContain('someone_new')   // still stale — proves the TTL cache is real
  })

  it('allow -> immediate redispatch through the REAL mw-access, with the cache left WARM by the previous read, still reaches next()', async () => {
    // Re-establish a known disk state, but DELIBERATELY do NOT clear the
    // cache first — the sanity check above just proved loadAccess() is
    // still serving its stale in-memory snapshot from moments ago.
    writeFileSync(ACCESS_FILE, JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['admin_chat'], admins: ['admin_chat'] }, null, 2))
    const before = loadAccess()   // cache HIT (warm) — reads the stale in-memory snapshot, not this fresh write
    expect(before.allowFrom).not.toContain('guest_chat')

    // Simulate the 允许 command's appendAllowFrom call — this is the ONLY
    // thing standing between the warm cache above and the redispatch below.
    appendAllowFrom('guest_chat')

    // makeMwAccess with ONLY the base deps (guest deps intentionally
    // absent) — if the fix works, `allowed` becomes true immediately and
    // the guest branch is never even entered, so absent guest deps don't
    // matter for this assertion.
    const mw = makeMwAccess({ loadAccess, log: () => {} })
    const msg: InboundMsg = {
      chatId: 'guest_chat', userId: 'guest_chat', text: '你好', msgType: 'text',
      createTimeMs: 1, accountId: 'acct1',
    }
    const ctx: InboundCtx = { msg, receivedAtMs: 0, requestId: 'r', redispatch: true }
    const next = vi.fn(async () => {})

    await mw(ctx, next)

    expect(next).toHaveBeenCalledOnce()
    expect(ctx.consumedBy).toBeUndefined()
  })
})
