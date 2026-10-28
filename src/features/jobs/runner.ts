/**
 * 定时任务的每分钟一拍(spec 2026-10-20-scheduled-jobs-design)。一次只跑一个,按编号顺序;
 * 跳过的不补跑、失败的不重试;主人正在对话(skipped:busy)⇒ 不记当天,到点后 10 分钟窗口里下一拍再看。
 * 连续 3 次失败 ⇒ 暂停 + 告诉主人一次。
 */
import type { Lifecycle } from '../../lib/lifecycle'
import { isJobDue, windowPassed, JOB_DUE_WINDOW_MIN, type ScheduledJob } from '../../domain/scheduled-jobs'
import { localParts } from '../../lib/local-time'
import { JOBS_DAILY_CAP, type JobsStore } from '../../adapters/store/scheduled-jobs-store'

export const JOB_TURN_TIMEOUT_MS = 5 * 60_000
export const JOB_FAIL_PAUSE = 3
const DEFAULT_INTERVAL_MS = 60_000

export interface ScheduledJobsDeps {
  store: JobsStore
  timezone: () => string
  now: () => number
  /** = tickBodies.runJobTurn:'sent' | 'silent' | 'skipped:*' | 'failed:*'。 */
  runTurn: (job: ScheduledJob, nowIso: string) => Promise<string>
  notifyOwner: (text: string) => void
  holdBusy: (label: string) => () => void
  log: (tag: string, line: string) => void
  intervalMs?: number
  /** 「CC 做过的事」补记(B9):每次记完结果写一行(只有状态码 + 定时编号,失败原因不进)。 */
  activityLog?: { append(e: { kind: 'job'; status: string; ref?: string }): void }
}

/** 进时间线的状态码:failed:<原因> 只留 failed(原因可能带供应商原话)。 */
const activityStatus = (s: string) => s.startsWith('failed:') ? 'failed' : s

function withTimeout(p: Promise<string>, ms: number): Promise<string> {
  return new Promise(resolve => {
    const t = setTimeout(() => resolve('failed:timeout'), ms)
    p.then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); resolve(`failed:${e instanceof Error ? e.message.slice(0, 60) : 'error'}`) })
  })
}

export function registerScheduledJobs(deps: ScheduledJobsDeps): Lifecycle & { tickOnce(): Promise<void> } {
  let stopped = false
  let running = false
  let timer: ReturnType<typeof setTimeout> | null = null
  /** 今天被「主人正在对话」挡过的定时(只在内存里;窗口过了据此记 skipped:busy,否则记 skipped:missed)。 */
  const busyOn = new Map<string, string>()

  async function tickOnce(): Promise<void> {
    if (running) return
    running = true
    try {
      const { jobs, error } = deps.store.list()
      if (error) { deps.log('JOBS', `jobs file unreadable: ${error}`); return }
      for (const job of jobs) {
        if (stopped) return
        if (job.paused) continue
        const nowMs = deps.now()
        const local = localParts(nowMs, deps.timezone())
        const lastRunDay = deps.store.state(job.id).lastRunDay
        if (windowPassed(job.schedule, local, lastRunDay)) {
          // 窗口过了还没跑:记一笔这一天为什么没跑(终审 I4)。今天窗口之后才建的不算错过。
          const dueMs = nowMs - (Number(local.hhmm.slice(0, 2)) * 60 + Number(local.hhmm.slice(3)) - (Number(job.schedule.at.slice(0, 2)) * 60 + Number(job.schedule.at.slice(3)))) * 60_000
          if (Date.parse(job.createdAt) <= dueMs + JOB_DUE_WINDOW_MIN * 60_000) {
            const skipped = busyOn.get(job.id) === local.day ? 'skipped:busy' : 'skipped:missed'
            deps.store.record(job.id, local.day, new Date(nowMs).toISOString(), skipped, false)
            try { deps.activityLog?.append({ kind: 'job', status: skipped, ref: job.id }) } catch { /* 记不上不影响定时 */ }
          }
          continue
        }
        if (!isJobDue(job.schedule, local, lastRunDay)) continue
        const nowIso = new Date(nowMs).toISOString()
        if (deps.store.ranToday(local.day) >= JOBS_DAILY_CAP) {
          deps.store.record(job.id, local.day, nowIso, 'skipped:cap', false)
          try { deps.activityLog?.append({ kind: 'job', status: 'skipped:cap', ref: job.id }) } catch { /* 记不上不影响定时 */ }
          deps.log('JOBS', `job ${job.id} skipped: daily cap ${JOBS_DAILY_CAP} reached`)
          continue
        }
        let release: (() => void) | undefined
        try { release = deps.holdBusy('scheduled-job') } catch { release = undefined }
        let status: string
        try { status = await withTimeout(deps.runTurn(job, nowIso), JOB_TURN_TIMEOUT_MS) }
        finally { try { release?.() } catch { /* release 永不抛 */ } }
        if (status === 'skipped:busy') { busyOn.set(job.id, local.day); deps.log('JOBS', `job ${job.id} waiting: owner is mid-conversation`); continue }
        const failed = status.startsWith('failed:')
        const st = deps.store.record(job.id, local.day, nowIso, status, failed)
        try { deps.activityLog?.append({ kind: 'job', status: activityStatus(status), ref: job.id }) } catch { /* 记不上不影响定时 */ }
        if (failed && st.failStreak >= JOB_FAIL_PAUSE) {
          deps.store.setPaused(job.id, true)
          const head = [...job.text].slice(0, 20).join('')
          try { deps.notifyOwner(`定时 ${job.id}「${head}」连着 ${JOB_FAIL_PAUSE} 次没跑成(${status.slice(7)}),先停了。发「定时 开 ${job.id}」再开。`) }
          catch (e) { deps.log('JOBS', `notify failed: ${e instanceof Error ? e.message : String(e)}`) }
        }
      }
    } finally {
      running = false
    }
  }

  function scheduleNext(): void {
    if (stopped) return
    timer = setTimeout(async () => {
      timer = null
      if (stopped) return
      try { await tickOnce() } catch (e) { deps.log('JOBS', `tick failed: ${e instanceof Error ? e.message : String(e)}`) }
      scheduleNext()
    }, deps.intervalMs ?? DEFAULT_INTERVAL_MS)
    ;(timer as { unref?: () => void }).unref?.()
  }
  scheduleNext()

  return {
    name: 'scheduled-jobs',
    tickOnce,
    stop: async () => {
      if (stopped) return
      stopped = true
      if (timer) { clearTimeout(timer); timer = null }
    },
  }
}
