import { describe, expect, it } from 'vitest'
import { openTestDb } from '../../../lib/db'
import { makeWorkbenchStore } from './store'

// 做到条件成立为止(v80,spec 2026-10-20-workbench-until-design)
describe('store.goals', () => {
  const setup = () => {
    const db = openTestDb()
    const store = makeWorkbenchStore(db)
    const t = store.create({ title: 't', path: '/tmp/p', providerId: 'claude', ownerChatId: 'owner' })
    return { db, store, t }
  }
  it('create once, read back; no setter for the command', () => {
    const { store, t } = setup()
    expect(store.goals.get(t.id)).toBeNull()
    store.goals.create(t.id, { command: 'bun run test', maxRounds: 3 })
    expect(store.goals.get(t.id)).toMatchObject({ taskId: t.id, command: 'bun run test', maxRounds: 3, rounds: 0, status: 'active', lastExit: null, stopReason: null, checkedTurn: null })
    expect(() => store.goals.create(t.id, { command: 'rm -rf /', maxRounds: 3 })).toThrow()
    expect(store.goals.get(t.id)!.command).toBe('bun run test')
    expect(Object.keys(store.goals)).not.toContain('setCommand')
  })
  it('record a check and a status change', () => {
    const { store, t } = setup()
    store.goals.create(t.id, { command: 'x', maxRounds: 2 })
    store.goals.recordCheck(t.id, { checkedTurn: 'run1:1', exit: 1, rounds: 1 })
    expect(store.goals.get(t.id)).toMatchObject({ rounds: 1, lastExit: 1, checkedTurn: 'run1:1', status: 'active' })
    store.goals.finish(t.id, 'passed')
    expect(store.goals.get(t.id)).toMatchObject({ status: 'passed', stopReason: null })
    store.goals.finish(t.id, 'stopped', '归档了')
    expect(store.goals.get(t.id)).toMatchObject({ status: 'passed' })   // 结束过就不再变
  })
  it('max rounds must be 1–10', () => {
    const { store, t } = setup()
    expect(() => store.goals.create(t.id, { command: 'x', maxRounds: 0 })).toThrow()
    expect(() => store.goals.create(t.id, { command: 'x', maxRounds: 11 })).toThrow()
  })
})
