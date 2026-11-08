import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { readRGBA } from '../../../scripts/cc-png.mjs'
import { buildPerformancePlan } from '../../../scripts/cc-performance-recipes.mjs'
import { preparePerformanceKit } from '../../../scripts/register-cc-performance.mjs'

const root=resolve(__dirname,'../../assets/pet/cc-v1')
const raw=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8'))
const ids=['peek','stretch','walk','lift','land','celebrate','work','peek-left','curiosity']
const bytes=(path:string)=>readFileSync(join(root,path))
const hash=(path:string)=>createHash('sha256').update(bytes(path)).digest('hex')

it('binds all 134 paired poses to the current schema4 authoring and final96 render provenance',()=>{
  const desktop=resolve(__dirname,'../../..')
  const plan=JSON.parse(readFileSync(join(desktop,'art/cc-v1/performance/recipes.json'),'utf8'))
  expect(plan.schemaVersion).toBe(4)
  expect(plan).toEqual(buildPerformancePlan())
  expect(plan.clips.reduce((sum:number,clip:any)=>sum+clip.frames.length,0)).toBe(134)
  const paths=plan.clips.flatMap((clip:any)=>clip.frames.flatMap((_:any,i:number)=>[
    `performance/lit/${clip.id}/${String(i).padStart(3,'0')}.png`,
    `performance/unlit/${clip.id}/${String(i).padStart(3,'0')}.png`,
    `masks/performance/${clip.id}/${String(i).padStart(3,'0')}.png`,
  ]))
  expect(new Set(paths).size).toBe(402)
  for(const path of paths)expect(raw.assets[path],`registered final image ${path}`).toBeDefined()
  // Registration checks actual PNGs, parameters, renderer/helper digests,
  // shared masks, safe bounds and foot geometry, rather than trusting labels.
  const reviewedAt=raw.assets[raw.forms.lit.states['life-peek'].frames[0]].visualReview.reviewedAt
  const prepared=preparePerformanceKit({desktopRoot:desktop,kitRoot:root,reviewedAt})
  expect(prepared.catalog).toMatchObject({summary:{clips:9,pairedSamples:134}})
  expect(prepared.catalog.source.samples).toBe(96)
  expect(prepared.manifest).toEqual(raw)
},60_000)

it('ships coordinated performances separately from every preserved C/eye-only state',()=>{
  expect(raw.performance?.active,'coordinated candidate profile is registered').toBe(true)
  for(const form of ['lit','unlit'])expect(Object.keys(raw.forms[form].states).filter(name=>name.startsWith('life-')).sort()).toEqual(ids.map(id=>`life-${id}`).sort())
  for(const id of ids) {
    const a=raw.forms.lit.states[`life-${id}`],b=raw.forms.unlit.states[`life-${id}`]
    const expected=buildPerformancePlan().clips.find((clip:any)=>clip.id===id)!
    expect(a?.frames,`${id} has its complete final sequence`).toHaveLength(expected.frames.length)
    expect(a.fps).toBe(expected.fps);expect(a.loop).toBe(expected.loop)
    expect(b.frames).toHaveLength(a.frames.length)
    expect(b.fps).toBe(a.fps);expect(b.loop).toBe(a.loop)
    expect(a.artStatus).toBe('production-candidate')
    for(let i=0;i<a.frames.length;i++) {
      const first=raw.assets[a.frames[i]],second=raw.assets[b.frames[i]]
      expect(first.geometryMask).toBe(second.geometryMask)
      expect(first.source).toBe('frozen-blender-coordinated-rig')
      expect(first.visualReview.owner).toBeUndefined()
      expect(first.sha256).toBe(hash(a.frames[i]))
      expect(second.sha256).toBe(hash(b.frames[i]))
      expect(raw.assets[first.geometryMask].sha256).toBe(hash(first.geometryMask))
    }
  }
})

it('preserves paired matte/glow coverage and the fixed canvas while allowing authored body and feet movement',()=>{
  expect(raw.performance?.active).toBe(true)
  const base=readRGBA(bytes('masks/front.png')).alpha
  for(const id of ids) {
    const light=raw.forms.lit.states[`life-${id}`].frames
    const dark=raw.forms.unlit.states[`life-${id}`].frames
    let changedBody=false
    for(let i=0;i<light.length;i++) {
      const a=readRGBA(bytes(light[i])).alpha,b=readRGBA(bytes(dark[i])).alpha
      const entity=readRGBA(bytes(raw.assets[light[i]].geometryMask)).alpha
      expect(b.equals(entity)).toBe(true)
      expect(a.every((v,p)=>v>=entity[p]!&&(entity[p]!<250||v===entity[p])&&(entity[p]!==0||v<=89))).toBe(true)
      expect(a.every((v,p)=>!v||((p%512)>=80&&(p%512)<432&&Math.floor(p/512)>=28&&Math.floor(p/512)<470))).toBe(true)
      if(!entity.subarray(300*512).equals(base.subarray(300*512)))changedBody=true
    }
    expect(changedBody,`${id} has an actual body/feet performance`).toBe(true)
  }
},60_000)

it('settles gestures into exact accepted rest bytes without changing the canonical masters',()=>{
  expect(raw.performance?.active).toBe(true)
  for(const form of ['lit','unlit']) for(const id of ['peek','peek-left','stretch','land','celebrate','curiosity']) {
    const frames=raw.forms[form].states[`life-${id}`].frames
    expect(hash(frames.at(-1))).toBe(hash(`canonical/${form}/front.png`))
    if(id!=='land')expect(hash(frames[0])).toBe(hash(`canonical/${form}/front.png`))
  }
})
