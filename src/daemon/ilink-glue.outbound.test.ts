/**
 * sendMessage → outbound health hook (spec 2026-08-22-outbound-health Task 2).
 *
 * Constructs makeIlinkAdapter directly (same style as ilink-glue.test.ts)
 * pointed at a real startFakeIlink() HTTP server, so ilinkSendMessage makes
 * a real wire round-trip. This is lighter than booting the full daemon via
 * __e2e__/harness.ts: no accounts-on-disk, no SDK fakes, no poll loop — and
 * it runs under the default `bun --bun vitest run` config (harness-based
 * __e2e__ tests are excluded from that config and only run under
 * `test:e2e`). Reuses the fake-ilink-server import across the __e2e__
 * boundary, which is fine — it's just a module import, not the e2e-only
 * test *file* itself.
 *
 * The fake server's sendmessage failure toggle (failSendMessage /
 * succeedSendMessage) defaults to errcode -6 ("auth failed"), a
 * non-retryable code per isRetryableSendError — this keeps the test fast
 * by skipping ilinkSendMessage's 1s retry backoff.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeIlinkAdapter, type Account } from './ilink-glue'
import { openTestDb, type Db } from '../lib/db'
import { makeConversationStore, type ConversationStore } from '../core/conversation-store'
import { startFakeIlink, type FakeIlinkHandle } from './__e2e__/fake-ilink-server'

function newAdapterDeps(): { db: Db; conversationStore: ConversationStore } {
  const db = openTestDb()
  const conversationStore = makeConversationStore(db)
  return { db, conversationStore }
}

describe('ilink-glue sendMessage → outboundHealth', () => {
  let fake: FakeIlinkHandle

  beforeEach(async () => {
    fake = await startFakeIlink()
  })

  afterEach(async () => {
    await fake.stop()
  })

  function newAdapter() {
    const stateDir = mkdtempSync(join(tmpdir(), 'wcc-outbound-'))
    const acct: Account = { id: 'A1', botId: 'b', userId: 'ubot', baseUrl: fake.baseUrl, token: 'T', syncBuf: '' }
    return makeIlinkAdapter({ stateDir, accounts: [acct], ...newAdapterDeps() })
  }

  it('starts unknown before any send', () => {
    const a = newAdapter()
    expect(a.outboundHealth()).toMatchObject({ state: 'unknown', consecutiveFailures: 0 })
  })

  it('a successful wire send flips state to ok', async () => {
    const a = newAdapter()
    a.captureContextToken('chat-1', 'tok-1')
    const r = await a.sendMessage('chat-1', 'hi')
    expect(r.error).toBeUndefined()
    const snap = a.outboundHealth()
    expect(snap.state).toBe('ok')
    expect(snap.consecutiveFailures).toBe(0)
    expect(snap.lastOkAt).not.toBeNull()
  })

  it('wire failures degrade after the default threshold (2); a later success recovers to ok', async () => {
    const a = newAdapter()
    a.captureContextToken('chat-1', 'tok-1')
    fake.failSendMessage({ errcode: -6, errmsg: 'auth failed' })

    const r1 = await a.sendMessage('chat-1', 'one')
    expect(r1.error).toBeTruthy()
    // First failure alone must not cross the threshold yet.
    expect(a.outboundHealth().state).toBe('unknown')
    expect(a.outboundHealth().consecutiveFailures).toBe(1)

    const r2 = await a.sendMessage('chat-1', 'two')
    expect(r2.error).toBeTruthy()
    const degraded = a.outboundHealth()
    expect(degraded.state).toBe('degraded')
    expect(degraded.consecutiveFailures).toBe(2)
    expect(degraded.lastError).toContain('auth failed')

    fake.succeedSendMessage()
    const r3 = await a.sendMessage('chat-1', 'three')
    expect(r3.error).toBeUndefined()
    const recovered = a.outboundHealth()
    expect(recovered.state).toBe('ok')
    expect(recovered.consecutiveFailures).toBe(0)
  })

  it('empty text does not touch the tracker (early return before the wire)', async () => {
    const a = newAdapter()
    a.captureContextToken('chat-1', 'tok-1')
    const before = a.outboundHealth()
    const r = await a.sendMessage('chat-1', '')
    expect(r.error).toBe('empty text')
    expect(a.outboundHealth()).toEqual(before)
  })

  it('an unroutable chat (client-side error) does not touch the tracker', async () => {
    const a = newAdapter()
    const before = a.outboundHealth()
    const r = await a.sendMessage('unknown-chat-never-seen', 'hi')
    expect(r.error).toBeTruthy()
    expect(a.outboundHealth()).toEqual(before)
  })
})
