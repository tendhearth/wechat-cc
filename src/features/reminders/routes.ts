/**
 * 提醒的路由(spec 2026-08-20-reminders-port-design §2.3,ported from the June feat/reminders branch).
 * Delivered by the reminder sweeper (./sweeper.ts), persisted in the daemon db. 由 reminders 模块自己挂
 * (internalApi.mount;路由表标了 module: 'reminders')。
 *
 * Scope rule (user ruling 2026-08-20): session-origin callers — ANY tier —
 * may only touch their own chat ("提醒我" semantics). The June version let
 * any session schedule timed messages to arbitrary chat_ids, which under the
 * guest path is a harassment/impersonation primitive. File/operator tokens
 * (the CLI) are unrestricted. The 403 never echoes the requested chat_id.
 */
import { makeRemindersStore, MAX_PENDING_PER_CHAT } from './store'
import type { Db } from '../../lib/db'
import type { RouteHandler, RouteTable } from '../../daemon/internal-api/types'
import { errMsg } from '../../daemon/internal-api/types'
import type { ReminderScheduleRequestT, ReminderCancelRequestT } from '../../daemon/internal-api/schema'

type Caller = Parameters<RouteHandler>[2]

function scopeDenied(chatId: string, caller: Caller): boolean {
  if (caller?.origin !== 'session') return false
  return !caller.chatId || caller.chatId !== chatId
}
const DENIED = { status: 403, body: { error: 'reminder_scope_denied' } }

export function remindersRoutes(deps: { db: Db; log?: (tag: string, line: string) => void }): RouteTable {
  return {
    'POST /v1/reminders/schedule': async (_q, body, caller) => {
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
