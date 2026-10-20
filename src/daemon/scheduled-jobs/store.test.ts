import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeJobsStore, JOBS_FILE, JOBS_MAX } from './store'

const dir = () => mkdtempSync(join(tmpdir(), 'jobs-'))
const now = new Date('2026-10-20T01:00:00Z')
const daily = { kind: 'daily' as const, at: '09:00' }

describe('jobs store', () => {
  it('add / list / pause / resume / remove with increasing ids', () => {
    const s = makeJobsStore(dir())
    expect(s.add(daily, '看天气', now)).toMatchObject({ ok: true, job: { id: 'j1', text: '看天气', paused: false, createdAt: now.toISOString() } })
    expect(s.add(daily, '看 issue', now)).toMatchObject({ ok: true, job: { id: 'j2' } })
    expect(s.setPaused('j1', true)).toBe(true)
    expect(s.list().jobs.find(j => j.id === 'j1')!.paused).toBe(true)
    expect(s.setPaused('j9', true)).toBe(false)
    expect(s.remove('j1')).toBe(true)
    expect(s.remove('j1')).toBe(false)
    expect(s.add(daily, '再来一个', now)).toMatchObject({ ok: true, job: { id: 'j3' } })
    expect(s.list()).toMatchObject({ error: null })
  })
  it(`refuses more than ${JOBS_MAX}`, () => {
    const s = makeJobsStore(dir())
    for (let i = 0; i < JOBS_MAX; i++) expect(s.add(daily, `x${i}`, now).ok).toBe(true)
    expect(s.add(daily, 'one more', now)).toMatchObject({ ok: false })
  })
  it('a broken file is reported and never overwritten', () => {
    const d = dir()
    writeFileSync(join(d, JOBS_FILE), '{oops')
    const s = makeJobsStore(d)
    expect(s.list().jobs).toEqual([])
    expect(s.list().error).toBeTruthy()
    expect(s.add(daily, 'x', now).ok).toBe(false)
    expect(s.setPaused('j1', true)).toBe(false)
    expect(readFileSync(join(d, JOBS_FILE), 'utf8')).toBe('{oops')
  })
  it('run state: failStreak counts failures and resets on success; ranToday ignores skipped', () => {
    const s = makeJobsStore(dir())
    expect(s.state('j1')).toEqual({ lastRunDay: null, lastRunAt: null, lastStatus: null, failStreak: 0 })
    s.record('j1', '2026-10-20', 'a', 'failed:timeout', true)
    expect(s.record('j1', '2026-10-20', 'b', 'failed:x', true).failStreak).toBe(2)
    expect(s.record('j1', '2026-10-21', 'c', 'silent', false)).toEqual({ lastRunDay: '2026-10-21', lastRunAt: 'c', lastStatus: 'silent', failStreak: 0 })
    s.record('j2', '2026-10-21', 'd', 'sent', false)
    s.record('j3', '2026-10-21', 'e', 'skipped:network', false)
    expect(s.ranToday('2026-10-21')).toBe(2)
    expect(s.ranToday('2026-10-20')).toBe(0)
  })
  it('state survives a fresh store on the same dir', () => {
    const d = dir()
    makeJobsStore(d).record('j1', '2026-10-21', 'c', 'sent', false)
    expect(makeJobsStore(d).state('j1').lastStatus).toBe('sent')
  })
})
