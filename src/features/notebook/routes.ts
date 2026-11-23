import { NotebookChatReadRequest, NotebookJotRequest, NotebookPageQuery, NotebookSeenRequest, NotebookWriteRequest, NotebookStrikeRequest, NotebookPaperRequest, WORKBENCH_ERRORS } from '@wechat-cc/protocol'
import { framedTooLargeFor } from '../../domain/matters/phone-scope'
import type { RouteHandler, RouteTable } from '../../daemon/internal-api/types'
import type { Notebook } from '../../ports/notebook'

const ok = (body: unknown) => ({ status: 200, body, headers: { 'cache-control': 'no-store' } })
type ErrorCode = 'notebook_invalid' | 'notebook_not_found' | 'notebook_not_owner' | 'notebook_page_too_large' | 'notebook_unavailable'
const failure = (error: ErrorCode) => ({ status: WORKBENCH_ERRORS[error]!.desktop as number, body: { error } })

export function notebookRoutes(n: Notebook): RouteTable {
  type Caller = NonNullable<Parameters<RouteHandler>[2]>
  const handle = (surface: 'page' | 'chat', fn: (n: Notebook, query: URLSearchParams, body: unknown, caller: Caller, budget?: number) => ReturnType<RouteHandler>): RouteHandler =>
    (query, body, caller) => {
      if (caller?.tier !== 'admin' || (surface === 'page'
        ? caller.origin !== 'operator' && caller.origin !== 'device'
        : caller.origin !== 'session' || !n.isOwner(caller))) return failure('notebook_not_owner')
      try { return fn(n, query, body, caller, caller.frameBudget) } catch { return failure('notebook_unavailable') }
    }

  return {
    'GET /v1/notebook/unseen': handle('page', n => ok(n.unseen())),
    'POST /v1/notebook/seen': handle('page', (n, _query, body) => {
      const input = NotebookSeenRequest.safeParse(body)
      if (!input.success) return failure('notebook_invalid')
      n.markRepliesSeen(input.data.ids)
      return ok({ ok: true })
    }),
    'GET /v1/notebook': handle('page', (n, query, _body, caller, budget) => {
      const input = NotebookPageQuery.safeParse({
        day: query.get('day') ?? undefined,
        after: query.get('after') ?? undefined,
        fonts: query.get('fonts') ?? undefined,
      })
      if (!input.success) return failure('notebook_invalid')
      const { day, after, fonts } = input.data
      void n.open(caller.origin === 'device' ? 'app' : 'desktop', fonts)?.catch(() => {})
      const page = n.page(day)
      const offset = after === undefined ? 0 : page.entries.findIndex(entry => entry.id === after) + 1
      if (after !== undefined && offset === 0) return failure('notebook_not_found')
      const entries = page.entries.slice(offset)
      const result = { ...page, entries }
      if (budget === undefined || !framedTooLargeFor(JSON.stringify(result), budget)) {
        // The phone can display the day once it has the final frame.
        if (caller.origin === 'device') {
          try {
            n.markRepliesSeen(page.entries.filter(entry => entry.author === 'cc' && entry.refId !== null).map(entry => entry.id))
          } catch { /* Reading still succeeds if read state cannot be saved. */ }
        }
        return ok(result)
      }

      // The paired-phone relay carries one response per frame. Keep whole
      // entries and continue the same day with an authenticated entry cursor.
      let low = 0
      let high = entries.length - 1
      while (low < high) {
        const count = Math.ceil((low + high) / 2)
        const part = { ...result, entries: entries.slice(0, count), nextAfter: entries[count - 1]!.id }
        if (framedTooLargeFor(JSON.stringify(part), budget)) high = count - 1
        else low = count
      }
      return low ? ok({ ...result, entries: entries.slice(0, low), nextAfter: entries[low - 1]!.id }) : failure('notebook_page_too_large')
    }),
    'POST /v1/notebook/write': handle('page', (n, _query, body, caller) => {
      const input = NotebookWriteRequest.safeParse(body)
      return input.success ? ok({ entry: n.write(input.data.body, input.data.clientId, caller.origin === 'device' ? 'app' : 'desktop') }) : failure('notebook_invalid')
    }),
    'POST /v1/notebook/strike': handle('page', (n, _query, body) => {
      const input = NotebookStrikeRequest.safeParse(body)
      if (!input.success) return failure('notebook_invalid')
      const result = n.strike(input.data.id, input.data.struck)
      if (result === 'cc') return failure('notebook_not_owner')
      return result === 'ok' ? ok({ ok: true }) : failure('notebook_not_found')
    }),
    'POST /v1/notebook/paper': handle('page', (n, _query, body) => {
      const input = NotebookPaperRequest.safeParse(body)
      return input.success ? ok({ paper: n.paper(input.data.paper) }) : failure('notebook_invalid')
    }),
    'POST /v1/notebook/chat/jot': handle('chat', (n, _query, body) => {
      const input = NotebookJotRequest.safeParse(body)
      return input.success ? ok({ ok: true, id: n.jot(input.data.text).id }) : failure('notebook_invalid')
    }),
    'POST /v1/notebook/chat/read': handle('chat', (n, _query, body) => {
      const input = NotebookChatReadRequest.safeParse(body)
      return input.success ? ok(n.read(input.data.days, input.data.query, input.data.after)) : failure('notebook_invalid')
    }),
  }
}
