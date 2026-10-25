/**
 * 提醒(spec 2026-08-20-reminders-port-design)—— 一个功能一个目录(架构终态 A5)。
 *
 *  - `store.ts`:提醒表(v29+)的读写;`sweeper.ts`:到点送达(多用户、精确到分钟、指数退避、每拍限量);
 *  - `routes.ts`:`/v1/reminders/*`(CC 的提醒工具用;会话来的只能动自己的 chat),路由表标了 `module: 'reminders'`;
 *  - 这个文件:模块清单。
 *
 * 送达走 SpeechPolicy(requested:主人亲手定的时间,免打扰 / 别烦我照发);微信、App 都送不到 ⇒ 留着、不算失败。
 * 可选模块:起不来只降级,不挡开机(这时路由回 module_degraded,不让 CC 记下一条永远送不出去的提醒)。
 */
import { log } from '../../lib/log'
import type { Db } from '../../lib/db'
import type { Lifecycle } from '../../lib/lifecycle'
import type { DaemonModule } from '../../daemon/modules/container'
import type { InternalApiLifecycle } from '../../daemon/internal-api/lifecycle'
import type { SpeechPolicy } from '../../daemon/speech/policy'
import type { ActivityLog } from '../../daemon/activity-log'
import { makeRemindersStore } from './store'
import { registerReminders, sendReminderVia } from './sweeper'
import { remindersRoutes } from './routes'

export { makeRemindersStore } from './store'
export type { RemindersStore } from './store'

export function remindersFeature(d: {
  db: Db
  isOwner: (chatId: string) => boolean
  /** CC 开口那道门(wired 模块里造)。 */
  speech: (ctx: { get<T>(n: string): T }) => SpeechPolicy
  /** 「做过的事」的账(送达记一笔)。 */
  activityLog: (ctx: { get<T>(n: string): T }) => ActivityLog
  needs: readonly string[]
}): DaemonModule<void> {
  return {
    name: 'reminders',
    optional: true,
    needs: ['internal-api', ...d.needs],
    init(ctx) {
      ctx.get<InternalApiLifecycle>('internal-api').mount('reminders', remindersRoutes({ db: d.db, log: (t, l) => log(t, l) }))
      let lc: Lifecycle | null = null
      ctx.onStart('sweep', () => {
        lc = registerReminders({
          store: makeRemindersStore(d.db),
          send: sendReminderVia(d.speech(ctx), (t, l) => log(t, l)),
          log: (t, l) => log(t, l),
          activityLog: d.activityLog(ctx),
          isOwner: d.isOwner,
        })
      })
      ctx.own('stop', () => lc?.stop())
    },
  }
}
