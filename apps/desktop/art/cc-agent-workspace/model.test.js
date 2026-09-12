import { describe, it, expect } from 'vitest'
import { createStore, descendants, overallStatus, requestStop, acknowledgeStops, decidePermission, handoffRecord, artifactSummary } from './model.js'

describe('agent workspace preview boundaries', () => {
  it('keeps drafts, scenarios and selected children separate across projects', () => {
    const store = createStore()
    store.current().draft = '不要改数据库'
    store.current().selected = 'codex-test'
    store.select('site')
    expect(store.current().draft).toBe('')
    expect(store.current().selected).not.toBe('codex-test')
    store.current().draft = '保留标题'
    store.select('desktop')
    expect(store.current().draft).toBe('不要改数据库')
    expect(store.current().selected).toBe('codex-test')
  })
  it('walks nested children without including siblings', () => {
    const nodes = [{id:'a',parentId:null},{id:'b',parentId:'a'},{id:'c',parentId:'b'},{id:'d',parentId:'a'}]
    expect(descendants(nodes, 'b').map(n => n.id)).toEqual(['b','c'])
  })
  it('stops only the selected child and waits for acknowledgement', () => {
    const state = createStore().current()
    requestStop(state, 'codex-test')
    expect(state.nodes.find(n => n.id === 'codex-test').status).toBe('stopping')
    expect(state.nodes.find(n => n.id === 'codex-edit').status).toBe('completed')
    expect(state.nodes.find(n => n.id === 'codex').status).toBe('running')
    acknowledgeStops(state)
    expect(state.nodes.find(n => n.id === 'codex-test').status).toBe('stopped')
    expect(overallStatus(state)).toBe('blocked')
  })
  it('a whole-task stop includes waiting work but preserves completed output', () => {
    const state = createStore().current()
    requestStop(state, null)
    expect(state.nodes.find(n => n.id === 'review').status).toBe('stopping')
    acknowledgeStops(state)
    expect(overallStatus(state)).toBe('stopped')
    expect(state.nodes.find(n => n.id === 'claude').status).toBe('completed')
  })
  it('surfaces an unresolved permission on a child even if its parent says running', () => {
    const store = createStore()
    store.scenario('permission')
    const state = store.current()
    expect(overallStatus(state)).toBe('permission')
    decidePermission(state, 'codex-test', false)
    expect(state.nodes.find(n => n.id === 'codex-test').status).toBe('blocked')
    expect(overallStatus(state)).toBe('blocked')
  })
  it('does not turn last known activity into successful completion when disconnected', () => {
    const store = createStore()
    store.scenario('disconnected')
    const state = store.current()
    expect(overallStatus(state)).toBe('unknown')
    expect(requestStop(state, 'codex')).toBe(false)
    store.scenario('completed')
    expect(overallStatus(store.current())).toBe('completed')
  })
  it('does not fabricate a received handoff for a queued reviewer', () => {
    const store = createStore()
    const pending = handoffRecord(store.current(), 'review')
    expect(pending.to).toBe('Claude · 复核修改')
    expect(pending.received).toBe(false)
    expect(pending.receiptId).toBeNull()
    expect(handoffRecord(store.current(), 'claude').to).toBe('Claude · 排查与整理')
    expect(handoffRecord(store.current(), 'codex-test').from).toBe('Codex')
    store.scenario('completed')
    expect(handoffRecord(store.current(), 'review').received).toBe(true)
  })
  it('describes preserved artifacts without claiming stopped or disconnected work is running', () => {
    const store = createStore()
    requestStop(store.current(), null)
    acknowledgeStops(store.current())
    expect(artifactSummary(store.current())).toContain('已停止')
    expect(artifactSummary(store.current())).not.toContain('仍在执行')
    store.scenario('disconnected')
    expect(artifactSummary(store.current())).toContain('尚不确定')
  })
})
