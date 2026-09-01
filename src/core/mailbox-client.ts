/**
 * mailbox-client.ts — outbound HTTP to a relay (/drop, /fetch, /ack). Pure
 * HTTP, timeout-bounded, no app logic — the mailbox analogue of a2a-client.ts.
 * See spec §3.1.
 */
export interface MailboxClient {
  drop(relayUrl: string, to: string, envelope: string): Promise<boolean>
  fetch(relayUrl: string, mailbox: string, since: number, ts: number, sig: string): Promise<{ items: Array<{ cursor: number; envelope: string }>; next_cursor: number } | null>
  ack(relayUrl: string, mailbox: string, upToCursor: number, ts: number, sig: string): Promise<boolean>
}

const base = (u: string) => u.replace(/\/+$/, '')

export function makeMailboxClient(opts: { timeoutMs?: number } = {}): MailboxClient {
  const timeoutMs = opts.timeoutMs ?? 10_000

  /**
   * The timer MUST stay armed across the BODY read, not just the request.
   *
   * `fetch()` resolves as soon as response HEADERS arrive; a timer cleared at
   * that point leaves `res.json()` completely unbounded, so a peer that sends
   * headers and then stalls the body hangs the caller forever. That is exactly
   * what wedged the mailbox poller in production (2026-08-29, three times:
   * `[SCHED] mailbox tick exceeded 660000ms — proceeding without it`), and it
   * hit all three callers of this client — pairing, social send, poller.
   * `a2a-client.ts`'s withTimeout has always scoped this correctly; this file
   * had drifted from it despite the header comment claiming to be its analogue.
   *
   * Any failure (network throw, abort, malformed JSON) collapses to `null` —
   * the caller contract is "never throws".
   */
  async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs)
    try { return await fn(ac.signal) }
    catch { return null }
    finally { clearTimeout(t) }
  }

  const post = (url: string, body: unknown, signal: AbortSignal) =>
    fetch(url, { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  return {
    async drop(relayUrl, to, envelope) {
      return await withTimeout(async (signal) => {
        const r = await post(`${base(relayUrl)}/drop`, { to, envelope }, signal)
        return r.ok
      }) ?? false
    },
    async fetch(relayUrl, mailbox, since, ts, sig) {
      return await withTimeout(async (signal) => {
        const r = await post(`${base(relayUrl)}/fetch`, { mailbox, since, ts, sig }, signal)
        if (!r.ok) return null
        return await r.json() as { items: Array<{ cursor: number; envelope: string }>; next_cursor: number }
      })
    },
    async ack(relayUrl, mailbox, upToCursor, ts, sig) {
      return await withTimeout(async (signal) => {
        const r = await post(`${base(relayUrl)}/ack`, { mailbox, up_to_cursor: upToCursor, ts, sig }, signal)
        return r.ok
      }) ?? false
    },
  }
}
