/**
 * 日历的路由(只读,对标 #8,spec 2026-10-20-calendar-read-design)—— CC 的 calendar_agenda 工具走这里。admin 档:
 * 日程是主人的私事;回的就是「日历」命令那段话(没开 / 没授权 / 读失败照实说,不说成没安排)。
 *   GET /v1/calendar/agenda?offset=0|1   —— 今天 / 明天
 * 由 calendar 模块自己挂上(internalApi.mount);模块没起来时路由层回 module_off / module_degraded / module_starting。
 */
import type { RouteTable } from '../../daemon/internal-api/types'
import { agendaReplyText, type Calendar } from './calendar'

export function calendarRoutes(calendar: Calendar): RouteTable {
  return {
    'GET /v1/calendar/agenda': async (q) => {
      const raw = q.get('offset') ?? '0'
      if (raw !== '0' && raw !== '1') return { status: 400, body: { error: 'invalid_offset' } }
      try { return { status: 200, body: { ok: true, text: await agendaReplyText(calendar, raw === '1' ? 1 : 0) } } }
      catch { return { status: 503, body: { error: 'unavailable' } } }
    },
  }
}
