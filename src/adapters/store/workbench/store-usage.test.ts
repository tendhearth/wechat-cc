import { describe, expect, it } from 'vitest'
import { openTestDb } from '../../../lib/db'
import { makeWorkbenchStore } from './store'

const CHOICE = { defaults: 'provider', model: null, reasoningEffort: null } as const

describe('store.usage (v82;M2b 起记在这件事的轮上)', () => {
  it('一轮一份;结束过的轮再收一次不重复加;不报用量的轮不算;不知道的项留 null', () => {
    const store = makeWorkbenchStore(openTestDb())
    const t = store.create({ title: 't', path: '/tmp/p', providerId: 'claude', ownerChatId: 'owner' })
    const first = store.execution.accept(t.id, 'r1', CHOICE)!
    store.execution.endTurn(first, { usage: { input: 100, output: 20 } })
    store.execution.endTurn(first, { usage: { input: 100, output: 20 } })
    store.execution.endTurn(store.execution.nextTurn(t.id, 'r1'), { usage: { input: 50, output: 5, cacheRead: 300 } })
    store.execution.endTurn(store.execution.nextTurn(t.id, 'r1'))
    expect(store.usage.totals(t.id)).toEqual({ turns: 2, input: 150, output: 25, cacheRead: 300, cacheWrite: null, reasoning: null, costUsd: null })
    expect(store.usage.totals('nope0000')).toEqual({ turns: 0, input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null, costUsd: null })
  })
  it('sinceByProvider: what each executor used since a time (for the weekly recap)', () => {
    const store = makeWorkbenchStore(openTestDb())
    const a = store.create({ title: 'a', path: '/tmp/p', providerId: 'claude', ownerChatId: 'owner' })
    const b = store.create({ title: 'b', path: '/tmp/p', providerId: 'codex', ownerChatId: 'owner' })
    store.execution.endTurn(store.execution.accept(a.id, 'r1', CHOICE)!, { usage: { input: 10, output: 1 } })
    store.execution.endTurn(store.execution.accept(b.id, 'r2', CHOICE)!, { usage: { input: 7, output: 3 } })
    expect(store.usage.sinceByProvider(0)).toEqual([{ providerId: 'claude', turns: 1, input: 10, output: 1 }, { providerId: 'codex', turns: 1, input: 7, output: 3 }])
    expect(store.usage.sinceByProvider(Date.now() + 60_000)).toEqual([])
  })
})
