/**
 * internal-api reminder routes (spec 2026-08-20-reminders-port-design §2.3,
 * ported from the June feat/reminders branch). Delivered by the reminder
 * sweeper (src/daemon/reminders), persisted in the daemon db.
 *
 * Scope rule (user ruling 2026-08-20): session-origin callers — ANY tier —
 * may only touch their own chat ("提醒我" semantics). The June version let
 * any session schedule timed messages to arbitrary chat_ids, which under the
 * guest path is a harassment/impersonation primitive. File/operator tokens
 * (the CLI) are unrestricted. The 403 never echoes the requested chat_id.
 */
import { makeRemindersStore, MAX_PENDING_PER_CHAT } from '../reminders/store'
import type { InternalApiDeps, RouteHandler, RouteTable } from './types'
import { errMsg } from './types'
import type { ReminderScheduleRequestT, ReminderCancelRequestT } from './schema'

type Caller = Parameters<RouteHandler>[2]

function scopeDenied(chatId: string, caller: Caller): boolean {
  if (caller?.origin !== 'session') return false
  return !caller.chatId || caller.chatId !== chatId
}
const DENIED = { status: 403, body: { error: 'reminder_scope_denied' } }

export function remindersRoutes(deps: InternalApiDeps): RouteTable {
  return {
    'POST /v1/reminders/schedule': async (_q, body, caller) => {
      if (!deps.db) return { status: 503, body: { error: 'db_not_wired' } }
      const { chat_id, text, due_at, delay_seconds } = body as ReminderScheduleRequestT
      if (scopeDenied(chat_id, caller)) return DENIED
      try {
        const store = makeRemindersStore(deps.db)
        // Per-chat pending cap (review issue 1a) — closes the schedule-time
        // half of the volume-cap fix; the sweeper's per-sweep send budget
        // (sweeper.ts) closes the delivery-time half.
        const pending = await store.countPending(chat_id)
        if (pending >= MAX_PENDING_PER_CHAT) {
          return { status: 200, body: { ok: false, error: 'too_many_pending' } }
        }
        const dueIso = due_at !== undefined
          ? new Date(due_at).toISOString()
          : new Date(Date.now() + delay_seconds! * 1000).toISOString()
        const id = await store.schedule({ chat_id, due_at: dueIso, text })
        deps.log?.('REMINDERS', `scheduled ${id} → ${chat_id} at ${dueIso}`)
        return { status: 200, body: { ok: true, reminder_id: id, due_at: dueIso } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },
    'POST /v1/reminders/cancel': async (_q, body, caller) => {
      if (!deps.db) return { status: 503, body: { error: 'db_not_wired' } }
      const { chat_id, reminder_id } = body as ReminderCancelRequestT
      if (scopeDenied(chat_id, caller)) return DENIED
      try {
        const store = makeRemindersStore(deps.db)
        const cancelled = await store.cancel(reminder_id, chat_id)
        return { status: 200, body: { ok: true, cancelled } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },
    'GET /v1/reminders/list': async (q, _body, caller) => {
      if (!deps.db) return { status: 503, body: { error: 'db_not_wired' } }
      const chatId = q.get('chat_id')
      if (!chatId) return { status: 400, body: { ok: false, error: 'chat_id required' } }
      if (scopeDenied(chatId, caller)) return DENIED
      try {
        const store = makeRemindersStore(deps.db)
        const reminders = (await store.list(chatId)).map(r => ({
          id: r.id, due_at: r.due_at, text: r.text, status: r.status,
        }))
        return { status: 200, body: { ok: true, reminders } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },
  }
}
