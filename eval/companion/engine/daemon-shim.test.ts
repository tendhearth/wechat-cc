import { describe, it, expect, afterEach } from 'vitest'
import { startFakeIlink, type FakeIlinkHandle } from '../../../src/daemon/__e2e__/fake-ilink-server'
import { waitForNewReply } from './daemon-shim'

// POST a reply into the fake ilink outbox, mirroring the real wire shape
// (`{ msg: { to_user_id, item_list } }`) the daemon sends.
async function postReply(ilink: FakeIlinkHandle, chatId: string, text: string): Promise<void> {
  const res = await fetch(`${ilink.baseUrl}/ilink/bot/sendmessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ msg: { to_user_id: chatId, item_list: [{ type: 1, text_item: { text } }] } }),
  })
  await res.json()
}

const tick = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('waitForNewReply', () => {
  let ilink: FakeIlinkHandle

  afterEach(async () => { await ilink?.stop() })

  it('does NOT resolve off a reply that predates the call (the cumulative-some race)', async () => {
    ilink = await startFakeIlink()
    await postReply(ilink, 'c1', 'first reply') // outbox already has 1 reply for c1

    let resolved = false
    const p = waitForNewReply(ilink, 'c1', 2000).then(() => { resolved = true }).catch(() => {})

    await tick(200)
    expect(resolved).toBe(false) // must keep waiting — the pre-existing reply doesn't count

    await postReply(ilink, 'c1', 'second reply') // now the count grows past the baseline
    await p
    expect(resolved).toBe(true)
  })

  it('only resolves on a reply to the target chat, ignoring other chats', async () => {
    ilink = await startFakeIlink()

    let resolved = false
    const p = waitForNewReply(ilink, 'c1', 2000).then(() => { resolved = true }).catch(() => {})

    await postReply(ilink, 'c2', 'reply to a different chat')
    await tick(200)
    expect(resolved).toBe(false)

    await postReply(ilink, 'c1', 'reply to the target chat')
    await p
    expect(resolved).toBe(true)
  })

  it('captures the new reply text', async () => {
    ilink = await startFakeIlink()
    await postReply(ilink, 'c1', 'old')

    const pending = waitForNewReply(ilink, 'c1', 2000)
    await postReply(ilink, 'c1', 'NEW')
    const out = await pending

    const c1Replies = out.filter(m => m.endpoint === 'sendmessage' && m.chatId === 'c1')
    expect(c1Replies.at(-1)?.text).toBe('NEW')
  })
})

describe('waitForNewReply — settle window (split-reply burst)', () => {
  it('absorbs the whole burst of same-turn bubbles before resolving', async () => {
    const outbox: Array<{ endpoint: string; chatId: string; text: string }> = []
    const ilink = {
      outbox: () => outbox as never,
      waitForOutbound: async (pred: (m: never) => boolean, timeoutMs = 5000) => {
        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
          if (pred(outbox as never)) return outbox as never
          await new Promise(r => setTimeout(r, 10))
        }
        throw new Error('timeout')
      },
    }
    // Burst: bubble 1 now, bubble 2 after 300ms — well inside the settle window.
    setTimeout(() => outbox.push({ endpoint: 'sendmessage', chatId: 'c1', text: '气泡一' }), 30)
    setTimeout(() => outbox.push({ endpoint: 'sendmessage', chatId: 'c1', text: '气泡二' }), 330)
    const replies = await waitForNewReply(ilink as never, 'c1', 5000, 600)
    expect(replies.map(r => r.text)).toEqual(['气泡一', '气泡二'])
  })
})
