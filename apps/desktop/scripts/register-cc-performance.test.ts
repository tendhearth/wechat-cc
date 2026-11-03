import { expect, it } from 'vitest'
import { existsSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
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
  expect(catalog.clips).toHaveLength(9)
  expect(catalog.clips.find((c:any)=>c.id==='land').frames.unlit[7]).toBe('performance/unlit/land/007.png')
  expect(()=>buildPerformanceCatalog({...plan,clips:plan.clips.slice(1)}, {}, '')).toThrow('complete')
  expect(()=>buildPerformanceCatalog({...plan,clips:[...plan.clips,plan.clips[0]]}, {}, '')).toThrow('clip')
  expect(()=>buildPerformanceCatalog({...plan,clips:[{...plan.clips[0],id:'../escape'},...plan.clips.slice(1)]}, {}, '')).toThrow('clip')
})
it('rejects old eye schemas and nonfinite or out-of-face vertical attention before publishing',async()=>{
  const {buildPerformanceCatalog}=await registration(),plan=buildPerformancePlan()
  for(const schemaVersion of [2,3])expect(()=>buildPerformanceCatalog({...plan,schemaVersion},{},'')).toThrow('plan')
  for(const gazeUp of [NaN,Infinity,.141,-.041,undefined]){
    const bad:any=structuredClone(plan);bad.clips[0].frames[1].gazeUp=gazeUp
    expect(()=>buildPerformanceCatalog(bad,{},'')).toThrow('eye')
  }
})
it('rejects invalid rooted C controls and keeps their independent motion exclusive to curiosity',async()=>{
  const {buildPerformanceCatalog}=await registration(),plan=buildPerformancePlan()
  for(const crestTilt of [undefined,NaN,Infinity,.181,-.181]){
    const bad:any=structuredClone(plan);bad.clips.find((c:any)=>c.id==='curiosity').frames[4].crestTilt=crestTilt
    expect(()=>buildPerformanceCatalog(bad,{},'')).toThrow('crest')
  }
  const bad:any=structuredClone(plan);bad.clips.find((c:any)=>c.id==='walk').frames[4].crestTilt=.1
  expect(()=>buildPerformanceCatalog(bad,{},'')).toThrow('crest')
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
it('rejects a detached or scaled C root from actual per-sample render evidence before publishing',async()=>{
  const {preparePerformanceKit}=await registration(),target=mkdtempSync(join(tmpdir(),'cc-crest-rig-register-'))
  try{
    const kit=join(desktop,'src/assets/pet/cc-v1'),plan=buildPerformancePlan()
    writeFileSync(join(target,'manifest.json'),readFileSync(join(kit,'manifest.json')))
    const planPath=join(target,'plan.json'),progressPath=join(target,'progress.json'),planBytes=JSON.stringify(plan)
    writeFileSync(planPath,planBytes)
    const imagePaths=['performance/lit/peek/000.png','performance/unlit/peek/000.png','masks/performance/peek/000.png']
    const sources=['canonical/lit/front.png','canonical/unlit/front.png','masks/front.png']
    const files:Record<string,string>={}
    for(const [i,path] of imagePaths.entries()){
      const data=readFileSync(join(kit,sources[i]!));mkdirSync(join(target,path,'..'),{recursive:true});writeFileSync(join(target,path),data);files[path]=digest(data)
    }
    const sourceHash=(path:string)=>digest(readFileSync(join(desktop,path)))
    const progress:any={identity:{planSha256:digest(planBytes),sourceSha256:sourceHash('art/cc-v1/cc-v1.blend'),rendererSha256:sourceHash('scripts/render-cc.py'),geometrySha256:sourceHash('scripts/cc_motion_geometry.py'),performanceGeometrySha256:sourceHash('scripts/cc_performance_geometry.py'),blender:'5.2.1 LTS',samples:96,seed:11},samples:{'peek/000':{parameters:plan.clips[0]!.frames[0],files,rig:{bodyDeterminant:1,footLowestZ:{left:0,right:0},crestRootError:.001,crestDeterminant:1}}}}
    const prepare=()=>preparePerformanceKit({desktopRoot:desktop,kitRoot:target,planPath,progressPath})
    writeFileSync(progressPath,JSON.stringify(progress));expect(prepare).toThrow('crest root')
    progress.samples['peek/000'].rig.crestRootError=0;progress.samples['peek/000'].rig.crestDeterminant=.9
    writeFileSync(progressPath,JSON.stringify(progress));expect(prepare).toThrow('crest transform')
    progress.samples['peek/000'].rig.crestDeterminant=1
    writeFileSync(progressPath,JSON.stringify(progress));expect(prepare).toThrow('Incomplete performance sample: peek/001')
  }finally{rmSync(target,{recursive:true,force:true})}
})
