// Complete motion/prop studies at actual runtime slots; no runtime manifest writes.
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { SLOTS, PROP_SLOTS } from '../src/pet/renderer/prop-layer.js'
import { validateCatalog } from '../art/cc-v1/motion/catalog.mjs'
import { decodeStudyPng, within, sha256 } from './validate-cc-turnaround-studies.mjs'
import { freshOutput, raster, SIZES, contactSheet, pairedFrame, saveSheet, previewHtml } from './cc-study-review.mjs'
export const SCENES=Object.freeze([
  {id:'working-laptop',title:'正在做 · 笔记本',clip:'working',props:['laptop'],badge:0},
  {id:'thinking-mug',title:'想一想 · 马克杯与思考泡泡',clip:'thinking',props:['mug','thought-bubble'],badge:0},
  {id:'permission-signal',title:'等你点头 · 提示',clip:'permission',props:['exclamation'],badge:0},
  {id:'receive-envelope',title:'收到 · 信封',clip:'receive',props:['envelope'],badge:0},
  {id:'look-light',title:'看一眼 · 微光',clip:'look',props:['micro-light'],badge:0},
])
export function propRect(name,size){
  const slot=SLOTS[PROP_SLOTS[name]]
  if(!slot||!Number.isFinite(size)||size<=0)throw Error('invalid prop or stage size')
  return {left:size*(.5+slot.dx-slot.scale/2),top:size*(470/512+slot.dy-slot.scale/2),width:size*slot.scale,height:size*slot.scale}
}
const desktop=fileURLToPath(new URL('../',import.meta.url)),padding=64,canvas=640
export function isCompositionPropSource(path, entry){
  if(entry?.kind!=='prop')return false
  if(entry.artStatus==='reviewed-production')return true
  const generation=entry.generation,digest=/^[a-f0-9]{64}$/
  return path==='../props/micro-light.png'&&entry.artStatus==='production-candidate'
    &&generation?.schemaVersion===1&&generation.artStatus==='production-candidate'
    &&generation.pngSha256===entry.sha256&&digest.test(entry.sha256)
    &&generation.glowRadius===28&&generation.samples===96&&generation.seed===11
    &&['bodySha256','scriptSha256','adapterSha256'].every(key=>digest.test(generation[key]))
    &&Array.isArray(entry.previousVersions)&&entry.previousVersions.some(old=>old.kind==='prop'&&old.artStatus==='reviewed-production'&&digest.test(old.sha256)&&old.sha256!==entry.sha256)
}
export async function buildCompositionStudies({catalogPath=join(desktop,'art/cc-v1/motion/catalog.json'),kitPath=join(desktop,'src/assets/pet/cc-v1'),outputPath}={}){
  const kit=await realpath(kitPath),propsRoot=await realpath(join(kit,'../props')),catalogFile=await realpath(catalogPath)
  const out=await freshOutput(outputPath,[kit,propsRoot,catalogFile,join(desktop,'art/cc-v1/cc-v1.blend')])
  const catalogBytes=await readFile(catalogFile),catalog=validateCatalog(JSON.parse(catalogBytes)),manifestBytes=await readFile(join(kit,'manifest.json')),manifest=JSON.parse(manifestBytes)
  const inputs=new Map([[catalogFile,sha256(catalogBytes)],[join(kit,'manifest.json'),sha256(manifestBytes)]])
  for(const name of ['pet/renderer/prop-layer.js','companion-window.css','cc-now.css']){
    const path=join(desktop,'src',name)
    inputs.set(path,sha256(await readFile(path)))
  }
  const assets=new Map(),load=async(name,size=512)=>{
    if(assets.has(name))return assets.get(name)
    const full=await realpath(resolve(kit,name)),expected=size===384?resolve(propsRoot,name.split('/').at(-1)):resolve(kit,name)
    if(full!==expected||!(size===384?within(propsRoot,full):within(kit,full)))throw Error(`asset outside approved roots: ${name}`)
    if(size===384&&!/^\.\.\/props\/[a-z-]+\.png$/.test(name))throw Error('unsafe prop path')
    const bytes=await readFile(full),entry=manifest.assets[name]
    if(!entry||sha256(bytes)!==entry.sha256)throw Error(`asset manifest digest mismatch: ${name}`)
    if(size===384&&!isCompositionPropSource(name,entry))throw Error(`unreviewed or unattested source prop: ${name}`)
    const decoded=decodeStudyPng(bytes,size)
    if(!decoded.alpha.some(a=>a))throw Error(`empty PNG: ${name}`)
    const asset={bytes,...decoded};assets.set(name,asset);inputs.set(full,sha256(bytes));return asset
  }
  // Decode the entire selected timelines before creating output.
  for(const scene of SCENES){
    const clip=catalog.clips.find(c=>c.id===scene.clip);if(!clip)throw Error(`missing scene clip: ${scene.clip}`)
    for(const name of [...clip.frames.lit,...clip.frames.unlit,...clip.masks])await load(name)
    for(const prop of scene.props){if(!manifest.props[prop])throw Error(`missing scene prop: ${prop}`);await load(manifest.props[prop],384)}
  }
  const sharp=raster(),summary={schemaVersion:1,artStatus:'production-candidate',usage:'nonruntime composition study',unreadBadges:0,tools:sharp.versions,catalogSha256:sha256(catalogBytes),manifestSha256:sha256(manifestBytes),canvas:{width:canvas,height:canvas,stageSize:512,padding,anchor:[256,470]},sizes:SIZES,slots:SLOTS,propSlots:PROP_SLOTS,scenes:[],sheets:[]},previews=[]
  await mkdir(out,{recursive:true})
  try{
    for(const scene of SCENES){
      const clip=catalog.clips.find(c=>c.id===scene.clip),frames=[],pairPreviews=[]
      let propSvg=''
      for(const name of scene.props){const rect=propRect(name,512);propSvg+=`<image x="${padding+rect.left}" y="${padding+rect.top}" width="${rect.width}" height="${rect.height}" href="data:image/png;base64,${assets.get(manifest.props[name]).bytes.toString('base64')}"/>`}
      const layer=await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${canvas}" height="${canvas}">${propSvg}</svg>`)).png().toBuffer(),overlay=await sharp(layer).ensureAlpha().raw().toBuffer()
      for(let i=0;i<clip.frames.lit.length;i++){
        const light=assets.get(clip.frames.lit[i]),dark=assets.get(clip.frames.unlit[i]),mask=assets.get(clip.masks[i])
        for(let p=0;p<512*512;p++){
          if(dark.alpha[p]!==mask.alpha[p]||light.alpha[p]<mask.alpha[p])throw Error(`${scene.id}/${i}: shared character mask mismatch`)
          const q=p*4,eye=mask.alpha[p]===255&&dark.rgba[q]===255&&dark.rgba[q+1]===255&&dark.rgba[q+2]===255
          const x=p%512,y=Math.floor(p/512)
          if(eye&&overlay[((y+padding)*canvas+x+padding)*4+3]>=250)throw Error(`${scene.id}/${i}: prop covers opaque eye pixels`)
        }
        const pair=[]
        for(const source of [light,dark])pair.push(await sharp({create:{width:canvas,height:canvas,channels:4,background:'#00000000'}}).composite([{input:source.bytes,left:padding,top:padding},{input:layer,left:0,top:0}]).png().toBuffer())
        frames.push(pair);pairPreviews.push(`data:image/png;base64,${(await pairedFrame(sharp,pair,320)).toString('base64')}`)
      }
      for(const size of SIZES)summary.sheets.push(await saveSheet(out,`${scene.id}-${size}px.png`,await contactSheet(sharp,frames,frames.map((_,i)=>String(i).padStart(3,'0')),size,canvas/512)))
      const poster=await pairedFrame(sharp,frames[clip.posterIndex],320);await writeFile(join(out,`${scene.id}-poster.png`),poster)
      summary.scenes.push({...scene,fps:clip.fps,loop:clip.loop,frameCount:frames.length,durationMs:frames.length*1000/clip.fps,posterIndex:clip.posterIndex,poster:`${scene.id}-poster.png`,posterSha256:sha256(poster),opaqueEyeOcclusions:0,propsGeometry:scene.props.map(name=>({name,...propRect(name,512)}))})
      previews.push({id:scene.id,title:scene.title,fps:clip.fps,loop:clip.loop,posterIndex:clip.posterIndex,frames:pairPreviews})
    }
    summary.inputs=[...inputs].map(([path,digest])=>({path:path===catalogFile?'art/cc-v1/motion/catalog.json':relative(desktop,path),sha256:digest}))
    await writeFile(join(out,'index.html'),previewHtml(previews,'CC · 动作与道具'))
    await writeFile(join(out,'summary.json'),JSON.stringify(summary,null,2)+'\n')
  }finally{for(const [path,digest] of inputs)if(sha256(await readFile(path))!==digest)throw Error(`source input changed: ${path}`)}
  return summary
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)buildCompositionStudies({outputPath:process.argv[2]}).then(r=>console.log(JSON.stringify({scenes:r.scenes.length,sheets:r.sheets.length,framePairs:r.scenes.reduce((n,s)=>n+s.frameCount,0)}))).catch(e=>{console.error(e.stack);process.exitCode=1})
