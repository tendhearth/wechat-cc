/**
 * 定时任务的每分钟一拍(spec 2026-10-20-scheduled-jobs-design)。一次只跑一个,按编号顺序;
 * 跳过的不补跑、失败的不重试;主人正在对话(skipped:busy)⇒ 不记当天,到点后 10 分钟窗口里下一拍再看。
 * 连续 3 次失败 ⇒ 暂停 + 告诉主人一次。
 */
import type { Lifecycle } from '../../lib/lifecycle'
import { isJobDue, type ScheduledJob } from '../../core/scheduled-jobs'
import { localParts } from '../memory/nightly-schedule'
import { JOBS_DAILY_CAP, type JobsStore } from '../../core/scheduled-jobs-store'

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
}

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
        if (!isJobDue(job.schedule, local, deps.store.state(job.id).lastRunDay)) continue
        const nowIso = new Date(nowMs).toISOString()
        if (deps.store.ranToday(local.day) >= JOBS_DAILY_CAP) {
          deps.store.record(job.id, local.day, nowIso, 'skipped:cap', false)
          deps.log('JOBS', `job ${job.id} skipped: daily cap ${JOBS_DAILY_CAP} reached`)
          continue
        }
        let release: (() => void) | undefined
        try { release = deps.holdBusy('scheduled-job') } catch { release = undefined }
        let status: string
        try { status = await withTimeout(deps.runTurn(job, nowIso), JOB_TURN_TIMEOUT_MS) }
        finally { try { release?.() } catch { /* release 永不抛 */ } }
        if (status === 'skipped:busy') { deps.log('JOBS', `job ${job.id} waiting: owner is mid-conversation`); continue }
        const failed = status.startsWith('failed:')
        const st = deps.store.record(job.id, local.day, nowIso, status, failed)
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
