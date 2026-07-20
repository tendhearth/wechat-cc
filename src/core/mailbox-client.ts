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
  async function post(url: string, body: unknown): Promise<Response | null> {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs)
    try { return await fetch(url, { method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }
    catch { return null } finally { clearTimeout(t) }
  }
  return {
    async drop(relayUrl, to, envelope) { const r = await post(`${base(relayUrl)}/drop`, { to, envelope }); return !!r?.ok },
    async fetch(relayUrl, mailbox, since, ts, sig) {
      const r = await post(`${base(relayUrl)}/fetch`, { mailbox, since, ts, sig })
      if (!r?.ok) return null
      try { return await r.json() as { items: Array<{ cursor: number; envelope: string }>; next_cursor: number } } catch { return null }
    },
    async ack(relayUrl, mailbox, upToCursor, ts, sig) { const r = await post(`${base(relayUrl)}/ack`, { mailbox, up_to_cursor: upToCursor, ts, sig }); return !!r?.ok },
  }
}
