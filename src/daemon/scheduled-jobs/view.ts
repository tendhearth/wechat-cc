/**
 * 手机上的定时列表(对标 B7:ChatGPT Tasks / Gemini 的定时列表):GET /m/api/jobs 读、POST /m/api/jobs/action 停 / 开 / 删。
 * 只给配过对的设备(链接令牌不行:定时的正文是主人的私事,停删也不该被一个泄露的 10 分钟链接做掉)。
 */
import { describeSchedule } from '../../core/scheduled-jobs'
import type { JobsStore } from '../../core/scheduled-jobs-store'
import { statusWord } from './command'

export interface PhoneJob {
  id: string
  /** 「每周一 09:00(上海)」 */
  label: string
  text: string
  brief: boolean
  /** 周报(CC 这一周做过的事)。 */
  recap?: boolean
  paused: boolean
  last: { day: string; status: string; label: string } | null
}
export type JobsView =
  | { ok: true; timezone: string; executor: string | null; jobs: PhoneJob[] }
  | { ok: false; error: 'jobs_unreadable' }

export function jobsView(o: { store: JobsStore; timezone: string; executor: string | null }): JobsView {
  const { jobs, error } = o.store.list()
  if (error) return { ok: false, error: 'jobs_unreadable' }
  return {
    ok: true, timezone: o.timezone, executor: o.executor,
    jobs: jobs.map(j => {
      const st = o.store.state(j.id)
      return {
        id: j.id, label: describeSchedule(j.schedule, o.timezone), text: j.text, brief: !!j.brief, recap: !!j.recap, paused: j.paused,
        last: st.lastRunDay && st.lastStatus ? { day: st.lastRunDay, status: st.lastStatus, label: statusWord(st.lastStatus) } : null,
      }
    }),
  }
}

export type JobsActionKind = 'pause' | 'resume' | 'remove'
export function jobsAction(store: JobsStore, id: string, action: JobsActionKind): { ok: true } | { ok: false; error: 'not_found' } {
  if (!store.list().jobs.some(j => j.id === id)) return { ok: false, error: 'not_found' }
  const done = action === 'remove' ? store.remove(id) : store.setPaused(id, action === 'pause')
  return done ? { ok: true } : { ok: false, error: 'not_found' }
}
