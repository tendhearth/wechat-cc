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

  /**
   * WHY(2026-09-01,Mac↔Windows 真机闭环):`fetch` 返回 null 的含义是
   * 「**取不到**」—— 超时、非 2xx、网络错误全都塌缩成这一个 null
   * (见 mailbox-client.ts 的 withTimeout 与 `if (!r.ok) return null`)。
   * 而 poller 原先写的是 `if (!page || page.items.length === 0) continue`,
   * 把它和「**信箱是空的**」并成同一条静默路径。
   *
   * 后果:Windows 那台连着中继取不到信,日志与「今天没来信」一模一样,
   * 排查时无从下手 —— 又一个「出了错但没有任何东西会告诉你」。
   * 空信箱必须继续保持安静(每 2 分钟一条噪音没人看),取件失败必须出声。
   */
  it('取件失败会出声,而空信箱保持安静 —— 两者不可再无法区分', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbxp3-'))
    const me = loadMailboxIdentity(dir)
    const lines: string[] = []
    const log = (tag: string, line: string) => { lines.push(`${tag} ${line}`) }
    const make = (fetch: MailboxClient['fetch']) => makeMailboxPoller({
      identity: me, relays: ['https://r/'], client: { drop: async () => true, fetch, ack: async () => true },
      cursors: makeCursorStore(dir), dispatch: { dispatch: async () => {} }, log,
    })

    await make(async () => null).onTick()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('https://r/')

    lines.length = 0
    await make(async () => ({ items: [], next_cursor: 0 })).onTick()
    expect(lines).toEqual([])
  })
})
