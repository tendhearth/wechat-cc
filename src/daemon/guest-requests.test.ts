import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { InboundMsg } from '../core/prompt-format'
import type { StateStore } from './state-store'

// Controllable node:crypto randomInt — most tests leave the queue empty and
// fall through to the real implementation; the collision test seeds a
// specific sequence to force a namespace collision + regeneration.
let queuedRandomInts: number[] = []
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return {
    ...actual,
    randomInt: (..._args: unknown[]) => {
      if (queuedRandomInts.length > 0) return queuedRandomInts.shift()!
      return actual.randomInt(0, 1_000_000)
    },
  }
})

const { makeGuestRequestStore, GUEST_REQUEST_TTL_MS } = await import('./guest-requests')

function mkMsg(opts: { chatId?: string; text?: string } = {}): InboundMsg {
  return {
    chatId: opts.chatId ?? 'stranger@im.wechat',
    userId: opts.chatId ?? 'stranger@im.wechat',
    text: opts.text ?? '你好',
    msgType: 'text',
    createTimeMs: 1_000,
    accountId: 'acct-1',
  }
}

// In-memory StateStore fake — same convention as onboarding.test.ts: fast,
// no fs I/O for the unit-level tests; the disk-shape test below also uses
// this since only the JSON shape matters, not real file I/O.
function makeMemStore(): StateStore {
  const data: Record<string, string> = {}
  return {
    get: (k) => data[k],
    set: (k, v) => { data[k] = v },
    delete: (k) => { delete data[k] },
    all: () => ({ ...data }),
    flush: async () => {},
  }
}

beforeEach(() => {
  queuedRandomInts = []
})

describe('upsertRequest', () => {
  it('creates a fresh pending request on first contact', () => {
    const store = makeGuestRequestStore({ stateDir: '/unused', store: makeMemStore(), now: () => 5_000 })
    const msg = mkMsg()
    const { request, fresh } = store.upsertRequest({
      chatId: msg.chatId, firstMsg: msg, contextToken: 'tok-1', accountId: 'acct-1',
    })
    expect(fresh).toBe(true)
    expect(request.chatId).toBe(msg.chatId)
    expect(request.status).toBe('pending')
    expect(request.createdAt).toBe(5_000)
    expect(request.code).toMatch(/^\d{6}$/)
  })

  it('is idempotent: a second upsert for the same chatId returns the existing entry, unchanged code, fresh:false', () => {
    const store = makeGuestRequestStore({ stateDir: '/unused', store: makeMemStore(), now: () => 5_000 })
    const msg = mkMsg()
    const first = store.upsertRequest({ chatId: msg.chatId, firstMsg: msg, contextToken: 'tok-1', accountId: 'acct-1' })
    const second = store.upsertRequest({ chatId: msg.chatId, firstMsg: msg, contextToken: 'tok-1', accountId: 'acct-1' })
    expect(second.fresh).toBe(false)
    expect(second.request.code).toBe(first.request.code)
    expect(second.request.createdAt).toBe(first.request.createdAt)
  })

  it('notifiedAt starts null — it is NOT stamped until markNotified() confirms the send', () => {
    const store = makeGuestRequestStore({ stateDir: '/unused', store: makeMemStore(), now: () => 5_000 })
    const msg = mkMsg()
    const { request, fresh } = store.upsertRequest({ chatId: msg.chatId, firstMsg: msg, contextToken: 'tok-1', accountId: 'acct-1' })
    expect(fresh).toBe(true)
    expect(request.notifiedAt).toBeNull()
  })

  it('retry contract: re-upserting an existing, not-yet-notified request reports fresh:false but notifiedAt is still null — the caller\'s retry-notify signal', () => {
    const store = makeGuestRequestStore({ stateDir: '/unused', store: makeMemStore(), now: () => 5_000 })
    const msg = mkMsg()
    store.upsertRequest({ chatId: msg.chatId, firstMsg: msg, contextToken: 'tok-1', accountId: 'acct-1' })
    // No markNotified() call in between — simulates a crashed/failed prior send.
    const second = store.upsertRequest({ chatId: msg.chatId, firstMsg: msg, contextToken: 'tok-1', accountId: 'acct-1' })
    expect(second.fresh).toBe(false)
    expect(second.request.notifiedAt).toBeNull()
  })

  it('fix round 1 fold #4: a repeat upsert refreshes contextToken/accountId from the LATEST call — firstMsg stays the original', () => {
    const store = makeGuestRequestStore({ stateDir: '/unused', store: makeMemStore(), now: () => 5_000 })
    const msg = mkMsg({ text: '第一句问题' })
    const first = store.upsertRequest({ chatId: msg.chatId, firstMsg: msg, contextToken: 'stale-tok', accountId: 'acct-old' })
    expect(first.fresh).toBe(true)

    const second = store.upsertRequest({ chatId: msg.chatId, firstMsg: msg, contextToken: 'fresh-tok', accountId: 'acct-new' })
    expect(second.fresh).toBe(false)
    expect(second.request.contextToken).toBe('fresh-tok')
    expect(second.request.accountId).toBe('acct-new')
    // The original question is preserved verbatim for the post-approval redispatch.
    expect(second.request.firstMsg).toEqual(msg)
    expect(second.request.code).toBe(first.request.code)
    expect(second.request.createdAt).toBe(first.request.createdAt)
  })

  it('fix round 1 fold #4: an empty contextToken on the repeat call does NOT regress a known-good stored token to blank', () => {
    const store = makeGuestRequestStore({ stateDir: '/unused', store: makeMemStore(), now: () => 5_000 })
    const msg = mkMsg()
    store.upsertRequest({ chatId: msg.chatId, firstMsg: msg, contextToken: 'good-tok', accountId: 'acct-1' })
    const second = store.upsertRequest({ chatId: msg.chatId, firstMsg: msg, contextToken: '', accountId: 'acct-1' })
    expect(second.request.contextToken).toBe('good-tok')
  })

  it('generates a fresh unique code on collision within the request-code namespace', () => {
    const store = makeGuestRequestStore({ stateDir: '/unused', store: makeMemStore(), now: () => 1_000 })
    // First request pins code 111111.
    queuedRandomInts = [111_111]
    const a = store.upsertRequest({ chatId: 'a@im.wechat', firstMsg: mkMsg({ chatId: 'a@im.wechat' }), contextToken: 't', accountId: 'acct-1' })
    expect(a.request.code).toBe('111111')

    // Second request: first draw collides with a's code, second draw is fresh.
    queuedRandomInts = [111_111, 222_222]
    const b = store.upsertRequest({ chatId: 'b@im.wechat', firstMsg: mkMsg({ chatId: 'b@im.wechat' }), contextToken: 't', accountId: 'acct-1' })
    expect(b.request.code).toBe('222222')
    expect(b.request.code).not.toBe(a.request.code)
  })
})

describe('48h TTL', () => {
  it('filters expired requests on read (findByCode returns null past TTL)', () => {
    let now = 0
    const store = makeGuestRequestStore({ stateDir: '/unused', store: makeMemStore(), now: () => now })
    const msg = mkMsg()
    const { request } = store.upsertRequest({ chatId: msg.chatId, firstMsg: msg, contextToken: 't', accountId: 'acct-1' })
    now = GUEST_REQUEST_TTL_MS - 1
    expect(store.findByCode(request.code)).not.toBeNull()
    now = GUEST_REQUEST_TTL_MS + 1
    expect(store.findByCode(request.code)).toBeNull()
  })

  it('a fresh upsert after expiry treats the chat as new (fresh:true again, new code allowed)', () => {
    let now = 0
    const store = makeGuestRequestStore({ stateDir: '/unused', store: makeMemStore(), now: () => now })
    const msg = mkMsg()
    const first = store.upsertRequest({ chatId: msg.chatId, firstMsg: msg, contextToken: 't', accountId: 'acct-1' })
    now = GUEST_REQUEST_TTL_MS + 100
    const second = store.upsertRequest({ chatId: msg.chatId, firstMsg: msg, contextToken: 't', accountId: 'acct-1' })
    expect(second.fresh).toBe(true)
    expect(second.request.createdAt).toBe(now)
    void first
  })

  it('lazily cleans expired entries from disk on the next write', () => {
    let now = 0
    const backing = makeMemStore()
    const store = makeGuestRequestStore({ stateDir: '/unused', store: backing, now: () => now })
    store.upsertRequest({ chatId: 'old@im.wechat', firstMsg: mkMsg({ chatId: 'old@im.wechat' }), contextToken: 't', accountId: 'acct-1' })
    now = GUEST_REQUEST_TTL_MS + 100
    store.upsertRequest({ chatId: 'new@im.wechat', firstMsg: mkMsg({ chatId: 'new@im.wechat' }), contextToken: 't', accountId: 'acct-1' })
    const onDisk = JSON.parse(backing.get('requests')!) as Record<string, unknown>
    expect(Object.keys(onDisk)).toEqual(['new@im.wechat'])
  })

  it('expired invites are pruned from disk on the next createInvite', () => {
    let now = 0
    const backing = makeMemStore()
    const store = makeGuestRequestStore({ stateDir: '/unused', store: backing, now: () => now })
    const first = store.createInvite()
    now = GUEST_REQUEST_TTL_MS + 100
    store.createInvite()
    const onDisk = JSON.parse(backing.get('invites')!) as Array<{ code: string }>
    expect(onDisk.find(i => i.code === first.code)).toBeUndefined()
    expect(onDisk).toHaveLength(1)
  })
})

describe('resolve', () => {
  it('resolve(code, "allowed") returns the request and removes it from the store', () => {
    const store = makeGuestRequestStore({ stateDir: '/unused', store: makeMemStore(), now: () => 1_000 })
    const msg = mkMsg()
    const { request } = store.upsertRequest({ chatId: msg.chatId, firstMsg: msg, contextToken: 't', accountId: 'acct-1' })
    const resolved = store.resolve(request.code, 'allowed')
    expect(resolved?.chatId).toBe(msg.chatId)
    expect(store.findByCode(request.code)).toBeNull()
    expect(store.listPending()).toEqual([])
  })

  it('resolve(code, "denied") keeps a denied record and wasDenied becomes true', () => {
    const store = makeGuestRequestStore({ stateDir: '/unused', store: makeMemStore(), now: () => 1_000 })
    const msg = mkMsg()
    const { request } = store.upsertRequest({ chatId: msg.chatId, firstMsg: msg, contextToken: 't', accountId: 'acct-1' })
    expect(store.wasDenied(msg.chatId)).toBe(false)
    const resolved = store.resolve(request.code, 'denied')
    expect(resolved?.chatId).toBe(msg.chatId)
    expect(store.wasDenied(msg.chatId)).toBe(true)
    expect(store.listPending()).toEqual([])
  })

  it('a denied record expires (wasDenied) after 48h — expiry means back to plain silence', () => {
    let now = 0
    const store = makeGuestRequestStore({ stateDir: '/unused', store: makeMemStore(), now: () => now })
    const msg = mkMsg()
    const { request } = store.upsertRequest({ chatId: msg.chatId, firstMsg: msg, contextToken: 't', accountId: 'acct-1' })
    store.resolve(request.code, 'denied')
    now = GUEST_REQUEST_TTL_MS + 1
    expect(store.wasDenied(msg.chatId)).toBe(false)
  })

  it('resolve with an unknown or already-resolved code returns null', () => {
    const store = makeGuestRequestStore({ stateDir: '/unused', store: makeMemStore(), now: () => 1_000 })
    expect(store.resolve('000000', 'allowed')).toBeNull()

    const msg = mkMsg()
    const { request } = store.upsertRequest({ chatId: msg.chatId, firstMsg: msg, contextToken: 't', accountId: 'acct-1' })
    store.resolve(request.code, 'denied')
    // Code was consumed into a denied record — resolving it again must not match (it's no longer 'pending').
    expect(store.resolve(request.code, 'allowed')).toBeNull()
  })
})

describe('markNotified', () => {
  it('flips notifiedAt from null to now() on an existing pending record, and persists durably', () => {
    const backing = makeMemStore()
    const storeA = makeGuestRequestStore({ stateDir: '/unused', store: backing, now: () => 5_000 })
    const msg = mkMsg()
    const { request } = storeA.upsertRequest({ chatId: msg.chatId, firstMsg: msg, contextToken: 't', accountId: 'acct-1' })
    expect(request.notifiedAt).toBeNull()

    storeA.markNotified(msg.chatId)
    expect(storeA.findByCode(request.code)?.notifiedAt).toBe(5_000)

    // Simulate a restart: fresh handler instance over the SAME backing store.
    const storeB = makeGuestRequestStore({ stateDir: '/unused', store: backing, now: () => 9_000 })
    expect(storeB.findByCode(request.code)?.notifiedAt).toBe(5_000)
  })

  it('is idempotent: a second call does not overwrite an already-set notifiedAt', () => {
    let now = 5_000
    const store = makeGuestRequestStore({ stateDir: '/unused', store: makeMemStore(), now: () => now })
    const msg = mkMsg()
    const { request } = store.upsertRequest({ chatId: msg.chatId, firstMsg: msg, contextToken: 't', accountId: 'acct-1' })
    store.markNotified(msg.chatId)
    now = 9_000
    store.markNotified(msg.chatId)   // second call, later "now" — must NOT bump the timestamp
    expect(store.findByCode(request.code)?.notifiedAt).toBe(5_000)
  })

  it('no-ops on an absent chatId (no throw, nothing created)', () => {
    const store = makeGuestRequestStore({ stateDir: '/unused', store: makeMemStore(), now: () => 1_000 })
    expect(() => store.markNotified('nobody@im.wechat')).not.toThrow()
    expect(store.listPending()).toEqual([])
  })

  it('no-ops on a denied (non-pending) record — does not resurrect or backdate it', () => {
    const store = makeGuestRequestStore({ stateDir: '/unused', store: makeMemStore(), now: () => 1_000 })
    const msg = mkMsg()
    const { request } = store.upsertRequest({ chatId: msg.chatId, firstMsg: msg, contextToken: 't', accountId: 'acct-1' })
    store.resolve(request.code, 'denied')
    store.markNotified(msg.chatId)
    // Still denied, and notifiedAt is untouched (stays null — was never notified before denial).
    expect(store.wasDenied(msg.chatId)).toBe(true)
    expect(store.findByCode(request.code)?.notifiedAt).toBeNull()
  })
})

describe('listPending', () => {
  it('lists only pending (not denied) live requests, oldest first', () => {
    let now = 0
    const store = makeGuestRequestStore({ stateDir: '/unused', store: makeMemStore(), now: () => now })
    now = 100
    store.upsertRequest({ chatId: 'a@im.wechat', firstMsg: mkMsg({ chatId: 'a@im.wechat' }), contextToken: 't', accountId: 'acct-1' })
    now = 200
    const b = store.upsertRequest({ chatId: 'b@im.wechat', firstMsg: mkMsg({ chatId: 'b@im.wechat' }), contextToken: 't', accountId: 'acct-1' })
    now = 300
    store.upsertRequest({ chatId: 'c@im.wechat', firstMsg: mkMsg({ chatId: 'c@im.wechat' }), contextToken: 't', accountId: 'acct-1' })
    store.resolve(b.request.code, 'denied')

    const pending = store.listPending()
    expect(pending.map(r => r.chatId)).toEqual(['a@im.wechat', 'c@im.wechat'])
  })

  it('returns an empty array when there is nothing pending', () => {
    const store = makeGuestRequestStore({ stateDir: '/unused', store: makeMemStore(), now: () => 1_000 })
    expect(store.listPending()).toEqual([])
  })
})

describe('invites', () => {
  it('createInvite mints a 6-digit code; consumeInvite is single-use', () => {
    const store = makeGuestRequestStore({ stateDir: '/unused', store: makeMemStore(), now: () => 1_000 })
    const invite = store.createInvite()
    expect(invite.code).toMatch(/^\d{6}$/)
    expect(store.consumeInvite(invite.code)).toBe(true)
    // Second consume of the same code fails — already spent.
    expect(store.consumeInvite(invite.code)).toBe(false)
  })

  it('consumeInvite on an unknown code returns false without touching the store', () => {
    const store = makeGuestRequestStore({ stateDir: '/unused', store: makeMemStore(), now: () => 1_000 })
    expect(store.consumeInvite('999999')).toBe(false)
  })

  it('multiple invites can be live at once, each independently consumable', () => {
    const store = makeGuestRequestStore({ stateDir: '/unused', store: makeMemStore(), now: () => 1_000 })
    const i1 = store.createInvite()
    const i2 = store.createInvite()
    expect(store.consumeInvite(i1.code)).toBe(true)
    expect(store.consumeInvite(i2.code)).toBe(true)
  })

  it('invite codes and request codes occupy independent namespaces (a collision across namespaces is fine)', () => {
    const store = makeGuestRequestStore({ stateDir: '/unused', store: makeMemStore(), now: () => 1_000 })
    queuedRandomInts = [333_333]
    const req = store.upsertRequest({ chatId: 'x@im.wechat', firstMsg: mkMsg({ chatId: 'x@im.wechat' }), contextToken: 't', accountId: 'acct-1' })
    expect(req.request.code).toBe('333333')

    // An invite draws the SAME digits — must NOT be forced to regenerate,
    // since invite codes only check collisions against other invites.
    queuedRandomInts = [333_333]
    const invite = store.createInvite()
    expect(invite.code).toBe('333333')
  })
})

describe('seenMessage', () => {
  it('is idempotent: first call reports unseen (false), second call reports seen (true)', () => {
    const store = makeGuestRequestStore({ stateDir: '/unused', store: makeMemStore(), now: () => 1_000 })
    expect(store.seenMessage('msg-1')).toBe(false)
    expect(store.seenMessage('msg-1')).toBe(true)
  })

  it('different ids are tracked independently', () => {
    const store = makeGuestRequestStore({ stateDir: '/unused', store: makeMemStore(), now: () => 1_000 })
    expect(store.seenMessage('msg-1')).toBe(false)
    expect(store.seenMessage('msg-2')).toBe(false)
    expect(store.seenMessage('msg-1')).toBe(true)
  })

  it('seen ids persist across a restart (fresh handler, same backing store)', () => {
    const backing = makeMemStore()
    const storeA = makeGuestRequestStore({ stateDir: '/unused', store: backing, now: () => 1_000 })
    storeA.seenMessage('msg-1')
    const storeB = makeGuestRequestStore({ stateDir: '/unused', store: backing, now: () => 2_000 })
    expect(storeB.seenMessage('msg-1')).toBe(true)
  })
})

describe('on-disk shape', () => {
  it('persists requests/invites/seen under their own keys with the documented GuestRequest shape', () => {
    const backing = makeMemStore()
    const store = makeGuestRequestStore({ stateDir: '/unused', store: backing, now: () => 42_000 })
    const msg = mkMsg({ chatId: 'shape@im.wechat', text: 'hi there' })
    store.upsertRequest({ chatId: msg.chatId, firstMsg: msg, contextToken: 'tok-abc', accountId: 'acct-1' })
    store.createInvite()
    store.seenMessage('m-1')

    const requests = JSON.parse(backing.get('requests')!) as Record<string, unknown>
    expect(requests['shape@im.wechat']).toMatchObject({
      chatId: 'shape@im.wechat',
      contextToken: 'tok-abc',
      accountId: 'acct-1',
      createdAt: 42_000,
      notifiedAt: null,
      status: 'pending',
      firstMsg: msg,
    })
    expect((requests['shape@im.wechat'] as { code: string }).code).toMatch(/^\d{6}$/)

    const invites = JSON.parse(backing.get('invites')!) as Array<{ code: string; createdAt: number }>
    expect(invites).toHaveLength(1)
    expect(invites[0]).toMatchObject({ createdAt: 42_000 })
    expect(invites[0]!.code).toMatch(/^\d{6}$/)

    // seen persists as id -> first-seen-timestamp (needed for its own TTL prune).
    const seen = JSON.parse(backing.get('seen')!) as Record<string, number>
    expect(seen).toEqual({ 'm-1': 42_000 })
  })

  it('seen ids are lazily pruned off disk past the 48h TTL, same as requests/invites', () => {
    let now = 0
    const backing = makeMemStore()
    const store = makeGuestRequestStore({ stateDir: '/unused', store: backing, now: () => now })
    store.seenMessage('old-msg')
    now = GUEST_REQUEST_TTL_MS + 1
    store.seenMessage('new-msg')   // any write triggers the lazy prune
    const seen = JSON.parse(backing.get('seen')!) as Record<string, number>
    expect(Object.keys(seen)).toEqual(['new-msg'])
    // And the expired id is treated as unseen again (silently re-tracked).
    expect(store.seenMessage('old-msg')).toBe(false)
  })
})
