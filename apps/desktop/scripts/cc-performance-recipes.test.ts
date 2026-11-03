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
    expect(p.schemaVersion).toBe(3)
    expect(p.clips.map((c:any) => c.id).sort()).toEqual(['celebrate','curiosity','land','lift','peek','peek-left','stretch','walk','work'])
    expect(p.clips.reduce((n:number,c:any)=>n+c.frames.length,0)).toBe(134)
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
  it('looks toward one discovery, with the eyes leading and returning before the body', async()=>{
    const {samplePerformance}=await import(modulePath.href), p=await plan()
    for(const [id,sign] of [['peek',1],['peek-left',-1]] as const){
      const clip=p.clips.find((c:any)=>c.id===id)
      expect(clip,`independently authored ${id}`).toBeDefined()
      expect(clip.frames.some((f:any)=>sign*f.gaze>.04)).toBe(true)
      expect(clip.frames.every((f:any)=>sign*f.gaze>=0)).toBe(true)
      const notice=samplePerformance(id,.14)
      expect(sign*notice.gaze).toBeGreaterThan(.04)
      expect(notice.body).toEqual({lean:0,squash:1,rise:0,shift:0})
      const recovery=samplePerformance(id,.82)
      expect(recovery.gaze).toBe(0)
      expect(sign*recovery.body.shift).toBeGreaterThan(.005)
    }
  })
  it('shows the lifted sole outside the body rather than retreating toward its centre', async()=>{
    const walk=(await plan()).clips.find((c:any)=>c.id==='walk')
    for(const side of ['left','right'] as const){
      const sign=side==='left'?-1:1
      const lifted=walk.frames.filter((f:any)=>f.feet[side].lift>.06)
      expect(lifted.length).toBeGreaterThan(0)
      for(const f of lifted){
        expect(sign*f.feet[side].stride).toBeGreaterThan(.06)
        expect(-sign*f.body.shift).toBeGreaterThan(.02)
      }
    }
  })
  it('lets the C settle after the body stands and keeps carried feet visibly below it', async()=>{
    const {samplePerformance}=await import(modulePath.href),p=await plan()
    for(const id of ['land','celebrate']){
      const settled=samplePerformance(id,.86)
      expect(settled.body).toEqual({lean:0,squash:1,rise:0,shift:0})
      expect(Object.values(settled.pose).reduce((n:number,v:any)=>n+v,0)).toBeGreaterThan(.03)
    }
    for(const f of p.clips.find((c:any)=>c.id==='lift').frames)
      for(const foot of Object.values(f.feet) as any[])expect(f.body.rise-foot.lift).toBeGreaterThan(.03)
  })
  it('authors a quiet curiosity story with an upward thought before its body follows', async()=>{
    const c=(await plan()).clips.find((c:any)=>c.id==='curiosity')
    expect(c,'a complete optional curiosity performance').toBeDefined()
    expect(c.frames).toHaveLength(36);expect(c.fps).toBe(12);expect(c.loop).toBe(false)
    const firstBodyMove=c.frames.findIndex((f:any)=>f.body.lean!==0||f.body.shift!==0)
    expect(firstBodyMove).toBeGreaterThan(2)
    expect(c.frames.slice(0,firstBodyMove).some((f:any)=>f.gazeUp>.09)).toBe(true)
    expect(c.frames.slice(24).some((f:any)=>f.feet.left.lift>0&&f.feet.right.lift===0)).toBe(true)
    const work=(await plan()).clips.find((c:any)=>c.id==='work')
    expect(work.frames.filter((f:any)=>f.gazeUp<-.02).length).toBeGreaterThanOrEqual(4)
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
      expect(typeof f.gazeUp,'vertical attention has a numeric control').toBe('number')
      expect(f.gazeUp).toBeGreaterThanOrEqual(-.04)
      expect(f.gazeUp).toBeLessThanOrEqual(.14)
      for(const foot of Object.values(f.feet) as any[]) {
        expect(foot.lift).toBeGreaterThanOrEqual(0)
        expect(foot.lift).toBeLessThanOrEqual(.16)
      }
      const leaves = (v:any):number[] => typeof v==='number'?[v]:Object.values(v).flatMap(leaves)
      expect(leaves(f).every(Number.isFinite)).toBe(true)
    }
  })
})
