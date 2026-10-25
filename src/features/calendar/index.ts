/**
 * 读日历和提醒(只读,spec 2026-10-20-calendar-read-design)—— 第一个按「一个功能一个目录」放好的功能(架构终态 A4,样板)。
 *
 * 这一个目录就是它的全部:
 *  - `calendar.ts`:读 macOS 日历 / 提醒(JXA + EventKit,`core/calendar/eventkit.ts` 是纯解析)、开关、微信「日历」命令;
 *  - `routes.ts`:它的路由(`GET /v1/calendar/agenda`,CC 的 calendar_agenda 工具用),路由表里标了 `module: 'calendar'`;
 *  - 这个文件:模块清单 —— 要什么(needs)、给什么(provides:日历本身 + 命令)、挂哪些路由。
 * 默认关;「日历 开」才请求授权(Mac 上弹框)。只进主人的轮次:早报素材 + 「日历」命令 + admin 档的工具;不给访客 / trusted / 定时会话 / 社交。
 *
 * 删掉这个功能 = 删掉这个目录 + daemon-modules.ts 里那一行 + 路由表里那一行(typecheck 会指出用到它的地方:早报、命令表)。
 */
import { log } from '../../lib/log'
import type { DaemonModule } from '../../daemon/modules/container'
import type { InternalApiLifecycle } from '../../daemon/internal-api/lifecycle'
import type { ReplyHandler } from '../../daemon/commands/registry'
import type { IlinkAdapter } from '../../daemon/ilink-glue'
import { loadCompanionConfig } from '../../daemon/companion/config'
import { defaultRunner } from '../../daemon/cli-reply-handler'
import { appBundleHasCalendarUsage, makeCalendar, makeCalendarCommand, type Calendar } from './calendar'
import { calendarRoutes } from './routes'

export type { Calendar } from './calendar'

export interface CalendarFeature {
  calendar: Calendar
  /** 微信「日历 …」(进命令表,位置由命令表的顺序定)。 */
  command: ReplyHandler
}

export function calendarFeature(d: {
  stateDir: string
  isOwner: (chatId: string) => boolean
}): DaemonModule<CalendarFeature> {
  return {
    name: 'calendar',
    needs: ['internal-api', 'ilink-adapter'],
    init(ctx): CalendarFeature {
      const ilink = ctx.get<Pick<IlinkAdapter, 'sendMessage'>>('ilink-adapter')
      const calendar = makeCalendar({
        stateDir: d.stateDir, run: defaultRunner, platform: process.platform,
        bundleHasUsage: () => appBundleHasCalendarUsage(process.execPath),
        now: () => Date.now(), timezone: () => loadCompanionConfig(d.stateDir).timezone ?? 'Asia/Shanghai',
        log: (t, l) => log(t, l),
      })
      ctx.get<InternalApiLifecycle>('internal-api').mount('calendar', calendarRoutes(calendar))
      return { calendar, command: makeCalendarCommand({ calendar, isOwner: d.isOwner, say: (c, t) => ilink.sendMessage(c, t) }) }
    },
  }
}
