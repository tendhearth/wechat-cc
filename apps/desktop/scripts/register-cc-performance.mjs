// Validate a complete render before publishing optional coordinated performances.
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { readRGBA } from './cc-png.mjs'

const desktop=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const ids=['peek','stretch','walk','lift','land','celebrate','work','peek-left','curiosity']
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const json=path=>{
  const text=readFileSync(path,'utf8')
  return JSON.parse(text.replace(/^\uFEFF/,''))
}

export function buildPerformanceCatalog(plan,source,generatedAt) {
  if(plan?.schemaVersion!==4||plan.artStatus!=='production-candidate'||!isDeepStrictEqual(plan.forms,['lit','unlit'])||!Array.isArray(plan.clips))throw Error('Invalid performance plan')
  const seen=new Set()
  for(const c of plan.clips){
    if(!ids.includes(c.id)||seen.has(c.id)||!Array.isArray(c.frames)||c.frames.length<8||c.frames.length>64||!Number.isFinite(c.fps)||c.fps<1||c.fps>24||typeof c.loop!=='boolean')throw Error('Invalid performance clip')
    if(c.frames.some(s=>!s||typeof s.gazeUp!=='number'||!Number.isFinite(s.gazeUp)||s.gazeUp<-.04||s.gazeUp>.14))throw Error('Invalid performance eye placement')
    if(c.frames.some(s=>typeof s.crestTilt!=='number'||!Number.isFinite(s.crestTilt)||Math.abs(s.crestTilt)>.18||(c.id!=='curiosity'&&s.crestTilt!==0)))throw Error('Invalid performance crest placement')
    seen.add(c.id)
  }
  if(seen.size!==ids.length)throw Error('Performance profile must be complete')
  return {schemaVersion:1,artStatus:'production-candidate',generatedAt,source,
    baseUrl:'../../../src/assets/pet/cc-v1/',
    forms:[{id:'lit',label:'Light CC',description:'在身边'},{id:'unlit',label:'Dark CC',description:'安静的炭黑哑光'}],
    clips:plan.clips.map(c=>({id:c.id,title:c.title,fps:c.fps,loop:c.loop,artStatus:'production-candidate',
      frames:Object.fromEntries(['lit','unlit'].map(form=>[form,c.frames.map((_,i)=>`performance/${form}/${c.id}/${String(i).padStart(3,'0')}.png`)])),
      masks:c.frames.map((_,i)=>`masks/performance/${c.id}/${String(i).padStart(3,'0')}.png`),posterIndex:Math.floor(c.frames.length/2),
    })),
  }
}

export function preparePerformanceKit({desktopRoot=desktop,kitRoot=join(desktopRoot,'src/assets/pet/cc-v1'),
  planPath=join(desktopRoot,'art/cc-v1/performance/recipes.json'),progressPath=join(desktopRoot,'art/cc-v1/performance/render-progress.json'),
  reviewedAt=new Date().toISOString()}={}){
  const freeze=json(join(desktopRoot,'art/cc-v1/design-freeze.json'))
  for(const [path,digest] of Object.entries(freeze.sha256))if(sha(readFileSync(resolve(desktopRoot,'../..',path)))!==digest)throw Error(`Frozen source changed: ${path}`)
  const planBytes=readFileSync(planPath),plan=JSON.parse(planBytes.toString().replace(/^\uFEFF/,''))
  const progress=json(progressPath),identity=progress.identity
  const expected={planSha256:sha(planBytes),sourceSha256:freeze.sha256['apps/desktop/art/cc-v1/cc-v1.blend'],
    rendererSha256:sha(readFileSync(join(desktopRoot,'scripts/render-cc.py'))),
    geometrySha256:sha(readFileSync(join(desktopRoot,'scripts/cc_motion_geometry.py'))),
    performanceGeometrySha256:sha(readFileSync(join(desktopRoot,'scripts/cc_performance_geometry.py')))}
  if(!identity||Object.entries(expected).some(([key,value])=>identity[key]!==value)||identity.samples!==96||identity.seed!==11||!/^5\.2\.1(?: LTS)?$/.test(identity.blender))throw Error('Performance render provenance changed')
  const source={...expected,sha256:identity.sourceSha256,blender:identity.blender,samples:identity.samples,seed:identity.seed}
  const catalog=buildPerformanceCatalog(plan,source,reviewedAt),manifest=json(join(kitRoot,'manifest.json'))
  let totalBytes=0
  for(const [n,c] of plan.clips.entries()){
    const entry=catalog.clips[n]
    for(const [i,sample] of c.frames.entries()){
      const key=`${c.id}/${String(i).padStart(3,'0')}`,record=progress.samples?.[key]
      if(!record||!isDeepStrictEqual(record.parameters,sample))throw Error(`Incomplete performance sample: ${key}`)
      const images=[entry.frames.lit[i],entry.frames.unlit[i],entry.masks[i]].map(path=>{
        const data=readFileSync(join(kitRoot,path)),digest=sha(data)
        if(record.files?.[path]!==digest)throw Error(`Performance digest mismatch: ${path}`)
        totalBytes+=data.length
        return {path,digest,...readRGBA(data)}
      })
      if(!Number.isFinite(record.rig?.bodyDeterminant)||Math.abs(record.rig.bodyDeterminant-1)>.0001)throw Error(`Invalid performance rig: ${key}`)
      if(!Number.isFinite(record.rig?.crestRootError)||record.rig.crestRootError<0||record.rig.crestRootError>.000001)throw Error(`Invalid performance crest root: ${key}`)
      if(!Number.isFinite(record.rig?.crestDeterminant)||Math.abs(record.rig.crestDeterminant-1)>.0001)throw Error(`Invalid performance crest transform: ${key}`)
      for(const side of ['left','right']){
        const z=record.rig?.footLowestZ?.[side],lift=sample.feet?.[side]?.lift
        if(!Number.isFinite(z)||!Number.isFinite(lift)||z<lift-.00001||z>lift+.002)throw Error(`Invalid performance foot contact: ${key}/${side}`)
      }
      const [light,dark,mask]=images
      for(let p=0;p<mask.alpha.length;p++){
        const entity=mask.alpha[p],a=light.alpha[p],b=dark.alpha[p],x=p%512,y=Math.floor(p/512)
        if(a<entity||(entity>=250&&a!==entity)||(entity===0&&a>89)||b!==entity)throw Error(`Performance entity coverage: ${key}/${p}`)
        if((a||b)&&(x<80||x>=432||y<28||y>=470))throw Error(`Performance safe bounds: ${key}`)
      }
      for(const image of images)manifest.assets[image.path]={sha256:image.digest,view:'three-quarter',expression:`life-${c.id}`,
        artStatus:'production-candidate',...(image===mask?{}:{geometryMask:mask.path}),motionSample:i,
        source:'frozen-blender-coordinated-rig',visualReview:{reviewer:'Implementation visual QA — owner review pending',reviewedAt,
          referenceSha256:manifest.reference.sha256,method:'paired motion review and pixel-contract checks'}}
    }
    for(const form of ['lit','unlit'])manifest.forms[form].states[`life-${c.id}`]={frames:entry.frames[form],fps:c.fps,loop:c.loop,next:c.loop?null:'idle',artStatus:'production-candidate'}
  }
  manifest.performance={active:true,source,catalog:'art/cc-v1/performance/catalog.json'}
  catalog.summary={clips:plan.clips.length,pairedSamples:plan.clips.reduce((n,c)=>n+c.frames.length,0),bytes:totalBytes}
  return {manifest,catalog}
}

const writeAtomic=(path,value)=>{const temp=`${path}.tmp`;writeFileSync(temp,JSON.stringify(value,null,2)+'\n');renameSync(temp,path)}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const flags=process.argv.slice(2)
  if(flags.some(flag=>flag!=='--activate'))throw Error('Usage: node register-cc-performance.mjs [--activate]')
  const {manifest,catalog}=preparePerformanceKit()
  writeAtomic(join(desktop,'art/cc-v1/performance/catalog.json'),catalog)
  if(flags.includes('--activate'))writeAtomic(join(desktop,'src/assets/pet/cc-v1/manifest.json'),manifest)
  console.log(JSON.stringify({...catalog.summary,activated:flags.includes('--activate')},null,2))
}
