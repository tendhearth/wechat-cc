import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'

const modulePath = new URL('./cc-performance-recipes.mjs', import.meta.url)
async function plan() {
  expect(existsSync(modulePath), 'coordinated performance authoring is available').toBe(true)
  return (await import(modulePath.href)).buildPerformancePlan()
}

describe('coordinated CC performances', () => {
  it('closes loops and returns gestures to the accepted resting pose', async () => {
    const p = await plan()
    expect(p.schemaVersion).toBe(2)
    expect(p.clips.map((c:any) => c.id).sort()).toEqual(['celebrate','land','lift','peek','stretch','walk','work'])
    const rest = p.clips.find((c:any) => c.id === 'peek').frames[0]
    expect(rest.body).toEqual({ lean:0, squash:1, rise:0, shift:0 })
    for (const c of p.clips) {
      if (c.loop) expect(c.frames.at(-1)).toEqual(c.frames[0])
      else {
        expect(c.frames.at(-1)).toEqual(rest)
        if(c.id !== 'land') expect(c.frames[0]).toEqual(rest)
      }
    }
  })
  it('plants a support foot while the other takes a visible step', async () => {
    const walk = (await plan()).clips.find((c:any) => c.id === 'walk')
    expect(walk.frames.some((f:any) => f.feet.left.lift > .06 && f.feet.right.lift === 0)).toBe(true)
    expect(walk.frames.some((f:any) => f.feet.right.lift > .06 && f.feet.left.lift === 0)).toBe(true)
    for(const f of walk.frames) {
      expect(Math.min(f.feet.left.lift, f.feet.right.lift)).toBe(0)
      for(const foot of Object.values(f.feet) as any[]) if(foot.lift === 0) {
        expect(foot.stride).toBe(0)
        expect(foot.roll).toBe(0)
      }
    }
  })
  it('anticipates a real completion and settles after a confirmed landing', async () => {
    const p = await plan()
    const done = p.clips.find((c:any) => c.id === 'celebrate')
    const apex = done.frames.findIndex((f:any) => f.body.rise === Math.max(...done.frames.map((f:any) => f.body.rise)))
    expect(done.frames.slice(0,apex).some((f:any) => f.body.squash < .95)).toBe(true)
    expect(done.frames[apex].body.rise).toBeGreaterThan(.07)
    expect(done.frames.slice(apex+1).some((f:any) => f.body.squash < .98)).toBe(true)
    const land = p.clips.find((c:any) => c.id === 'land')
    expect(land.frames[0].body.rise).toBeGreaterThan(0)
    expect(land.frames.some((f:any) => f.body.squash < .92)).toBe(true)
    expect(done.frames.length / done.fps).toBeLessThan(.8)
    expect(land.frames.length / land.fps).toBeLessThan(.55)
  })
  it('keeps every sampled control finite and within a restrained silhouette envelope', async () => {
    const p = await plan()
    for(const c of p.clips) for(const f of c.frames) {
      expect(Math.abs(f.body.lean)).toBeLessThanOrEqual(.06)
      expect(f.body.squash).toBeGreaterThanOrEqual(.88)
      expect(f.body.squash).toBeLessThanOrEqual(1.07)
      expect(f.body.rise).toBeGreaterThanOrEqual(0)
      expect(f.body.rise).toBeLessThanOrEqual(.13)
      expect(Math.abs(f.body.shift)).toBeLessThanOrEqual(.05)
      for(const foot of Object.values(f.feet) as any[]) {
        expect(foot.lift).toBeGreaterThanOrEqual(0)
        expect(foot.lift).toBeLessThanOrEqual(.16)
      }
      const leaves = (v:any):number[] => typeof v==='number'?[v]:Object.values(v).flatMap(leaves)
      expect(leaves(f).every(Number.isFinite)).toBe(true)
    }
  })
})
