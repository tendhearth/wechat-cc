import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cliAddJob, cliFormatJobs } from './jobs'
import { makeJobsStore } from '../adapters/store/scheduled-jobs-store'

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

describe('jobs CLI 带时区', () => {
  it('list shows the owner timezone', () => {
    const d = mkdtempSync(join(tmpdir(), 'jobs-cli-tz-'))
    cliAddJob(d, { every: 'daily', at: '18:10', text: 'x' }, new Date())
    expect(cliFormatJobs(d, 'Asia/Shanghai')).toContain('每天 18:10(上海)')
  })
})

describe('ownerTimezone', () => {
  it('reads companion/config.json, falls back to the system zone', async () => {
    const { ownerTimezone } = await import('./jobs')
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const d = mkdtempSync(join(tmpdir(), 'jobs-tz-'))
    expect(ownerTimezone(d)).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    mkdirSync(join(d, 'companion'))
    writeFileSync(join(d, 'companion', 'config.json'), JSON.stringify({ timezone: 'Asia/Shanghai' }))
    expect(ownerTimezone(d)).toBe('Asia/Shanghai')
  })
})
