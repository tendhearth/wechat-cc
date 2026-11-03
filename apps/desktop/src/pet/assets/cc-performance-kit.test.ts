import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { readRGBA } from '../../../scripts/cc-png.mjs'

const root=resolve(__dirname,'../../assets/pet/cc-v1')
const raw=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8'))
const ids=['peek','stretch','walk','lift','land','celebrate','work']
const bytes=(path:string)=>readFileSync(join(root,path))
const hash=(path:string)=>createHash('sha256').update(bytes(path)).digest('hex')

it('ships coordinated performances separately from every preserved C/eye-only state',()=>{
  expect(raw.performance?.active,'coordinated candidate profile is registered').toBe(true)
  for(const form of ['lit','unlit'])expect(Object.keys(raw.forms[form].states).filter(name=>name.startsWith('life-')).sort()).toEqual(ids.map(id=>`life-${id}`).sort())
  for(const id of ids) {
    const a=raw.forms.lit.states[`life-${id}`],b=raw.forms.unlit.states[`life-${id}`]
    expect(a.frames.length).toBeGreaterThanOrEqual(8)
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
  for(const form of ['lit','unlit']) for(const id of ['peek','stretch','land','celebrate']) {
    const frames=raw.forms[form].states[`life-${id}`].frames
    expect(hash(frames.at(-1))).toBe(hash(`canonical/${form}/front.png`))
    if(id!=='land')expect(hash(frames[0])).toBe(hash(`canonical/${form}/front.png`))
  }
})
