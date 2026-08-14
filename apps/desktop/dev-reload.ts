/**
 * dev-reload — SSE live reload for the desktop dev server.
 *
 * Lifted verbatim from the retired apps/desktop/dev-server.ts so the single
 * merged dev server (test-shim.ts) keeps the same behavior: watch src/,
 * coalesce burst saves in a 50ms window, push one `reload` event over SSE.
 * The client script is served as a same-origin .js file (NOT inline) so it
 * passes tauri's `script-src 'self'` CSP. See spec 2026-07-26 §1.
 */
import { watch, type FSWatcher } from 'node:fs'

const RELOAD_CLIENT_JS = `// dev live-reload client
(function () {
  let reconnectDelay = 250
  function connect() {
    const es = new EventSource('/__dev_reload')
    es.addEventListener('reload', () => {
      console.log('[dev] reload')
      location.reload()
    })
    es.onopen = () => { reconnectDelay = 250 }
    es.onerror = () => {
      es.close()
      // backoff so a server restart triggers exactly one reload when it
      // comes back up, not a tight loop.
      setTimeout(connect, reconnectDelay)
      reconnectDelay = Math.min(reconnectDelay * 2, 3000)
    }
  }
  connect()
})()
`

export const RELOAD_SCRIPT_TAG = '<script src="/__dev_reload.js"></script>'

/** Inject before the LAST </body> (greedy lookahead so a </body> inside a
 *  string literal or comment doesn't grab it); append when absent. */
export function injectReloadScript(html: string): string {
  const bodyClose = /<\/body\s*>(?![\s\S]*<\/body\s*>)/i
  if (bodyClose.test(html)) return html.replace(bodyClose, (m) => `  ${RELOAD_SCRIPT_TAG}\n  ${m}`)
  return `${html}\n${RELOAD_SCRIPT_TAG}\n`
}

type Send = (msg: string) => void

export function makeLiveReload(opts: { root: string; log?: (line: string) => void }) {
  const log = opts.log ?? (() => {})
  const clients = new Set<Send>()
  let pending: ReturnType<typeof setTimeout> | null = null
  let watcher: FSWatcher | null = null

  function broadcast() {
    const payload = `event: reload\ndata: ${Date.now()}\n\n`
    for (const send of clients) {
      try { send(payload) } catch { clients.delete(send) }
    }
  }

  /** Debounced (50ms) reload broadcast — editor saves fire in bursts. */
  function notify(filename: string | null): void {
    if (pending) clearTimeout(pending)
    pending = setTimeout(() => {
      pending = null
      if (filename) log(`reload (${filename})`)
      broadcast()
    }, 50)
  }

  return {
    /** Handle the two reload endpoints; null = not ours. */
    handle(pathname: string): Response | null {
      if (pathname === '/__dev_reload.js') {
        return new Response(RELOAD_CLIENT_JS, {
          headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' },
        })
      }
      if (pathname !== '/__dev_reload') return null
      let send!: Send
      const stream = new ReadableStream({
        start(controller) {
          send = (msg: string) => {
            try { controller.enqueue(new TextEncoder().encode(msg)) }
            catch { clients.delete(send) }
          }
          clients.add(send)
          send(': connected\n\n')   // keeps proxies from buffering the stream
        },
        cancel() { clients.delete(send) },
      })
      return new Response(stream, {
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
          'x-accel-buffering': 'no',
        },
      })
    },

    notify,

    watch(): void {
      if (watcher) return
      watcher = watch(opts.root, { recursive: true }, (_event, filename) => {
        if (!filename) return
        // Ignore editor swap files, etc.
        if (/(^|\/)\..+\.sw[a-z]$|~$/.test(String(filename))) return
        notify(String(filename))
      })
    },

    close(): void {
      if (pending) { clearTimeout(pending); pending = null }
      watcher?.close(); watcher = null
      clients.clear()
    },
  }
}
