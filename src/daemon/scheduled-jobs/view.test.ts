import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeJobsStore, JOBS_FILE } from '../../core/scheduled-jobs-store'
import { jobsView, jobsAction } from './view'

const dir = () => mkdtempSync(join(tmpdir(), 'jobs-view-'))

describe('手机上的定时列表(B7)', () => {
  it('lists jobs with a tz-labelled schedule, brief flag, paused and last result', () => {
    const store = makeJobsStore(dir())
    store.add({ kind: 'weekly', at: '09:00', weekday: 1 }, '看 issue', new Date())
    store.add({ kind: 'daily', at: '08:00' }, '早报', new Date(), { brief: true })
    store.record('j1', '2026-10-20', '2026-10-20T01:00:00Z', 'silent', false)
    store.setPaused('j2', true)
    const v = jobsView({ store, timezone: 'Asia/Shanghai', executor: 'claude' })
    expect(v).toMatchObject({ ok: true, timezone: 'Asia/Shanghai', executor: 'claude' })
    if (!v.ok) throw new Error('x')
    expect(v.jobs).toEqual([
      { id: 'j1', label: '每周一 09:00(上海)', text: '看 issue', brief: false, paused: false, last: { day: '2026-10-20', status: 'silent', label: '没说话(没新东西)' } },
      { id: 'j2', label: '每天 08:00(上海)', text: '早报', brief: true, paused: true, last: null },
    ])
  })
  it('a broken jobs file is an error, not an empty list', () => {
    const d = dir()
    writeFileSync(join(d, JOBS_FILE), '{oops')
    expect(jobsView({ store: makeJobsStore(d), timezone: 'UTC', executor: null })).toMatchObject({ ok: false, error: 'jobs_unreadable' })
  })
  it('actions: pause / resume / remove; unknown id ⇒ not_found', () => {
    const store = makeJobsStore(dir())
    store.add({ kind: 'daily', at: '09:00' }, 'x', new Date())
    expect(jobsAction(store, 'j1', 'pause')).toEqual({ ok: true })
    expect(store.list().jobs[0]!.paused).toBe(true)
    expect(jobsAction(store, 'j1', 'resume')).toEqual({ ok: true })
    expect(jobsAction(store, 'j9', 'remove')).toEqual({ ok: false, error: 'not_found' })
    expect(jobsAction(store, 'j1', 'remove')).toEqual({ ok: true })
    expect(store.list().jobs).toEqual([])
  })
})
