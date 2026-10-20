import { describe, expect, it } from 'vitest'
import { openTestDb } from '../../lib/db'
import { makeWorkbenchStore } from './store'

describe('store.usage (v82)', () => {
  it('records once per (run, turn) — replays are ignored; totals keep unknown fields null', () => {
    const store = makeWorkbenchStore(openTestDb())
    const t = store.create({ title: 't', path: '/tmp/p', providerId: 'claude', ownerChatId: 'owner' })
    store.usage.record({ taskId: t.id, runId: 'r1', turnSeq: 1, providerId: 'claude', usage: { input: 100, output: 20 }, durationMs: 5 })
    store.usage.record({ taskId: t.id, runId: 'r1', turnSeq: 1, providerId: 'claude', usage: { input: 100, output: 20 }, durationMs: 5 })
    store.usage.record({ taskId: t.id, runId: 'r1', turnSeq: 2, providerId: 'claude', usage: { input: 50, output: 5, cacheRead: 300 }, durationMs: 5 })
    expect(store.usage.totals(t.id)).toEqual({ turns: 2, input: 150, output: 25, cacheRead: 300, cacheWrite: null, reasoning: null, costUsd: null })
    expect(store.usage.totals('nope0000')).toEqual({ turns: 0, input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null, costUsd: null })
  })
  it('sinceByProvider: what each executor used since a time (for the weekly recap)', () => {
    const store = makeWorkbenchStore(openTestDb())
    const t = store.create({ title: 't', path: '/tmp/p', providerId: 'claude', ownerChatId: 'owner' })
    store.usage.record({ taskId: t.id, runId: 'r1', turnSeq: 1, providerId: 'claude', usage: { input: 10, output: 1 }, durationMs: 1 })
    store.usage.record({ taskId: t.id, runId: 'r2', turnSeq: 1, providerId: 'codex', usage: { input: 7, output: 3 }, durationMs: 1 })
    expect(store.usage.sinceByProvider(0)).toEqual([{ providerId: 'claude', turns: 1, input: 10, output: 1 }, { providerId: 'codex', turns: 1, input: 7, output: 3 }])
  })
})
