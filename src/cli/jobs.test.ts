import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cliAddJob, cliFormatJobs } from './jobs'
import { makeJobsStore } from '../core/scheduled-jobs-store'

describe('wechat-cc jobs', () => {
  it('add maps --every / --at / --text to a schedule', () => {
    const d = mkdtempSync(join(tmpdir(), 'jobs-cli-'))
    expect(cliAddJob(d, { every: 'mon', at: '9:00', text: '看 issue' }, new Date())).toMatchObject({ ok: true, job: { id: 'j1', schedule: { kind: 'weekly', weekday: 1, at: '09:00' } } })
    expect(cliAddJob(d, { every: 'daily', at: '08:30', text: 'x' }, new Date())).toMatchObject({ ok: true, job: { schedule: { kind: 'daily' } } })
    expect(cliAddJob(d, { every: 'weekdays', at: '18:00', text: 'x' }, new Date())).toMatchObject({ ok: true, job: { schedule: { kind: 'weekdays' } } })
    expect(cliAddJob(d, { every: 'hourly', at: '18:00', text: 'x' }, new Date())).toMatchObject({ ok: false })
    expect(cliAddJob(d, { every: 'daily', at: '25:00', text: 'x' }, new Date())).toMatchObject({ ok: false })
    expect(cliAddJob(d, { every: 'daily', at: '09:00', text: '' }, new Date())).toMatchObject({ ok: false })
    expect(makeJobsStore(d).list().jobs).toHaveLength(3)
  })
  it('list text', () => {
    const d = mkdtempSync(join(tmpdir(), 'jobs-cli-'))
    expect(cliFormatJobs(d)).toContain('还没有定时')
    cliAddJob(d, { every: 'sun', at: '21:00', text: '回顾这周' }, new Date())
    expect(cliFormatJobs(d)).toContain('j1 · 每周日 21:00 · 回顾这周')
  })
})
