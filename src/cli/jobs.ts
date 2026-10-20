/**
 * `wechat-cc jobs`:直接改状态目录里的 scheduled-jobs.json(同微信「定时」写的那一份),不经 daemon;
 * 每分钟一拍的 runner 下一拍就读到。写法与微信一致,只是用参数表达。
 */
import { describeSchedule, JOB_TEXT_MAX, type JobSchedule, type ScheduledJob, type Weekday } from '../core/scheduled-jobs'
import { makeJobsStore } from '../core/scheduled-jobs-store'
import { join } from 'node:path'
import { readJsonFile } from '../lib/read-json-file'

const DAYS: Record<string, Weekday> = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 }

export function cliAddJob(stateDir: string, a: { every: string; at: string; text: string }, now: Date): { ok: true; job: ScheduledJob } | { ok: false; error: string } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(a.at.trim())
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return { ok: false, error: '--at 要写成 HH:MM,比如 09:00' }
  const at = `${m[1]!.padStart(2, '0')}:${m[2]}`
  const every = a.every.trim().toLowerCase()
  const schedule: JobSchedule | null = every === 'daily' ? { kind: 'daily', at } : every === 'weekdays' ? { kind: 'weekdays', at } : DAYS[every] ? { kind: 'weekly', at, weekday: DAYS[every]! } : null
  if (!schedule) return { ok: false, error: '--every 只能是 daily / weekdays / mon…sun' }
  const text = a.text.trim()
  if (!text) return { ok: false, error: '--text 不能空' }
  if ([...text].length > JOB_TEXT_MAX) return { ok: false, error: `--text 超过 ${JOB_TEXT_MAX} 字` }
  return makeJobsStore(stateDir).add(schedule, text, now)
}

export function cliFormatJobs(stateDir: string, tz?: string): string {
  const store = makeJobsStore(stateDir)
  const { jobs, error } = store.list()
  if (error) return `定时文件读不了:${error}`
  if (!jobs.length) return '还没有定时。加一个:wechat-cc jobs add --every mon --at 09:00 --text "看一下 issue"'
  return jobs.map(j => {
    const st = store.state(j.id)
    return `${j.id} · ${describeSchedule(j.schedule, tz)}${j.paused ? ' · 停着' : ''} · ${j.text}${st.lastStatus ? ` · 上次 ${st.lastRunDay} ${st.lastStatus}` : ''}`
  }).join('\n')
}

/** 主人时区:状态目录 companion/config.json 的 timezone(daemon 判到点用的同一个);读不到 ⇒ 本机时区。 */
export function ownerTimezone(stateDir: string): string {
  try {
    const tz = readJsonFile<{ timezone?: unknown }>(join(stateDir, 'companion', 'config.json')).timezone
    if (typeof tz === 'string' && tz) return tz
  } catch { /* 没有 / 坏了 ⇒ 本机 */ }
  return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'
}
