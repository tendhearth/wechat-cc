/**
 * 定时 / 早报 / 周报 / 换一家来审接进 daemon 的那一份(模块清单在 index.ts):必需的 `jobs` + 每分钟一拍的 `scheduled-jobs`。
 * 只有 daemon-modules.ts import 这个文件。
 */
import { log } from '../../lib/log'
import type { DaemonModule } from '../../daemon/modules/container'
import type { Foundation } from '../../daemon/foundation'
import type { Bootstrap } from '../../daemon/bootstrap'
import type { WiredDeps } from '../../daemon/wiring'
import type { Activity } from '../../daemon/bootstrap/wire-activity'
import { ownerChatIdOf } from '../../daemon/owner-chat'
import { WECHAT_PORTS as W, type WechatSend } from '../../ports/wechat'
import type { CalendarFeature } from '../calendar'
import type { TerminalFeature } from '../terminal'
import { jobsFeature, jobsRunnerFeature, type JobsFeature } from './index'

export function jobsModule(f: Foundation): DaemonModule<JobsFeature> {
  const { stateDir, db } = f
  return jobsFeature({
    needs: ['bootstrap', 'terminal', 'calendar', 'activity', W.send],
    lazy: ['wired'],
    deps: (ctx) => {
      const wired = ctx.late<WiredDeps>('wired')
      const activity = ctx.get<Activity>('activity')
      return {
        stateDir, db, ilink: ctx.get<WechatSend>(W.send), boot: ctx.get<Bootstrap>('bootstrap'), jobsStore: f.jobsStore,
        activityLog: activity.activityLog, activity: activity.activity, calendar: ctx.get<CalendarFeature>('calendar').calendar,
        overseerToday: ctx.get<TerminalFeature>('terminal').overseerToday, careLedger: f.careLedger,
        quietWindow: () => { const o = ownerChatIdOf(stateDir); return o ? f.chatPrefs.get(o).quiet : undefined },
        // async:没就绪时是一个被拒的 promise,不是同步抛 —— requestReview 的 .catch 接得住,照实告诉主人「没审成」
        runJobTurn: async (a) => { const w = wired(); if (!w) throw new Error('jobs_not_wired'); return w.ticks.runJobTurn(a) },
        // 定时那边的一句(连续失败被暂停 …)经 CC 开口那道门(第三批 3a,job_notice 归 report)
        sendProactive: (chatId, text, kind = 'job_notice') => {
          const w = wired()
          if (!w) { log('JOBS', `proactive send dropped (not wired yet) chat=${chatId}`); return }
          void w.speech.tell(kind, chatId, text)
        },
      }
    },
  })
}

/** 定时任务每分钟一拍:坏了只降级。 */
export function scheduledJobsModule(): DaemonModule {
  return jobsRunnerFeature({ needs: ['wired'] })
}
