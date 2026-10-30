import { test, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { validateTurnaroundStudy } from './validate-cc-turnaround-studies.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
function crc(bytes) {
  let n = -1
  for (const byte of bytes) { n ^= byte; for (let bit=0;bit<8;bit++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0) }
  return (n ^ -1) >>> 0
}
function png(rgba) {
  const chunk = (name, bytes) => {
    const type=Buffer.from(name), head=Buffer.alloc(4), end=Buffer.alloc(4)
    head.writeUInt32BE(bytes.length);end.writeUInt32BE(crc(Buffer.concat([type,bytes])))
    return Buffer.concat([head,type,bytes,end])
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(512,0);header.writeUInt32BE(512,4);header[8]=8;header[9]=6
  const rows=Buffer.alloc(513*512*4-512*3)
  for(let y=0;y<512;y++)rgba.copy(rows,y*2049+1,y*2048,(y+1)*2048)
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))])
}
const recipe=()=>[
  ...Array.from({length:16},(_,i)=>({id:`yaw-${String(i*225).padStart(4,'0')}`,yaw:i*22.5,pitch:0,family:'horizontal',label:`${i*22.5}°`})),
  ...[['front-up-15',0,15],['front-up-30',0,30],['front-left-up-15',315,15],['front-left-up-30',315,30]].map(([id,yaw,pitch])=>({id,yaw,pitch,family:'elevation',label:`${yaw}° / +${pitch}°`}))]
function images() {
  const data=Object.fromEntries(['lit','unlit','mask'].map(f=>[f,Buffer.alloc(512*512*4)]))
  for(let y=100;y<470;y++)for(let x=150;x<360;x++){
    const i=(y*512+x)*4
    data.lit.set([255,245,226,255],i);data.unlit.set([25,25,25,255],i);data.mask.set([255,255,255,255],i)
  }
  for(let y=200;y<214;y++)for(const start of [220,260])for(let x=start;x<start+6;x++)data.unlit.set([255,255,255,255],(y*512+x)*4)
  data.lit.set([255,200,90,50],(250*512+145)*4)
  return data
}
async function fixture(mutate=()=>{}) {
  const root=await mkdtemp(join(tmpdir(),'cc-turnaround-'))
  const data=images();mutate(data)
  const paths=['motion/lit/yaw-0000/000.png','motion/unlit/yaw-0000/000.png','masks/yaw-0000.png']
  const files={}
  for(const [index,name] of paths.entries()){
    const bytes=png(data[['lit','unlit','mask'][index]]);await mkdir(join(root,name,'..'),{recursive:true});await writeFile(join(root,name),bytes);files[name]=sha(bytes)
  }
  const views=recipe()
  const index={schemaVersion:1,artStatus:'production-candidate',usage:'nonruntime directional study',generatedAt:'2026-10-30T18:00:00Z',
    canvas:{width:512,height:512,anchor:[256,470],safeBbox:[80,28,432,470]},commonScale:3.85,complete:false,
    identity:{sourceSha256:'a'.repeat(64),rendererSha256:'b'.repeat(64),geometrySha256:'c'.repeat(64),studyScriptSha256:'d'.repeat(64),adapterSha256:'e'.repeat(64),blender:'5.2.1 LTS',studySamples:96,seed:11,recipe:views},
    views:{'yaw-0000':{parameters:views[0],paths,files,entityBbox:[150,100,360,470],whiteEyePixels:168,visibleEyesRequired:true}}}
  const save=()=>writeFile(join(root,'index.json'),JSON.stringify(index))
  await save()
  return {root,index,paths,save,close:()=>rm(root,{recursive:true,force:true})}
}

test('validates a real decoded paired PNG fixture with shared mask and floor registration',async()=>{
  const f=await fixture()
  try{
    const result=await validateTurnaroundStudy({studyPath:f.root,allowPartial:true})
    expect(result.pairCount).toBe(1);expect(result.complete).toBe(false)
    expect(result.views[0].entityBbox).toEqual([150,100,360,470]);expect(result.views[0].whiteEyePixels).toBe(168)
    expect(result.views[0].exteriorDarkPixels).toBe(0);expect(result.views[0].maxExteriorLightAlpha).toBe(50)
  }finally{await f.close()}
})

test('partial or falsely complete packs cannot be certified as twenty completed pairs',async()=>{
  const f=await fixture()
  try{
    await expect(validateTurnaroundStudy({studyPath:f.root})).rejects.toThrow(/incomplete/)
    f.index.complete=true;await f.save()
    await expect(validateTurnaroundStudy({studyPath:f.root,allowPartial:true})).rejects.toThrow(/complete|count/)
  }finally{await f.close()}
})

test('rejects Dark exterior haze, eroded opaque alpha, unsafe glow and excessive effect opacity',async()=>{
  const variants=[
    d=>d.unlit.set([20,20,20,1],(250*512+145)*4),
    d=>{d.lit[(250*512+200)*4+3]=254},
    d=>d.lit.set([255,200,90,1],(250*512+70)*4),
    d=>{d.lit[(250*512+145)*4+3]=90},
  ]
  for(const mutate of variants){const f=await fixture(mutate)
    try{await expect(validateTurnaroundStudy({studyPath:f.root,allowPartial:true})).rejects.toThrow(/haze|coverage|opaque|bounds|exterior/)}finally{await f.close()}
  }
})

test('missing last-row coverage and invisible front eyes fail even when file hashes are correct',async()=>{
  for(const kind of ['floor','eyes']){
    const f=await fixture(d=>{
      if(kind==='floor')for(const pixels of Object.values(d))pixels.fill(0,469*512*4,470*512*4)
      else for(let y=200;y<214;y++)for(const start of [220,260])for(let x=start;x<start+6;x++)d.unlit.set([25,25,25,255],(y*512+x)*4)
    })
    try{
      if(kind==='floor')f.index.views['yaw-0000'].entityBbox=[150,100,360,469]
      else f.index.views['yaw-0000'].whiteEyePixels=0
      await f.save();await expect(validateTurnaroundStudy({studyPath:f.root,allowPartial:true})).rejects.toThrow(/baseline|eyes/)
    }finally{await f.close()}
  }
})

test('checks stored digests and PNG chunk CRCs independently',async()=>{
  const f=await fixture()
  try{
    const path=join(f.root,f.paths[0]),original=await readFile(path),corrupt=Buffer.from(original)
    corrupt[corrupt.length-1]^=1;await writeFile(path,corrupt)
    await expect(validateTurnaroundStudy({studyPath:f.root,allowPartial:true})).rejects.toThrow(/digest/)
    f.index.views['yaw-0000'].files[f.paths[0]]=sha(corrupt);await f.save()
    await expect(validateTurnaroundStudy({studyPath:f.root,allowPartial:true})).rejects.toThrow(/CRC/)
  }finally{await f.close()}
})

test('rejects normalized path escapes and symlinks leaving the study root',async()=>{
  const f=await fixture();const outside=await mkdtemp(join(tmpdir(),'cc-turnaround-outside-'))
  try{
    const name=f.paths[0],old=await readFile(join(f.root,name));await rm(join(f.root,name));await writeFile(join(outside,'frame.png'),old)
    await symlink(join(outside,'frame.png'),join(f.root,name))
    await expect(validateTurnaroundStudy({studyPath:f.root,allowPartial:true})).rejects.toThrow(/outside|leaves/)
    f.index.views['yaw-0000'].paths[0]='../frame.png';await f.save()
    await expect(validateTurnaroundStudy({studyPath:f.root,allowPartial:true})).rejects.toThrow(/path/)
  }finally{await f.close();await rm(outside,{recursive:true,force:true})}
})

test('metadata cannot mislabel view angles, source status or a per-view scale',async()=>{
  for(const mutate of [i=>{i.artStatus='reviewed-production'},i=>{i.canvas.anchor=[255,470]},i=>{i.views['yaw-0000'].parameters={...i.views['yaw-0000'].parameters,yaw:90}},i=>{i.views['yaw-0000'].scale=4},i=>{i.identity.recipe[1].id=i.identity.recipe[0].id}]){
    const f=await fixture()
    try{mutate(f.index);await f.save();await expect(validateTurnaroundStudy({studyPath:f.root,allowPartial:true})).rejects.toThrow(/status|canvas|view|scale|recipe/)}finally{await f.close()}
  }
})
test('camera and raster foot registration metadata cannot contain nonfinite or unbounded values',async()=>{
  for(const mutate of [v=>{v.cameraLocation=null},v=>{v.cameraRotation=[0,null,0]},v=>{v.footRegistration.cameraShiftPixels=3},v=>{v.footRegistration.after[3]=469}]){
    const f=await fixture()
    try{const view=f.index.views['yaw-0000'];Object.assign(view,{cameraLocation:[0,-10.5,1.65],cameraRotation:[0,0,0],footRegistration:{cameraShiftPixels:0,before:[150,100,360,470],after:[150,100,360,470]}});mutate(view);await f.save();await expect(validateTurnaroundStudy({studyPath:f.root,allowPartial:true})).rejects.toThrow(/camera|registration/)}finally{await f.close()}
  }
})
