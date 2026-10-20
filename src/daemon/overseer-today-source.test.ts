import { describe, it, expect, vi } from 'vitest'
import { makeOverseerTodaySource, TODAY_TASK_LIMIT, type TodayWorkbench } from './overseer-today-source'
import type { CliDigestView } from '../core/cli-session-digest'

const NOW = 1_800_000_000_000
const view: CliDigestView = {
  session_id: 'ab12c3-x', code: 'ab12c3', source: 'codex', status: 'idle', stale: false, project: 'leni', cwd: '/w/leni',
  machine: 'here', origin_agent: null, last_summary: '好了', last_event_at: NOW - 60_000, last_prompt_at: null, created_at: 1, pending: null,
}
const wb = (over: Partial<TodayWorkbench> = {}): TodayWorkbench => ({
  list: vi.fn(() => ({ tasks: [{ id: 'a1b2c3d4', title: '修打包', path: '/w/melu', providerId: 'claude', phase: 'working' as const, updatedAt: NOW - 1000, error: null, archivedAt: null }] })),
  attention: vi.fn(() => ({ tasks: [] })),
  ...over,
})

describe('makeOverseerTodaySource', () => {
  it('读两路:终端登记处 + 工作台(未归档、最近 100 件)', () => {
    const w = wb()
    const t = makeOverseerTodaySource({ terminal: () => [view], workbench: () => w, now: () => NOW, localMachine: 'here' })()
    expect(w.list).toHaveBeenCalledWith({ archived: 'exclude', limit: TODAY_TASK_LIMIT })
    expect(t.counts).toEqual({ needsYou: 0, done: 1, running: 1, stuck: 0 })
    expect(t.unavailable).toEqual([])
  })

  it('一路抛错 / 没接 ⇒ 记 unavailable,另一路照算;工作台晚绑定(先 null 后有)', () => {
    const log = vi.fn()
    let late: TodayWorkbench | null = null
    const src = makeOverseerTodaySource({ terminal: () => { throw new Error('db gone') }, workbench: () => late, now: () => NOW, log })
    expect(src().unavailable).toEqual(['terminal', 'together'])
    expect(log).toHaveBeenCalledWith('OVERSEER', 'terminal failed: db gone')
    late = wb()
    const t = src()
    expect(t.unavailable).toEqual(['terminal'])
    expect(t.counts.running).toBe(1)
    const noAttention = makeOverseerTodaySource({ workbench: () => wb({ attention: () => { throw new Error('x') } }), now: () => NOW })()
    expect(noAttention.unavailable).toEqual(['terminal'])
    expect(noAttention.counts.running).toBe(1)
  })
})

describe('makeOverseerTodaySource × 放行规则留痕', () => {
  it('reads CC decisions over the same 24h window; a throwing reader ⇒ null, the rest still renders', () => {
    const since: number[] = []
    const ok = makeOverseerTodaySource({ terminal: () => [], now: () => 1_000_000_000, ccDecided: (from) => { since.push(from); return { rule: 1, review: 0, recent: [] } } })()
    expect(ok.ccDecided).toEqual({ rule: 1, review: 0, recent: [] })
    expect(since).toEqual([1_000_000_000 - 24 * 3600_000])
    const bad = makeOverseerTodaySource({ terminal: () => [], ccDecided: () => { throw new Error('x') }, log: () => {} })()
    expect(bad.ccDecided).toBeNull()
    expect(makeOverseerTodaySource({ terminal: () => [] })().ccDecided).toBeNull()
  })
})

describe('makeOverseerTodaySource × 定时任务', () => {
  it('passes the 24h window to the jobs reader; a throwing reader ⇒ null', () => {
    const since: number[] = []
    const ok = makeOverseerTodaySource({ terminal: () => [], now: () => 1_000_000_000, jobs: (from) => { since.push(from); return { ran: 1, spoke: 1, paused: [] } } })()
    expect(ok.jobs).toEqual({ ran: 1, spoke: 1, paused: [] })
    expect(since).toEqual([1_000_000_000 - 24 * 3600_000])
    expect(makeOverseerTodaySource({ terminal: () => [], jobs: () => { throw new Error('x') }, log: () => {} })().jobs).toBeNull()
  })
})
