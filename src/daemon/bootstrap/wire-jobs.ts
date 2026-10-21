/**
 * 定时 / 早报 / 周报 / 换一家来审(重构第二批步 6c 第二块,从 main.ts 搬出来)。
 *
 * 两段:建的时候就给出微信「定时」命令(要进命令表,在 wireMain 之前);每分钟一拍的 runner 与只读轮
 * 要 wireMain 之后才有 ⇒ 由 main 在合适的时候 `await start()`(规矩:wireX 里不 await 还没就绪的东西)。
 * 只读轮(`runJobTurn`)与主动消息出口(`sendProactive`)是 main 给的闭包,调用时才取。
 */
import { existsSync as fsExistsSync, readFileSync as fsReadFileSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../../lib/log'
import { loadAccess } from '../../lib/access'
import type { Db } from '../../lib/db'
import type { LifecycleSet } from '../../lib/lifecycle'
import type { SubsystemSupervisor } from '../subsystems'
import { resolveAdminChatId, type Bootstrap } from './index'
import { loadCompanionConfig } from '../companion/config'
import type { IlinkAdapter } from '../ilink-glue'
import type { CareLedger } from '../companion/care-ledger'
import type { makeJobsStore } from '../../core/scheduled-jobs-store'
import type { makeActivityLog } from '../activity-log'
import type { makeCalendar } from '../calendar/calendar'
import { formatOverseerToday, type OverseerToday } from '../../core/overseer-today'
import { buildActivity, type ActivityItem, type ActivitySources } from '../../core/cc-activity'
import { buildReviewText, reviewMissNote } from '../../core/workbench/review-request'
import { makeWorkbenchStore } from '../../core/workbench/store'
import { makeBriefPrefs, makeBriefTurn } from '../scheduled-jobs/brief'
import { makeRecapTurn } from '../scheduled-jobs/recap'
import { registerScheduledJobs } from '../scheduled-jobs/runner'
import { makeJobsCommand } from '../scheduled-jobs/command'
import { parseAgenda, selectDue } from '../companion/agenda'
import { localParts } from '../memory/nightly-schedule'
import { makeRemindersStore } from '../reminders/store'
import { pickJobExecutor, type TickBodies } from '../wiring/tick-bodies'

type RunJobTurn = TickBodies['runJobTurn']

export interface ReviewRequest { taskId: string; providerId: string; material: string }

export interface WireJobsDeps {
  stateDir: string
  db: Db
  ilink: IlinkAdapter
  boot: Bootstrap
  sup: SubsystemSupervisor
  lc: LifecycleSet
  jobsStore: ReturnType<typeof makeJobsStore>
  activityLog: ReturnType<typeof makeActivityLog>
  /** 「做过的事」的来源(与手机时间线同一组)。 */
  activity: { sources(): ActivitySources }
  calendar: ReturnType<typeof makeCalendar>
  overseerToday(): OverseerToday
  careLedger: CareLedger
  /** 定时那条只读轮(wireMain 之后才有;没就绪 ⇒ 抛)。 */
  runJobTurn: RunJobTurn
  /** 伙伴主动消息的出口(只送一次;没就绪 ⇒ 不送)。 */
  sendProactive(chatId: string, text: string): void
}

export function wireJobs(d: WireJobsDeps) {
  const { stateDir, db, ilink, boot, jobsStore, activityLog, activity, calendar, overseerToday, careLedger } = d
  // 早报的口味(对标 #7):memory/<主人>/brief-prefs.md,「早报 少点 / 多点 …」写它。
  const briefOwner = () => resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null)
  const briefPrefs = makeBriefPrefs(() => { const o = briefOwner(); return o ? join(stateDir, 'memory', o) : null })
  const jobsCommand = makeJobsCommand({
    store: jobsStore,
    isOwner: (chatId) => resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null) === chatId,
    say: (c, t) => ilink.sendMessage(c, t),
    timezone: () => loadCompanionConfig(stateDir).timezone ?? 'Asia/Shanghai',
    now: () => Date.now(),
    log: (t, l) => log(t, l),
    jobExecutor: () => pickJobExecutor(id => boot.registry.has(id as never)),
    briefPrefs,
  })
  // 主人亲手写的定时任务(spec 2026-10-20-scheduled-jobs-design):每分钟一拍,到点在只读的独立会话里跑一轮,
  // 走伙伴主动消息的出口;只给主人那条对话。坏了只降级,不挡启动。
  // 早报(spec 2026-10-20-morning-brief-design):素材在本机拼好 —— 日报原文、今天到期的提醒、agenda、口味;
  // 发出去了就记一次主动消息(careLedger.claim),当天的问候按它冷却,取代而不是叠加。
  const briefTz = () => loadCompanionConfig(stateDir).timezone ?? 'Asia/Shanghai'
  // 换一家来审(10-20):另一家用定时那条只读轮(job:review-<任务>、JOB_PROFILE、strict)看改动,意见直接发给主人。后台跑,不挡微信回话。
  const requestReview = (r: ReviewRequest): boolean => {
    const owner = briefOwner()
    if (!owner || (r.providerId !== 'claude' && r.providerId !== 'codex')) return false
    void d.runJobTurn({ chatId: owner, jobId: `review-${r.taskId}`, text: '', nowIso: new Date().toISOString(), provider: r.providerId, profile: 'review', kind: 'review', scheduled: false, buildText: (style) => buildReviewText(r.material, style) })
      .then(res => {
        log('REVIEW', `task=${r.taskId} by=${r.providerId} → ${res}`)
        // 答应了「看完发给你」:没发成就老实说一句,不让主人干等(规矩:CC 不撒谎)
        const why = reviewMissNote(res)
        if (why) void ilink.sendMessage(owner, `${r.providerId} 没审成 ${r.taskId} 的改动:${why}`).catch(() => {})
      })
      .catch(err => {
        log('REVIEW', `task=${r.taskId} by=${r.providerId} threw: ${err instanceof Error ? err.message : String(err)}`)
        void ilink.sendMessage(owner, `${r.providerId} 没审成 ${r.taskId} 的改动,过一会儿再发一次「任务 ${r.taskId} 请 @${r.providerId} 审」。`).catch(() => {})
      })
    return true
  }
  const briefTurn = makeBriefTurn({
    runJobTurn: (a) => d.runJobTurn(a),
    ownerChatId: briefOwner,
    // 今天的日程和提醒事项:只在开着且授权时有;没授权 / 读失败 ⇒ 省略(不说成没安排)
    calendar: async () => { const a = await calendar.agenda(0); return a.ok && a.text ? a.text : null },
    today: () => {
      const t = overseerToday()
      const c = t.counts
      return c.needsYou + c.done + c.running + c.stuck === 0 ? null : formatOverseerToday(t)
    },
    reminders: async () => {
      const o = briefOwner()
      if (!o) return []
      const tz = briefTz(), today = localParts(Date.now(), tz).day
      return (await makeRemindersStore(db).list(o))
        .filter(r => r.status === 'pending' && localParts(Date.parse(r.due_at), tz).day === today)
        .map(r => ({ at: localParts(Date.parse(r.due_at), tz).hhmm, text: r.text }))
    },
    agenda: () => {
      const o = briefOwner()
      const f = o ? join(stateDir, 'memory', o, 'agenda.md') : null
      if (!f || !fsExistsSync(f)) return []
      return selectDue(parseAgenda(fsReadFileSync(f, 'utf8')), localParts(Date.now(), briefTz()).day).map(i => `${i.body}(期限 ${i.due})`)
    },
    prefs: () => briefPrefs.read(),
    claim: (c, iso) => { careLedger.claim(c, iso) },
  })
  // 周报(B9 之上):这一周「CC 做过的事」—— 与手机时间线同一组来源,翻几页收齐(最多 300 条)。
  const recapTurn = makeRecapTurn({
    runJobTurn: (a) => d.runJobTurn(a),
    // 这一周各执行者自己报的用量(v82):「这周额度花在哪了」
    usage: (since) => makeWorkbenchStore(db).usage.sinceByProvider(since),
    ownerChatId: briefOwner, now: () => Date.now(), timeZone: briefTz,
    activity: () => {
      const src = activity.sources(), now = Date.now(), out: ActivityItem[] = []
      let cursor: string | null = null
      for (let page = 0; page < 3; page++) {
        const r = buildActivity(src, { now, limit: 100, cursor })
        out.push(...r.items)
        if (!r.next) break
        cursor = r.next
      }
      return out
    },
  })

  return {
    /** 微信「定时 …」。 */
    command: jobsCommand,
    /** 「换一家来审」:交给另一家在只读轮里看改动;请不到 ⇒ false。 */
    requestReview,
    /** 每分钟一拍的 runner;坏了只降级,不挡启动。 */
    async start(): Promise<void> {
    const jobsLc = await d.sup.start('scheduled-jobs', () => registerScheduledJobs({
      store: jobsStore,
      activityLog,
      timezone: () => loadCompanionConfig(stateDir).timezone ?? 'Asia/Shanghai',
      now: () => Date.now(),
      runTurn: async (job, nowIso) => {
        if (job.brief) return briefTurn(job, nowIso)
        if (job.recap) return recapTurn(job, nowIso)
        const owner = resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null)
        if (!owner) return 'skipped:no_owner'
        return d.runJobTurn({ chatId: owner, jobId: job.id, text: job.text, nowIso, kind: 'job', scheduled: true })
      },
      notifyOwner: (text) => {
        const owner = resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null)
        if (owner) d.sendProactive(owner, text)
      },
      holdBusy: (l) => boot.holdBusy(l),
      log: (t, l) => log(t, l),
    }))
    if (jobsLc) d.lc.register(jobsLc)
    },
  }
}
