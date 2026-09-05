import { describe, it, expect, vi } from 'vitest'
import { createSpriteRenderer } from './sprite-renderer.js'

function el() {
  const classes = new Set<string>()
  return {
    style: {} as Record<string, string>,
    classList: { add: (c: string) => { classes.add(c) }, remove: (c: string) => { classes.delete(c) }, contains: (c: string) => classes.has(c) },
    attrs: {} as Record<string, string>,
    setAttribute(k: string, v: string) { this.attrs[k] = v }, getAttribute(k: string) { return this.attrs[k] ?? null },
    src: '', appendChild() {}, replaceChildren() {},
  }
}
/** 手动计时器:schedule 入队,tick(ms) 推进。 */
function clock() {
  let now = 0; let seq = 0
  const q: Array<{ at: number, id: number, fn: () => void }> = []
  return {
    schedule: (fn: () => void, ms: number) => { const id = ++seq; q.push({ at: now + ms, id, fn }); return id },
    cancel: (id: unknown) => { const i = q.findIndex(x => x.id === id); if (i >= 0) q.splice(i, 1) },
    tick(ms: number) { const until = now + ms; while (true) { q.sort((a, b) => a.at - b.at); const n = q[0]; if (!n || n.at > until) break; q.shift(); now = n.at; n.fn() } now = until },
    pending: () => q.length,
  }
}
const anim = (frames: string[], fps: number, loop: boolean) => ({ frames, fps, loop, next: loop ? null : 'idle' })

describe('createSpriteRenderer', () => {
  it('applyAnchor 写 CSS 变量;play 立即显示第 0 帧,按 fps 推进,loop 循环', () => {
    const img = el(), stage = el(), c = clock()
    const r = createSpriteRenderer({ img, stage, schedule: c.schedule, cancel: c.cancel, preload: () => {} })
    r.applyAnchor([0.5, 0.91796875])
    expect(stage.style['--pet-anchor-x']).toBe('50%'); expect(stage.style['--pet-anchor-y']).toBe('91.796875%')
    r.play(anim(['a.png', 'b.png'], 4, true))
    expect(img.src).toBe('a.png')
    c.tick(250); expect(img.src).toBe('b.png')
    c.tick(250); expect(img.src).toBe('a.png')
  })
  it('一次性动画播完最后一帧停在最后一帧并调 onEnd 一次;单帧非 loop 也会结束', () => {
    const img = el(), stage = el(), c = clock()
    const r = createSpriteRenderer({ img, stage, schedule: c.schedule, cancel: c.cancel, preload: () => {} })
    const onEnd = vi.fn()
    r.play(anim(['a.png', 'b.png', 'c.png'], 8, false), { onEnd })
    c.tick(125); c.tick(125); expect(img.src).toBe('c.png'); expect(onEnd).not.toHaveBeenCalled()
    c.tick(125); expect(onEnd).toHaveBeenCalledTimes(1); expect(img.src).toBe('c.png')
    c.tick(1000); expect(onEnd).toHaveBeenCalledTimes(1)
    const onEnd2 = vi.fn()
    r.play(anim(['x.png'], 4, false), { onEnd: onEnd2 })
    c.tick(250); expect(onEnd2).toHaveBeenCalledTimes(1)
  })
  it('新 play 取消旧的计时器(不会两套帧交错);stop 后不再推进', () => {
    const img = el(), stage = el(), c = clock()
    const r = createSpriteRenderer({ img, stage, schedule: c.schedule, cancel: c.cancel, preload: () => {} })
    r.play(anim(['a.png', 'b.png'], 4, true))
    r.play(anim(['x.png', 'y.png'], 4, true))
    expect(c.pending()).toBe(1)
    c.tick(250); expect(img.src).toBe('y.png')
    r.stop(); c.tick(1000); expect(img.src).toBe('y.png'); expect(c.pending()).toBe(0)
  })
  it('fadeTo:先加 pet-fading,fadeMs 后换动画并去掉 class,再 fadeMs 后 onEnd', () => {
    const img = el(), stage = el(), c = clock()
    const r = createSpriteRenderer({ img, stage, schedule: c.schedule, cancel: c.cancel, preload: () => {}, fadeMs: 240 })
    r.play(anim(['old.png'], 1, true))
    const onEnd = vi.fn()
    r.fadeTo(anim(['new.png'], 1, true), { onEnd })
    expect(img.classList.contains('pet-fading')).toBe(true); expect(img.src).toBe('old.png')
    c.tick(240); expect(img.src).toBe('new.png'); expect(img.classList.contains('pet-fading')).toBe(false); expect(onEnd).not.toHaveBeenCalled()
    c.tick(240); expect(onEnd).toHaveBeenCalledTimes(1)
  })
  it('fadeTo 淡出期间被 play 打断:立刻去掉 pet-fading,新动画立即显示第 0 帧,旧 fadeTo 的 onEnd 永不触发', () => {
    const img = el(), stage = el(), c = clock()
    const r = createSpriteRenderer({ img, stage, schedule: c.schedule, cancel: c.cancel, preload: () => {}, fadeMs: 240 })
    r.play(anim(['old.png'], 1, true))
    const onEnd = vi.fn()
    r.fadeTo(anim(['new.png'], 1, true), { onEnd })
    c.tick(100)                                    // 仍在 fadeMs(240) 之内
    r.play(anim(['other.png'], 1, true))
    expect(img.classList.contains('pet-fading')).toBe(false)
    expect(img.src).toBe('other.png')
    c.tick(1000)
    expect(onEnd).not.toHaveBeenCalled()
  })
  it('fadeTo 淡出期间被 stop 打断:立刻去掉 pet-fading,且没有残留计时器', () => {
    const img = el(), stage = el(), c = clock()
    const r = createSpriteRenderer({ img, stage, schedule: c.schedule, cancel: c.cancel, preload: () => {}, fadeMs: 240 })
    r.play(anim(['old.png'], 1, true))
    r.fadeTo(anim(['new.png'], 1, true), { onEnd: vi.fn() })
    c.tick(100)                                    // 仍在 fadeMs(240) 之内
    r.stop()
    expect(img.classList.contains('pet-fading')).toBe(false)
    expect(c.pending()).toBe(0)
  })
  it('reducedMotion:setBreathing 永远不加 class;正常时加/去 pet-breathing', () => {
    const c = clock()
    const a = createSpriteRenderer({ img: el(), stage: el(), schedule: c.schedule, cancel: c.cancel, preload: () => {}, reducedMotion: true })
    const stageA = el(); const ra = createSpriteRenderer({ img: el(), stage: stageA, schedule: c.schedule, cancel: c.cancel, preload: () => {}, reducedMotion: true })
    ra.setBreathing(true); expect(stageA.classList.contains('pet-breathing')).toBe(false)
    void a
    const stageB = el(); const rb = createSpriteRenderer({ img: el(), stage: stageB, schedule: c.schedule, cancel: c.cancel, preload: () => {} })
    rb.setBreathing(true); expect(stageB.classList.contains('pet-breathing')).toBe(true)
    rb.setBreathing(false); expect(stageB.classList.contains('pet-breathing')).toBe(false)
  })
  it('reducedMotion 下多帧一次性动画只显示首帧与末帧(cross-fade 由 CSS 做),onEnd 仍只调一次', () => {
    const img = el(), stage = el(), c = clock()
    const r = createSpriteRenderer({ img, stage, schedule: c.schedule, cancel: c.cancel, preload: () => {}, reducedMotion: true })
    const onEnd = vi.fn()
    r.play(anim(['a.png', 'b.png', 'c.png', 'd.png'], 8, false), { onEnd })
    expect(img.src).toBe('a.png')
    c.tick(500)                                   // 4 帧 @8fps = 500ms
    expect(img.src).toBe('d.png'); expect(onEnd).toHaveBeenCalledTimes(1)
  })
  it('preload 对每个不重复的帧 url 调一次', () => {
    const preload = vi.fn(); const c = clock()
    const r = createSpriteRenderer({ img: el(), stage: el(), schedule: c.schedule, cancel: c.cancel, preload })
    r.play(anim(['a.png', 'b.png', 'a.png'], 4, true))
    expect(preload.mock.calls.map(x => x[0]).sort()).toEqual(['a.png', 'b.png'])
  })
})
