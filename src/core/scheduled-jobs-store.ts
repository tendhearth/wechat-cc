/**
 * 定时任务的两个文件(spec 2026-10-20-scheduled-jobs-design):
 *   scheduled-jobs.json        主人写的定时(主人 / CLI / 微信都改它)
 *   scheduled-jobs-state.json  每个定时上次跑的结果(只有 runner 写)
 * 原子写;定时文件坏了 ⇒ 当没有定时并报错,任何写入都拒(不把主人手改了一半的东西冲掉)。
 */
import { existsSync, renameSync, writeFileSync } from 'node:fs'
import { readJsonFile } from '../lib/read-json-file'
import { join } from 'node:path'
import type { JobSchedule, ScheduledJob } from './scheduled-jobs'

export const JOBS_FILE = 'scheduled-jobs.json'
export const JOBS_STATE_FILE = 'scheduled-jobs-state.json'
/** 全部定时合计每天最多跑几次(spec)。 */
export const JOBS_DAILY_CAP = 5
/** 最多存几个定时(同 Gemini Scheduled Actions 的 10 个)。 */
export const JOBS_MAX = 10

export interface JobRunState { lastRunDay: string | null; lastRunAt: string | null; lastStatus: string | null; failStreak: number }
const EMPTY_STATE: JobRunState = { lastRunDay: null, lastRunAt: null, lastStatus: null, failStreak: 0 }

function atomicWrite(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}

export function makeJobsStore(stateDir: string) {
  const jobsPath = join(stateDir, JOBS_FILE)
  const statePath = join(stateDir, JOBS_STATE_FILE)

  function readJobs(): { jobs: ScheduledJob[]; error: string | null } {
    if (!existsSync(jobsPath)) return { jobs: [], error: null }
    try {
      const v = readJsonFile<{ jobs?: unknown }>(jobsPath)
      if (!v || !Array.isArray(v.jobs)) return { jobs: [], error: `${JOBS_FILE} 的形状不对` }
      return { jobs: v.jobs as ScheduledJob[], error: null }
    } catch (e) {
      return { jobs: [], error: `${JOBS_FILE} 读不了:${e instanceof Error ? e.message : String(e)}` }
    }
  }
  function writeJobs(jobs: ScheduledJob[]): void { atomicWrite(jobsPath, { version: 1, jobs }) }

  function readState(): Record<string, JobRunState> {
    try {
      const v = readJsonFile<{ jobs?: Record<string, JobRunState> }>(statePath)
      return v && v.jobs && typeof v.jobs === 'object' ? v.jobs : {}
    } catch { return {} }
  }

  /** 改定时文件:坏文件 ⇒ null(不写)。 */
  function edit<T>(fn: (jobs: ScheduledJob[]) => { jobs: ScheduledJob[]; result: T } | null): T | null {
    const r = readJobs()
    if (r.error) return null
    const next = fn(r.jobs)
    if (!next) return null
    writeJobs(next.jobs)
    return next.result
  }

  return {
    list: readJobs,
    add(schedule: JobSchedule, text: string, now: Date): { ok: true; job: ScheduledJob } | { ok: false; error: string } {
      const r = readJobs()
      if (r.error) return { ok: false, error: `${r.error};先把它修好再加。` }
      if (r.jobs.length >= JOBS_MAX) return { ok: false, error: `定时最多 ${JOBS_MAX} 个,先删掉一个再加。` }
      const max = Math.max(0, ...r.jobs.map(j => Number(/^j(\d+)$/.exec(j.id)?.[1] ?? 0)), ...Object.keys(readState()).map(k => Number(/^j(\d+)$/.exec(k)?.[1] ?? 0)))
      const job: ScheduledJob = { id: `j${max + 1}`, schedule, text, createdAt: now.toISOString(), paused: false }
      writeJobs([...r.jobs, job])
      return { ok: true, job }
    },
    setPaused(id: string, paused: boolean): boolean {
      return edit(jobs => jobs.some(j => j.id === id) ? { jobs: jobs.map(j => (j.id === id ? { ...j, paused } : j)), result: true } : null) ?? false
    },
    remove(id: string): boolean {
      return edit(jobs => jobs.some(j => j.id === id) ? { jobs: jobs.filter(j => j.id !== id), result: true } : null) ?? false
    },
    state(id: string): JobRunState {
      return { ...EMPTY_STATE, ...readState()[id] }
    },
    record(id: string, day: string, at: string, status: string, failed: boolean): JobRunState {
      const all = readState()
      const prev = { ...EMPTY_STATE, ...all[id] }
      const next: JobRunState = { lastRunDay: day, lastRunAt: at, lastStatus: status, failStreak: failed ? prev.failStreak + 1 : 0 }
      atomicWrite(statePath, { version: 1, jobs: { ...all, [id]: next } })
      return next
    },
    /** 当天真跑了的个数(sent / silent / failed:*);跳过的不算进每日上限。 */
    ranToday(day: string): number {
      return Object.values(readState()).filter(s => s.lastRunDay === day && !!s.lastStatus && !s.lastStatus.startsWith('skipped')).length
    },
  }
}

export type JobsStore = ReturnType<typeof makeJobsStore>
