import { describe, it, expect } from 'vitest'
import { makeRuntimeState } from './state'

describe('makeRuntimeState', () => {
  it('每次一份新的、空的运行时状态,初值与 service.ts 原来的 let/const 一致', () => {
    const a = makeRuntimeState(), b = makeRuntimeState()
    expect(a.runsByTask.size).toBe(0); expect(a.reservations.size).toBe(0); expect(a.queue).toEqual([])
    expect(a.runningText.size).toBe(0); expect(a.collections.size).toBe(0)
    expect(a.nativeDecisions.size).toBe(0); expect(a.handoffDecisions.size).toBe(0)
    expect(a.order).toBe(0); expect(a.stopping).toBe(false); expect(a.shutdownComplete).toBe(false)
    expect(a.shutdownPromise).toBeUndefined(); expect(a.artifactDelivery).toBeUndefined()
    expect(a.runsByTask).not.toBe(b.runsByTask)
  })
  it('缺省 noticeWake 是个不抛的空实现(setNotificationWake 之前的行为)', async () => {
    await expect(makeRuntimeState().noticeWake()).resolves.toBeUndefined()
  })
  it('容器是同一引用:解构出来的 Map 和 state 上的是同一个(service.ts 解构、域模块走 ctx.state)', () => {
    const state = makeRuntimeState()
    const { runsByTask } = state
    runsByTask.set('t', {} as never)
    expect(state.runsByTask.get('t')).toBeDefined()
  })
})
