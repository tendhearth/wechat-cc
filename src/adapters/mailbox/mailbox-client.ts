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

export interface MailboxClientOpts {
  timeoutMs?: number
  /**
   * 失败原因的出口。`reason` 是可分辨的:`HTTP <code>` / `timeout(<ms>ms)` /
   * 底层网络错误原文。
   *
   * 2026-09-01:真机上 Mac 的取件连续几百拍失败,日志只会说「超时/非 2xx/
   * 网络」—— 三种成因的处置完全不同(超时=调 timeoutMs 或换中继;401=签名
   * 或时钟;网络=DNS/断网),混成一句等于什么都没说。手工探针一跑就发现
   * 中继好好的、200 只要 0.5s,真成因是间歇性超时 —— 那条日志本该直接说。
   */
  onError?: (op: 'drop' | 'fetch' | 'ack', reason: string) => void
  /** 注入点,仅测试用(默认 globalThis.fetch)。刻意窄于 `typeof fetch`
   *  —— Bun 的 fetch 上还挂着 preconnect 之类的自有属性,用全类型会逼着
   *  每个假 fetch 去实现它们。 */
  fetchImpl?: FetchLike
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export function makeMailboxClient(opts: MailboxClientOpts = {}): MailboxClient {
  const timeoutMs = opts.timeoutMs ?? 10_000
  const doFetch: FetchLike = opts.fetchImpl ?? ((url, init) => globalThis.fetch(url, init))
  const report = (op: 'drop' | 'fetch' | 'ack', reason: string) => { try { opts.onError?.(op, reason) } catch { /* 报错的路不许自己再炸 */ } }

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
  async function withTimeout<T>(op: 'drop' | 'fetch' | 'ack', fn: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
    const ac = new AbortController()
    let timedOut = false
    const t = setTimeout(() => { timedOut = true; ac.abort(new Error('timeout')) }, timeoutMs)
    try { return await fn(ac.signal) }
    catch (err) {
      // 超时和网络错误在这里长得一样(都是一个 abort/TypeError),分不开就
      // 只能报「网络」—— 所以用 timedOut 这个自己设的旗子来分,而不是去猜
      // 错误消息的措辞。
      report(op, timedOut ? `timeout(${timeoutMs}ms)` : (err instanceof Error ? err.message : String(err)))
      return null
    }
    finally { clearTimeout(t) }
  }

  const post = (url: string, body: unknown, signal: AbortSignal) =>
    doFetch(url, { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  return {
    async drop(relayUrl, to, envelope) {
      return await withTimeout('drop', async (signal) => {
        const r = await post(`${base(relayUrl)}/drop`, { to, envelope }, signal)
        if (!r.ok) report('drop', `HTTP ${r.status}`)
        return r.ok
      }) ?? false
    },
    async fetch(relayUrl, mailbox, since, ts, sig) {
      return await withTimeout('fetch', async (signal) => {
        const r = await post(`${base(relayUrl)}/fetch`, { mailbox, since, ts, sig }, signal)
        if (!r.ok) { report('fetch', `HTTP ${r.status}`); return null }
        return await r.json() as { items: Array<{ cursor: number; envelope: string }>; next_cursor: number }
      })
    },
    async ack(relayUrl, mailbox, upToCursor, ts, sig) {
      return await withTimeout('ack', async (signal) => {
        const r = await post(`${base(relayUrl)}/ack`, { mailbox, up_to_cursor: upToCursor, ts, sig }, signal)
        if (!r.ok) report('ack', `HTTP ${r.status}`)
        return r.ok
      }) ?? false
    },
  }
}
