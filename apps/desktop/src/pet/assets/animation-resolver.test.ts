import { describe, it, expect } from 'vitest'
import { resolveAnimation, resolveTransition } from './animation-resolver.js'
import type { PetManifest } from './manifest-loader.js'

const anim = (f: string, loop = true) => ({ frames: [f], fps: 4, loop, next: loop ? null : 'idle' })
const m: PetManifest = {
  canvas: { width: 512, height: 512, anchor: [0.5, 0.9] },
  forms: {
    lit: { master: 'lit-master.png', states: { idle: anim('lit-idle.png'), working: anim('lit-working.png'), blink: anim('lit-blink.png', false) } },
    unlit: { master: 'unlit-master.png', states: { idle: anim('unlit-master.png') } },
  },
  transitions: { 'unlit-to-lit': { frames: ['t0.png', 't1.png'], fps: 8, loop: false, next: 'idle' } },
  props: {},
  warnings: [],
}

describe('resolveAnimation', () => {
  it('exact 命中不带 warning', () => {
    expect(resolveAnimation(m, 'lit', 'working')).toEqual({ animation: anim('lit-working.png'), source: 'exact', warnings: [] })
  })
  it('unlit 下任何非 idle 行为 → unlit.idle(master),source same-form-idle,warning 说清楚', () => {
    const r = resolveAnimation(m, 'unlit', 'working')
    expect(r.source).toBe('same-form-idle')
    expect(r.animation.frames).toEqual(['unlit-master.png'])
    expect(r.warnings).toEqual(['fallback:unlit/working→unlit/idle'])
  })
  it('同 form 连 idle 都没有 → form master 合成的单帧 loop;再没有 → lit.idle', () => {
    const noIdle: PetManifest = { ...m, forms: { ...m.forms, unlit: { master: 'unlit-master.png', states: {} } } }
    const r = resolveAnimation(noIdle, 'unlit', 'sleep')
    expect(r.source).toBe('form-master')
    expect(r.animation).toEqual({ frames: ['unlit-master.png'], fps: 1, loop: true, next: null })
    const noUnlitAtAll: PetManifest = { ...m, forms: { ...m.forms, unlit: { master: '', states: {} } } }
    expect(resolveAnimation(noUnlitAtAll, 'unlit', 'sleep').source).toBe('lit-idle')
  })
  it('未知 behavior → 当前 form 的 idle + warning unknown_behavior', () => {
    const r = resolveAnimation(m, 'lit', 'paint')
    expect(r.animation.frames).toEqual(['lit-idle.png'])
    expect(r.warnings).toEqual(['unknown_behavior:paint', 'fallback:lit/paint→lit/idle'])
  })
})

describe('resolveTransition', () => {
  it('有帧 → frames 原样(不倒放)', () => {
    const r = resolveTransition(m, 'unlit-to-lit', 'lit')
    expect(r.kind).toBe('frames')
    if (r.kind === 'frames') expect(r.animation.frames).toEqual(['t0.png', 't1.png'])
  })
  it('缺 lit-to-unlit → fade 到目标 form 的 idle,warning 记录;绝不把 unlit-to-lit 倒过来用', () => {
    const r = resolveTransition(m, 'lit-to-unlit', 'unlit')
    expect(r.kind).toBe('fade')
    if (r.kind === 'fade') expect(r.to.frames).toEqual(['unlit-master.png'])
    expect(r.warnings).toEqual(['fallback:transition/lit-to-unlit→fade'])
  })
})
