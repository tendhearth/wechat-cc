import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { validateTurnaroundStudy, sha256 } from './validate-cc-turnaround-studies.mjs'
import { freshOutput, raster, SIZES, contactSheet, pairedFrame, saveSheet, previewHtml } from './cc-study-review.mjs'
const desktop=fileURLToPath(new URL('../',import.meta.url))
export async function buildTurnaroundReview({studyPath,outputPath}){
  const root=await realpath(studyPath),out=await freshOutput(outputPath,[root,join(desktop,'src/assets/pet'),join(desktop,'art/cc-v1/cc-v1.blend')])
  const validation=await validateTurnaroundStudy({studyPath:root}),index=JSON.parse(await readFile(join(root,'index.json'))),sharp=raster()
  const frames=[]
  for(const view of index.identity.recipe)frames.push(await Promise.all(index.views[view.id].paths.slice(0,2).map(async p=>{const bytes=await readFile(join(root,p));if(sha256(bytes)!==index.views[view.id].files[p])throw Error('validated input changed before review');return bytes})))
  const sheets=[],previews=[];await mkdir(out,{recursive:true})
  for(let group=0;group<5;group++)for(const size of SIZES)sheets.push(await saveSheet(out,`views-${group+1}-${size}px.png`,await contactSheet(sharp,frames.slice(group*4,group*4+4),index.identity.recipe.slice(group*4,group*4+4).map(v=>v.label),size)))
  for(const pair of frames)previews.push(`data:image/png;base64,${(await pairedFrame(sharp,pair)).toString('base64')}`)
  await writeFile(join(out,'index.html'),previewHtml([{id:'orbit',title:'转面与抬头 · 水平环绕按需播放',fps:8,loop:true,posterIndex:0,playCount:16,frames:previews,labels:index.identity.recipe.map(v=>v.label)}],'CC · 转面素材'))
  const summary={...validation,tools:sharp.versions,sizes:SIZES,backgrounds:['paper','slate'],sheets,playback:'Only 16 horizontal views orbit; four raised views are manual stills.',canonical:'Existing canonical bytes are unchanged and excluded from new-view counts.'}
  await writeFile(join(out,'summary.json'),JSON.stringify(summary,null,2)+'\n');return summary
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)buildTurnaroundReview({studyPath:process.argv[2],outputPath:process.argv[3]}).then(r=>console.log(JSON.stringify({pairCount:r.pairCount,sheets:r.sheets.length}))).catch(e=>{console.error(e.stack);process.exitCode=1})
