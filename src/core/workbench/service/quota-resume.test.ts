import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb } from '../../../lib/db'
import { makeWorkbenchStore } from '../store'
import { makeQuotaResumeDomain, QUOTA_RESUME_FILE, QUOTA_RESUME_MARGIN_MS, QUOTA_RESUME_MISSED_MS } from './quota-resume'
import type { ServiceCtx } from './ctx'

const NOW = Date.parse('2026-10-20T12:00:00Z')

function setup(o: { error?: string; resetIn?: number | null; running?: boolean } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'qr-'))
  const db = openTestDb()
  const store = makeWorkbenchStore(db)
  const t = store.create({ title: 't', path: '/tmp/p', providerId: 'claude', ownerChatId: 'owner' })
  store.update(t.id, 'failed', o.error ?? 'provider_quota_exhausted')
  let now = NOW
  const continueTask = vi.fn(() => ({}) as never)
  const notices: string[] = []
  const runsByTask = new Map<string, unknown>()
  if (o.running) runsByTask.set(t.id, {})
  const reset = o.resetIn === null ? null : NOW + (o.resetIn ?? 30 * 60_000)
  const ctx = {
    store, stateDir, now: () => now, ensureAccepting: () => {}, log: () => {},
    state: { runsByTask, stopping: false } as never,
    hub: { touched: () => {}, bumped: () => {}, dispose: () => {} },
    deps: {} as never,
  } as unknown as ServiceCtx
  const timers: Array<{ fn: () => void; ms: number }> = []
  const domains = {
    execute: { continueTask },
    // 没传 notify 的路径才用到;这里的测试都传 notify
    notices: { enqueueNotice: () => {} },
    quota: { quotaExhausted: () => reset === null ? null : (now < reset ? { kind: 'quota' as const, since: NOW, resetAt: reset, message: 'x' } : null) },
  }
  const qr = makeQuotaResumeDomain(ctx, domains, { setTimer: (fn, ms) => { timers.push({ fn, ms }); return { cancel: () => {} } }, notify: (text) => { notices.push(text) } })
  const events = () => store.events(t.id).map(e => e.text)
  return { store, t, qr, continueTask, timers, notices, events, stateDir, setNow: (n: number) => { now = n }, reset }
}

describe('quota resume', () => {
  it('schedules once at reset + margin for a quota-failed task; persists; repeat = same', () => {
    const s = setup()
    const r = s.qr.request(s.t.id)
    expect(r).toEqual({ ok: true, at: s.reset! + QUOTA_RESUME_MARGIN_MS })
    expect(s.qr.request(s.t.id)).toEqual(r)
    expect(s.timers).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(s.stateDir, QUOTA_RESUME_FILE), 'utf8'))[s.t.id]).toMatchObject({ at: s.reset! + QUOTA_RESUME_MARGIN_MS, provider: 'claude' })
    expect(s.events().some(x => x.includes('只试一次'))).toBe(true)
  })
  it('refuses when not a quota failure, no known reset, or reset more than 24h away', () => {
    expect(setup({ error: 'network' }).qr.request(setup().t.id)).toMatchObject({ ok: false })
    const a = setup({ error: 'task_failed' }); expect(a.qr.request(a.t.id)).toEqual({ ok: false, error: 'not_quota_failure' })
    const b = setup({ resetIn: null }); expect(b.qr.request(b.t.id)).toEqual({ ok: false, error: 'quota_reset_unknown' })
    const c = setup({ resetIn: 25 * 3_600_000 }); expect(c.qr.request(c.t.id)).toEqual({ ok: false, error: 'quota_reset_too_far' })
  })
  it('fires once: conditions hold ⇒ continueTask with a stable request id, schedule removed', () => {
    const s = setup()
    s.qr.request(s.t.id)
    s.setNow(s.reset! + QUOTA_RESUME_MARGIN_MS)
    s.timers[0]!.fn()
    expect(s.continueTask).toHaveBeenCalledTimes(1)
    const [id, text, opts] = s.continueTask.mock.calls[0] as unknown as [string, string, { inputRequestId: string }]
    expect(id).toBe(s.t.id)
    expect(text).toContain('额度恢复了')
    expect(opts.inputRequestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(JSON.parse(readFileSync(join(s.stateDir, QUOTA_RESUME_FILE), 'utf8'))[s.t.id]).toBeUndefined()
  })
  it('owner touched the task meanwhile / archived / a run is going ⇒ does not continue, drops the schedule', () => {
    const s = setup()
    s.qr.request(s.t.id)
    s.store.addEvent(s.t.id, 'user', '主人自己说了一句')   // updatedAt 变了
    s.store.update(s.t.id, 'completed')
    s.setNow(s.reset! + QUOTA_RESUME_MARGIN_MS); s.timers[0]!.fn()
    expect(s.continueTask).not.toHaveBeenCalled()
    const r = setup({ running: true }); r.qr.request(r.t.id); r.setNow(r.reset! + QUOTA_RESUME_MARGIN_MS); r.timers[0]!.fn()
    expect(r.continueTask).not.toHaveBeenCalled()
  })
  it('a failed attempt is reported once and never retried', () => {
    const s = setup()
    s.continueTask.mockImplementation(() => { throw new Error('network_unprotected') })
    s.qr.request(s.t.id)
    s.setNow(s.reset! + QUOTA_RESUME_MARGIN_MS); s.timers[0]!.fn()
    expect(s.continueTask).toHaveBeenCalledTimes(1)
    expect(s.notices).toHaveLength(1)
    expect(s.notices[0]).toContain('没接上')
    expect(s.timers).toHaveLength(1)
  })
  it('recover after restart: future ⇒ re-armed; missed ≤ 6h ⇒ tries now; older ⇒ dropped with a note', () => {
    const s = setup()
    writeFileSync(join(s.stateDir, QUOTA_RESUME_FILE), JSON.stringify({ [s.t.id]: { at: NOW + 60_000, requestedAt: NOW - 1000, provider: 'claude', updatedAt: s.store.get(s.t.id).updatedAt } }))
    s.qr.recover(); expect(s.timers.at(-1)!.ms).toBe(60_000)
    const m = setup()
    writeFileSync(join(m.stateDir, QUOTA_RESUME_FILE), JSON.stringify({ [m.t.id]: { at: NOW - QUOTA_RESUME_MISSED_MS - 1, requestedAt: NOW - QUOTA_RESUME_MISSED_MS - 5000, provider: 'claude', updatedAt: m.store.get(m.t.id).updatedAt } }))
    m.qr.recover()
    expect(m.continueTask).not.toHaveBeenCalled()
    expect(m.events().some(x => x.includes('错过了'))).toBe(true)
  })
})

describe('quota resume · review #435', () => {
  it('skipping because the task changed leaves a note saying why (owner must not think CC forgot)', () => {
    const s = setup()
    s.qr.request(s.t.id)
    s.store.update(s.t.id, 'completed')
    s.setNow(s.reset! + QUOTA_RESUME_MARGIN_MS); s.timers[0]!.fn()
    expect(s.continueTask).not.toHaveBeenCalled()
    expect(s.events().some(x => x.includes('没有再接着做'))).toBe(true)
  })
  it('a timer that fires very late (Mac slept) ⇒ counted as missed, not continued', () => {
    const s = setup()
    s.qr.request(s.t.id)
    s.setNow(s.reset! + QUOTA_RESUME_MARGIN_MS + QUOTA_RESUME_MISSED_MS + 60_000); s.timers[0]!.fn()
    expect(s.continueTask).not.toHaveBeenCalled()
    expect(s.events().some(x => x.includes('错过了'))).toBe(true)
  })
})
