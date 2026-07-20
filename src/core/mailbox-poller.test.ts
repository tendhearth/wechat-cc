import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { makeMailboxPoller } from './mailbox-poller'
import { loadMailboxIdentity, sealEnvelope } from './mailbox-crypto'   // real identity + real seal — no testkit
import { makeCursorStore } from './mailbox-cursor-store'
import type { MailboxClient } from './mailbox-client'

describe('makeMailboxPoller', () => {
  it('fetch → open → dispatch → ack, advancing the per-relay cursor; malformed envelopes are skipped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbxp-'))
    const me = loadMailboxIdentity(dir)                      // real identity with enc_priv
    const good = JSON.stringify(sealEnvelope({ path: '/a2a/letter', bearer: 'b', body: { channel_id: 'c' } }, me.enc_pub))
    const acked: number[] = []
    const client: MailboxClient = {
      drop: async () => true,
      fetch: async (_r, _m, since) => since === 0
        ? { items: [{ cursor: 1, envelope: 'not-json' }, { cursor: 2, envelope: good }], next_cursor: 2 }
        : { items: [], next_cursor: since },
      ack: async (_r, _m, upTo) => { acked.push(upTo); return true },
    }
    const dispatched: unknown[] = []
    const poller = makeMailboxPoller({
      identity: me, relays: ['https://r/'], client, cursors: makeCursorStore(dir),
      dispatch: { dispatch: async (inner) => { dispatched.push(inner) } }, log: () => {},
    })
    await poller.onTick()
    expect(dispatched).toEqual([{ path: '/a2a/letter', bearer: 'b', body: { channel_id: 'c' } }])   // malformed skipped
    expect(acked).toEqual([2])
    await poller.onTick()                                     // cursor persisted → since=2 → no-op
    expect(acked).toEqual([2])
  })
  it('a relay fetch failure does not throw and does not advance the cursor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbxp2-'))
    const me = loadMailboxIdentity(dir)
    const client: MailboxClient = { drop: async () => true, fetch: async () => null, ack: async () => true }
    const poller = makeMailboxPoller({ identity: me, relays: ['https://r/'], client, cursors: makeCursorStore(dir), dispatch: { dispatch: async () => {} }, log: () => {} })
    await expect(poller.onTick()).resolves.toBeUndefined()
    expect(makeCursorStore(dir).get('https://r/')).toBe(0)
  })
})
