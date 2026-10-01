import { describe, it, expect } from 'vitest'
import { adoptStep, previewTracker } from './continue-flow'

// 会话读页「接着做」的两段流程(final fix Q1–Q3):问预览的那一路、POST 回来之后下一步做什么。

const deferred = <T,>() => {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('previewTracker:点开确认卡 / 重连后重问预览,问的这段时间确认按钮不能点(Q1)', () => {
  it('在问 ⇒ checking;问到 ⇒ 不再 checking,结果算数', async () => {
    const seen: boolean[] = []
    const tr = previewTracker(b => seen.push(b))
    const d = deferred<string>()
    const run = tr.run(() => d.promise)
    expect(seen).toEqual([true])
    d.resolve('ready')
    expect(await run).toEqual({ current: true, ok: true, value: 'ready' })
    expect(seen).toEqual([true, false])
  })
  it('问不到 ⇒ 也不再 checking,结果是失败', async () => {
    const seen: boolean[] = []
    const tr = previewTracker(b => seen.push(b))
    expect(await tr.run(() => Promise.reject(new Error('offline')))).toEqual({ current: true, ok: false })
    expect(seen.at(-1)).toBe(false)
  })
  it('旧的一次比新的一次先回来:旧的作废,也不提前放开按钮;只有最新一次回来才放开', async () => {
    const seen: boolean[] = []
    const tr = previewTracker(b => seen.push(b))
    const a = deferred<string>(), b = deferred<string>()
    const first = tr.run(() => a.promise)
    const second = tr.run(() => b.promise) // 重连后又问了一次
    a.resolve('old')
    expect(await first).toEqual({ current: false })
    expect(seen.at(-1)).toBe(true)
    b.resolve('new')
    expect(await second).toEqual({ current: true, ok: true, value: 'new' })
    expect(seen.at(-1)).toBe(false)
  })
  it('cancel(换会话 / 离开页面)⇒ 在路上的作废,按钮放开', async () => {
    const seen: boolean[] = []
    const tr = previewTracker(b => seen.push(b))
    const d = deferred<string>()
    const run = tr.run(() => d.promise)
    tr.cancel()
    expect(seen.at(-1)).toBe(false)
    d.resolve('late')
    expect(await run).toEqual({ current: false })
    expect(seen.at(-1)).toBe(false)
  })
})

describe('adoptStep:POST 回来之后', () => {
  const cur = { keyStillCurrent: true, redirected: false }
  it('成功 ⇒ 去那件事;本机同一请求还在路上 ⇒ 不动', () => {
    expect(adoptStep('ok', 'm1', cur)).toEqual({ kind: 'navigate', matterId: 'm1' })
    expect(adoptStep('busy', null, cur)).toEqual({ kind: 'stay' })
  })
  it('页面已经换成别的会话(路由 key 变了)⇒ 什么都不做,不跳到旧会话那件事(Q3)', () => {
    expect(adoptStep('ok', 'm1', { keyStillCurrent: false, redirected: false })).toEqual({ kind: 'stay' })
    expect(adoptStep({ error: 'session_busy' }, null, { keyStillCurrent: false, redirected: false })).toEqual({ kind: 'stay' })
  })
  it('第一次说「已经接过了」⇒ 重问预览再打开;打开那一次又说接过了 ⇒ 不再绕,落到中性的那一句(Q2)', () => {
    expect(adoptStep({ error: 'session_managed' }, null, cur)).toEqual({ kind: 'reopen' })
    expect(adoptStep({ error: 'session_managed' }, null, { keyStillCurrent: true, redirected: true })).toEqual({ kind: 'fail', code: 'session_managed' })
  })
  it('其它失败 ⇒ 带着码说一句;成功却没拿到 id ⇒ unknown', () => {
    expect(adoptStep({ error: 'quota' }, null, cur)).toEqual({ kind: 'fail', code: 'quota' })
    expect(adoptStep('ok', null, cur)).toEqual({ kind: 'fail', code: 'unknown' })
  })
})
