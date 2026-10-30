// Independent, native-free validation of nonruntime paired view studies.
import { readFile, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, relative, isAbsolute, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readRGBA } from './cc-png.mjs'

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export const within = (root, path) => { const r=relative(root,path);return r===''||(!isAbsolute(r)&&r!=='..'&&!r.startsWith(`..${sep}`)) }
const fail = message => { throw Error(message) }
const same = (a,b) => JSON.stringify(a)===JSON.stringify(b)
const table=Array.from({length:256},(_,i)=>{let n=i;for(let j=0;j<8;j++)n=(n>>>1)^(n&1?0xedb88320:0);return n>>>0})
const crc = bytes => {let n=0xffffffff;for(const b of bytes)n=(n>>>8)^table[(n^b)&255];return (n^0xffffffff)>>>0}

export function decodeStudyPng(bytes, size=512) {
  if(bytes.length<45||bytes.length>8*1024*1024||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')fail('PNG signature or size')
  let offset=8, header=false, data=false, ended=false, dataEnded=false
  while(offset<bytes.length){
    if(offset+12>bytes.length)fail('truncated PNG chunk')
    const n=bytes.readUInt32BE(offset),end=offset+12+n
    if(end>bytes.length)fail('truncated PNG chunk')
    const type=bytes.toString('ascii',offset+4,offset+8)
    if(crc(bytes.subarray(offset+4,end-4))!==bytes.readUInt32BE(end-4))fail('PNG CRC mismatch')
    if(!header&&(type!=='IHDR'||n!==13))fail('PNG header order')
    if(type==='IHDR'){if(header)fail('duplicate PNG header');header=true}
    else if(type==='IDAT'){if(dataEnded)fail('noncontiguous PNG data');data=true}
    else {if(data)dataEnded=true;if(type==='IEND'){if(n||!data||end!==bytes.length)fail('PNG end or trailing bytes');ended=true}}
    if(!['IHDR','IDAT','IEND'].includes(type)&&type[0]===type[0].toUpperCase())fail('unknown critical PNG chunk')
    offset=end
  }
  if(!ended)fail('missing PNG end')
  return readRGBA(bytes,size)
}

function checkRecipe(recipe){
  if(!Array.isArray(recipe)||recipe.length!==20||new Set(recipe.map(v=>v.id)).size!==20)fail('invalid twenty-view recipe')
  const expected=[...Array.from({length:16},(_,i)=>[`yaw-${String(i*225).padStart(4,'0')}`,i*22.5,0,'horizontal']),
    ['front-up-15',0,15,'elevation'],['front-up-30',0,30,'elevation'],['front-left-up-15',315,15,'elevation'],['front-left-up-30',315,30,'elevation']]
  for(let i=0;i<20;i++)if(!same([recipe[i].id,recipe[i].yaw,recipe[i].pitch,recipe[i].family],expected[i])||typeof recipe[i].label!=='string')fail('view recipe mismatch')
}

export async function validateTurnaroundStudy({studyPath,allowPartial=false}={}){
  const root=await realpath(studyPath),indexBytes=await readFile(resolve(root,'index.json')),index=JSON.parse(indexBytes)
  if(index.schemaVersion!==1||index.artStatus!=='production-candidate'||index.usage!=='nonruntime directional study')fail('study status or schema')
  if(!same(index.canvas,{width:512,height:512,anchor:[256,470],safeBbox:[80,28,432,470]}))fail('study canvas mismatch')
  if(!Number.isFinite(index.commonScale)||index.commonScale<3.85||index.commonScale>6)fail('invalid common scale')
  if(typeof index.generatedAt!=='string'||!/^\d{4}-\d\d-\d\dT/.test(index.generatedAt)||!Number.isFinite(Date.parse(index.generatedAt)))fail('study timestamp')
  const identity=index.identity
  for(const key of ['sourceSha256','rendererSha256','geometrySha256','studyScriptSha256','adapterSha256'])if(!/^[a-f0-9]{64}$/.test(identity?.[key]))fail('study source digest')
  if(identity.blender!=='5.2.1 LTS'||!Number.isInteger(identity.studySamples)||identity.studySamples<1||identity.studySamples>96||identity.seed!==11)fail('study render identity')
  checkRecipe(identity.recipe)
  const entries=Object.entries(index.views??{}),ids=new Set(identity.recipe.map(v=>v.id))
  if(typeof index.complete!=='boolean'||!entries.length||entries.some(([id])=>!ids.has(id)))fail('invalid view count')
  if(index.complete!==(entries.length===20))fail('complete view count mismatch')
  if(index.complete&&identity.studySamples!==96)fail('complete study requires final samples')
  if(!allowPartial&&!index.complete)fail('incomplete study pack')
  const metrics=[]
  for(const [id,view] of entries){
    const expected=identity.recipe.find(v=>v.id===id),required=minYaw(expected.yaw)<=45
    if(!same(view.parameters,expected)||Object.hasOwn(view,'scale')||view.visibleEyesRequired!==required)fail('view parameters or scale mismatch')
    if(index.complete||['cameraLocation','cameraRotation','footRegistration'].some(k=>view[k]!==undefined)){
      for(const key of ['cameraLocation','cameraRotation'])if(!Array.isArray(view[key])||view[key].length!==3||!view[key].every(Number.isFinite))fail('view camera coordinates')
      const foot=view.footRegistration
      if(!foot||!Number.isFinite(foot.cameraShiftPixels)||Math.abs(foot.cameraShiftPixels)>2||!Array.isArray(foot.after)||foot.after.length!==4||!foot.after.every(Number.isInteger)||foot.after[0]<80||foot.after[1]<28||foot.after[2]>432||foot.after[3]!==470)fail('view foot registration')
    }
    const paths=[`motion/lit/${id}/000.png`,`motion/unlit/${id}/000.png`,`masks/${id}.png`]
    if(!same(view.paths,paths)||!same(Object.keys(view.files??{}).sort(),[...paths].sort()))fail('invalid study path set')
    const decoded=[]
    for(const name of paths){
      const path=await realpath(resolve(root,name));if(!within(root,path))fail('asset symlink leaves study root: outside path')
      const bytes=await readFile(path);if(sha256(bytes)!==view.files[name])fail('study asset digest mismatch')
      decoded.push(decodeStudyPng(bytes))
    }
    const [light,dark,mask]=decoded
    let minX=512,minY=512,maxX=-1,maxY=-1,white=0,exterior=0,lightMax=0,floor=false
    for(let i=0;i<512*512;i++){
      const x=i%512,y=Math.floor(i/512),a=mask.alpha[i],l=light.alpha[i],d=dark.alpha[i],p=i*4
      for(const image of decoded)if(!image.alpha[i]&&(image.rgba[p]||image.rgba[p+1]||image.rgba[p+2]))fail(`${id}: transparent RGB must be zero`)
      if(a&&(mask.rgba[p]!==255||mask.rgba[p+1]!==255||mask.rgba[p+2]!==255))fail(`${id}: entity mask RGB must be white`)
      if(a){minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);if(y===469)floor=true}
      if((x<80||x>=432||y<28||y>=470)&&(a||l||d))fail(`${id}: alpha outside safe bounds`)
      if(l<a)fail(`${id}: Light coverage eroded`)
      if(a>=250&&l!==a)fail(`${id}: opaque entity alpha changed`)
      if(!a){lightMax=Math.max(lightMax,l);if(l>89)fail(`${id}: exterior Light alpha exceeds 89`);if(d)exterior++}
      if(d!==a)fail(`${id}: Dark haze or shared mask mismatch`)
      if(a===255&&dark.rgba[p]===255&&dark.rgba[p+1]===255&&dark.rgba[p+2]===255)white++
    }
    if(maxX<0||!floor)fail(`${id}: missing floor baseline`)
    if(required&&!white)fail(`${id}: missing front white eyes`)
    const box=[minX,minY,maxX+1,maxY+1]
    if(!same(box,view.entityBbox)||white!==view.whiteEyePixels)fail(`${id}: view pixel metadata mismatch`)
    metrics.push({id,entityBbox:box,whiteEyePixels:white,exteriorDarkPixels:exterior,maxExteriorLightAlpha:lightMax,files:view.files})
  }
  return {schemaVersion:1,artStatus:index.artStatus,complete:index.complete,pairCount:metrics.length,indexSha256:sha256(indexBytes),identity,commonScale:index.commonScale,views:metrics}
}
const minYaw=yaw=>Math.min(yaw,360-yaw)
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  validateTurnaroundStudy({studyPath:process.argv[2]}).then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e.message);process.exitCode=1})
}
