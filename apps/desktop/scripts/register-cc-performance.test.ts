import { expect, it } from 'vitest'
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { buildPerformancePlan } from './cc-performance-recipes.mjs'

const file=new URL('./register-cc-performance.mjs',import.meta.url)
const desktop=resolve(__dirname,'..')
const digest=(data:Buffer|string)=>createHash('sha256').update(data).digest('hex')
async function registration(){
  expect(existsSync(file),'validated performance registration is available').toBe(true)
  return import(file.href)
}
it('requires the complete paired profile and refuses duplicate or unsafe clip identities',async()=>{
  const {buildPerformanceCatalog}=await registration(), plan=buildPerformancePlan()
  const catalog=buildPerformanceCatalog(plan,{},'2026-11-03T00:00:00Z')
  expect(catalog.clips).toHaveLength(7)
  expect(catalog.clips.find((c:any)=>c.id==='land').frames.unlit[7]).toBe('performance/unlit/land/007.png')
  expect(()=>buildPerformanceCatalog({...plan,clips:plan.clips.slice(1)}, {}, '')).toThrow('complete')
  expect(()=>buildPerformanceCatalog({...plan,clips:[...plan.clips,plan.clips[0]]}, {}, '')).toThrow('clip')
  expect(()=>buildPerformanceCatalog({...plan,clips:[{...plan.clips[0],id:'../escape'},...plan.clips.slice(1)]}, {}, '')).toThrow('clip')
})
it('rejects an incomplete render before publishing any manifest or catalog',async()=>{
  const {preparePerformanceKit}=await registration()
  const target=mkdtempSync(join(tmpdir(),'cc-performance-register-'))
  try{
    const original=readFileSync(join(desktop,'src/assets/pet/cc-v1/manifest.json'))
    writeFileSync(join(target,'manifest.json'),original)
    const planPath=join(target,'plan.json'),progressPath=join(target,'progress.json')
    const planBytes=JSON.stringify(buildPerformancePlan())
    writeFileSync(planPath,planBytes)
    const sourceHash=(path:string)=>digest(readFileSync(join(desktop,path)))
    writeFileSync(progressPath,JSON.stringify({identity:{
      planSha256:digest(planBytes),sourceSha256:sourceHash('art/cc-v1/cc-v1.blend'),
      rendererSha256:sourceHash('scripts/render-cc.py'),geometrySha256:sourceHash('scripts/cc_motion_geometry.py'),
      performanceGeometrySha256:sourceHash('scripts/cc_performance_geometry.py'),
      blender:'5.2.1 LTS',samples:96,seed:11,
    },samples:{}}))
    expect(()=>preparePerformanceKit({desktopRoot:desktop,kitRoot:target,planPath,progressPath})).toThrow('Incomplete performance sample: peek/000')
    expect(readFileSync(join(target,'manifest.json')).equals(original)).toBe(true)
    expect(existsSync(join(target,'catalog.json'))).toBe(false)
  }finally{rmSync(target,{recursive:true,force:true})}
})
