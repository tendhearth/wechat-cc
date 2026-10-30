import { realpath, stat, readdir, writeFile } from 'node:fs/promises'
import { resolve, dirname, basename, join } from 'node:path'
import { createRequire } from 'node:module'
import { within, sha256 } from './validate-cc-turnaround-studies.mjs'
export const SIZES=[48,96,128,256]
export const BACKGROUNDS=['#faf7f2','#20242b']
export const xml=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]))
async function canonical(path){try{return await realpath(path)}catch(e){if(e.code!=='ENOENT'||dirname(path)===path)throw e;return join(await canonical(dirname(path)),basename(path))}}
export async function freshOutput(outputPath,protectedPaths){
  if(typeof outputPath!=='string'||!outputPath.trim())throw Error('explicit output required')
  const out=await canonical(resolve(outputPath))
  for(const p of protectedPaths){const input=await canonical(resolve(p));if(within(input,out)||within(out,input))throw Error('review output overlaps protected input')}
  try{if(!(await stat(out)).isDirectory()||(await readdir(out)).length)throw Error('review output must be new or empty')}catch(e){if(e.code!=='ENOENT')throw e}
  return out
}
export function raster(){const require=createRequire(import.meta.url),sharp=require(process.env.CC_SHARP_MODULE||'sharp');sharp.concurrency(1);return sharp}
/** Full sequence, both forms on both grounds; labels remain readable at 48px. */
export async function contactSheet(sharp,frames,labels,size,frameScale=1){
  const rasterSize=Math.ceil(size*frameScale)
  const cell=Math.max(rasterSize+16,96),width=96+frames.length*cell,height=48+4*(rasterSize+36),layers=[]
  let text=''
  for(let row=0;row<4;row++){
    const y=48+row*(rasterSize+36),bg=BACKGROUNDS[Math.floor(row/2)],form=row%2
    layers.push({input:await sharp({create:{width,height:rasterSize+36,channels:4,background:bg}}).png().toBuffer(),left:0,top:y})
    text+=`<text x="12" y="${y+22}" fill="${row<2?'#5b5148':'#ece8e1'}" font-size="12">${form?'Dark CC':'Light CC'}</text>`
    for(let i=0;i<frames.length;i++){
      layers.push({input:await sharp(frames[i][form]).resize(rasterSize,rasterSize).png().toBuffer(),left:96+i*cell+Math.floor((cell-rasterSize)/2),top:y+24})
      if(row===0)text+=`<text x="${96+i*cell+cell/2}" y="28" text-anchor="middle" fill="#5b5148" font-size="11">${xml(labels[i])}</text>`
    }
  }
  layers.push({input:Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><g font-family="sans-serif">${text}</g></svg>`),left:0,top:0})
  return {bytes:await sharp({create:{width,height,channels:4,background:BACKGROUNDS[0]}}).composite(layers).png().toBuffer(),width,height}
}
export async function pairedFrame(sharp,pair,size=256){
  const width=2*size+64,height=2*size+100,layers=[]
  for(let row=0;row<2;row++){
    layers.push({input:await sharp({create:{width,height:size+32,channels:4,background:BACKGROUNDS[row]}}).png().toBuffer(),left:0,top:32+row*(size+32)})
    for(let form=0;form<2;form++)layers.push({input:await sharp(pair[form]).resize(size,size).png().toBuffer(),left:16+form*(size+32),top:48+row*(size+32)})
  }
  layers.push({input:Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><g fill="#5b5148" font-family="sans-serif" font-size="14" text-anchor="middle"><text x="${16+size/2}" y="22">Light CC</text><text x="${48+size*1.5}" y="22">Dark CC</text></g></svg>`),left:0,top:0})
  return sharp({create:{width,height,channels:4,background:BACKGROUNDS[0]}}).composite(layers).png().toBuffer()
}
export async function saveSheet(out,name,sheet){await writeFile(join(out,name),sheet.bytes);return {file:name,width:sheet.width,height:sheet.height,sha256:sha256(sheet.bytes)}}
export function previewHtml(clips,title){
  const data=JSON.stringify(clips).replace(/</g,'\\u003c')
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'"><title>${xml(title)}</title><style>body{margin:0;background:#faf7f2;color:#302b26;font:16px/1.6 system-ui}main{max-width:640px;margin:48px auto;padding:0 20px}h1{font-size:26px;font-weight:500}h2{font-size:20px;font-weight:500}p{color:#71675d}section{margin:48px 0}img{display:block;width:100%;height:auto}button,select{font:inherit;color:inherit;background:transparent;border:1px solid #b8aea2;border-radius:8px;padding:6px 18px}span[role=status]{display:block;min-height:26px;color:#71675d}</style><main><h1>${xml(title)}</h1><p>素材候选预览 · 不表示 CC 当前状态。Light CC 表示在身边，Dark CC 表示暂时没连上。点击后播放。</p>${clips.map(c=>`<section data-clip="${xml(c.id)}"><h2>${xml(c.title)}</h2><p>${c.fps} fps · ${c.loop?'循环':'单次'} · production-candidate</p><img alt="${xml(c.title)} · Light CC / Dark CC" src="${c.frames[c.posterIndex]}" data-frame="${c.posterIndex}"><button type="button">播放</button>${c.labels?` <select aria-label="选择视角">${c.labels.map((l,i)=>`<option value="${i}">${xml(l)}</option>`).join('')}</select>`:''}<span role="status" aria-live="polite"></span></section>`).join('')}<noscript>启用 JavaScript 可播放；静态图仍然可见。</noscript></main><script>
const clips=${data},reduced=matchMedia('(prefers-reduced-motion: reduce)');
for(const clip of clips){
 const card=document.querySelector('[data-clip="'+clip.id+'"]'),image=card.querySelector('img'),button=card.querySelector('button'),select=card.querySelector('select'),status=card.querySelector('[role=status]');
 let request=0,start=0,playing=false;
 const show=i=>{image.src=clip.frames[i];image.dataset.frame=String(i);if(select)select.value=String(i)};
 const stop=()=>{cancelAnimationFrame(request);playing=false;button.textContent='重播';card.dataset.playing='false'};
 const tick=now=>{const count=clip.playCount||clip.frames.length,sample=Math.floor(Math.max(0,now-start)*clip.fps/1000);show(clip.loop?sample%count:Math.min(sample,count-1));if(!clip.loop&&sample>=count){stop();status.textContent='已播完';return}request=requestAnimationFrame(tick)};
 button.addEventListener('click',async()=>{if(playing){stop();status.textContent='已暂停';return}if(reduced.matches){status.textContent='已启用减少动态，可查看静态图';return}button.disabled=true;try{await Promise.all(clip.frames.map(src=>{const i=new Image();i.src=src;return i.decode()}));if(document.hidden||reduced.matches){status.textContent='动态预览已暂停';return}show(0);start=performance.now();playing=true;card.dataset.playing='true';button.textContent='暂停';status.textContent='';request=requestAnimationFrame(tick)}catch{status.textContent='无法读取素材'}finally{button.disabled=false}});
 if(select)select.addEventListener('change',()=>{stop();show(Number(select.value))});
 document.addEventListener('visibilitychange',()=>{if(document.hidden&&playing)stop()});reduced.addEventListener('change',()=>{if(reduced.matches&&playing)stop()});
}
</script></html>\n`
}
