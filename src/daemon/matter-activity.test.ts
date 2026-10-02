import { describe, expect, it, vi } from 'vitest'
import { ensureChatAndNote, makeMatterActivity, MATTER_TOUCH_MIN_MS, wireMatterActivity } from './matter-activity'

function rig() {
  let t = 1_000_000
  const timers: Array<{ at: number; fn: () => void; dead: boolean }> = []
  const deferred: Array<() => void> = []
  const touch = vi.fn()
  const logs: string[] = []
  const a = makeMatterActivity({
    touch, now: () => t,
    setTimer: (fn, ms) => { const h = { at: t + ms, fn, dead: false }; timers.push(h); return h },
    clearTimer: h => { (h as { dead: boolean }).dead = true },
    defer: fn => deferred.push(fn),
    log: (_tag, line) => logs.push(line),
  })
  const flush = () => { for (const f of deferred.splice(0)) f() }
  const advance = (ms: number) => { t += ms; for (const h of timers) if (!h.dead && h.at <= t) { h.dead = true; h.fn() } }
  const rewind = (ms: number) => { t -= ms }
  return { a, touch, flush, advance, rewind, timers, logs }
}

describe('makeMatterActivity', () => {
  it('第一次 note 不同步写库,排到 defer 之后写一次', () => {
    const r = rig()
    r.a.note('deadbeef')
    expect(r.touch).not.toHaveBeenCalled()
    r.flush()
    expect(r.touch).toHaveBeenCalledTimes(1)
  })
  it('同一拍 100 次 note 只写一次 + 至多一个 trailing 定时器;trailing 在 5 秒后落地', () => {
    const r = rig()
    for (let i = 0; i < 100; i++) r.a.note('deadbeef')
    r.flush()
    expect(r.touch).toHaveBeenCalledTimes(1)
    expect(r.timers.filter(h => !h.dead)).toHaveLength(1)
    r.advance(MATTER_TOUCH_MIN_MS - 1); expect(r.touch).toHaveBeenCalledTimes(1)
    r.advance(1); expect(r.touch).toHaveBeenCalledTimes(2)
  })
  it('不同的事各自节流', () => {
    const r = rig()
    r.a.note('aaaaaaaa'); r.a.note('bbbbbbbb'); r.flush()
    expect(r.touch.mock.calls.map(c => c[0]).sort()).toEqual(['aaaaaaaa', 'bbbbbbbb'])
  })
  it('matter_not_found 静默;其它错误记一行,不抛', () => {
    const r = rig()
    r.touch.mockImplementationOnce(() => { throw new Error('matter_not_found') })
    r.a.note('aaaaaaaa'); r.flush()
    expect(r.logs).toEqual([])
    r.touch.mockImplementationOnce(() => { throw new Error('disk') })
    r.a.note('bbbbbbbb'); expect(() => r.flush()).not.toThrow()
    expect(r.logs).toHaveLength(1)
  })
  it('dispose 之后不再写、定时器清掉', () => {
    const r = rig()
    r.a.note('aaaaaaaa'); r.flush(); r.a.note('aaaaaaaa')
    r.a.dispose(); r.advance(MATTER_TOUCH_MIN_MS * 2); r.a.note('cccccccc'); r.flush()
    expect(r.touch).toHaveBeenCalledTimes(1)
  })
  it('时钟回拨(系统改时间)⇒ trailing 定时器至多等 MATTER_TOUCH_MIN_MS,不会按回拨的量等上几个小时', () => {
    const r = rig()
    r.a.note('aaaaaaaa'); r.flush()
    r.rewind(3 * 3_600_000)
    r.a.note('aaaaaaaa')
    const live = r.timers.filter(h => !h.dead)
    expect(live).toHaveLength(1)
    r.advance(MATTER_TOUCH_MIN_MS)
    expect(r.touch).toHaveBeenCalledTimes(2)
  })
  it('wireMatterActivity:工作台事件 ⇒ note;stop ⇒ 退订 + dispose(接到 shutdown),可重复调用', () => {
    let cb: ((id: string) => void) | null = null
    const off = vi.fn(() => { cb = null })
    const note = vi.fn(), dispose = vi.fn()
    const stop = wireMatterActivity({ note, dispose }, { onChange: f => { cb = f; return off } })
    cb!('deadbeef')
    expect(note).toHaveBeenCalledWith('deadbeef')
    stop(); stop()
    expect(off).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(cb).toBeNull()
    // 没有工作台 / 没有 activity 也能用
    expect(() => wireMatterActivity({ note, dispose }, undefined)()).not.toThrow()
    expect(() => wireMatterActivity(null, { onChange: () => off })()).not.toThrow()
  })
  it('ensureChatAndNote:原样返回 ensureChat 的结果并记一笔;activity 为 null 也能用', () => {
    const note = vi.fn()
    const f = ensureChatAndNote(c => ({ id: 'deadbeef', c }), { note })
    expect(f('wx@chat')).toEqual({ id: 'deadbeef', c: 'wx@chat' })
    expect(note).toHaveBeenCalledWith('deadbeef')
    expect(ensureChatAndNote(() => ({ id: 'x' }), null)('c')).toEqual({ id: 'x' })
  })
})
