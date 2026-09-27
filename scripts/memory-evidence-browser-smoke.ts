/// <reference lib="dom" />
/**
 * bun scripts/memory-evidence-browser-smoke.ts
 * Production memory UI/CSS/API helper → real internal HTTP → temporary SQLite
 * and memory files. Deterministic model text; no live user data or native proof.
 */
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..'),src=join(repo,'apps/desktop/src')
const harness=`
async function request(method,path,body){const res=await fetch(path,{method,...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});const data=await res.json();if(!res.ok)throw Error(data.error||('HTTP '+res.status));return data}
window.__TAURI__={core:{invoke:async(command,args)=>{
 if(command==='wechat_cli_json')return request('POST','/__fixture/cli',args);
 throw Error('Unexpected IPC '+command);
}}};
const {invoke}=await import('/ipc.js');const {invokeApi}=await import('/api.js');
const {wireMemoryButtons,loadMemoryPane,loadMemoryTopZone,generateMemoryProfile}=await import('/modules/memory.js');
const deps={invoke,invokeApi,formatInvokeError:err=>String(err),doctorPoller:{current:{userNames:{owner:'你'}}}};
document.documentElement.dataset.mode='dashboard';
document.querySelectorAll('.dash-pane[data-pane]').forEach(el=>{el.hidden=el.dataset.pane!=='memory'});
document.querySelectorAll('.dash-nav-link[data-pane]').forEach(el=>el.classList.toggle('active',el.dataset.pane==='memory'));
wireMemoryButtons(deps);document.getElementById('memory-profile-content').addEventListener('click',async event=>{const button=event.target.closest('#memory-profile-generate-quick');if(!button)return;button.disabled=true;try{await generateMemoryProfile(deps)}finally{button.disabled=false}});await loadMemoryPane(deps);await loadMemoryTopZone(deps);
window.__memoryReady=true;
`
async function main(){
 const temporary=realpathSync(mkdtempSync(join(tmpdir(),'cc-memory-browser-state-'))),evidence=realpathSync(mkdtempSync(join(tmpdir(),'cc-memory-browser-evidence-')))
 const stateDir=join(temporary,'state'),root=join(stateDir,'memory','owner'),projectsRoot=join(temporary,'projects')
 mkdirSync(root,{recursive:true});mkdirSync(projectsRoot)
 process.env.WECHAT_STATE_DIR=stateDir;process.env.WECHAT_DISABLE_LOG_FILE='1'
 const [{openDb},{makeObservationsStore},{makeMilestonesStore},{makeLifeStoresReader},{createInternalApi},memory,synthesis,derived,{makeMemoryFS}]=await Promise.all([
 import('../src/lib/db'),import('../src/daemon/observations/store'),import('../src/daemon/milestones/store'),import('../src/daemon/life-stores'),import('../src/daemon/internal-api'),import('../src/lib/memory'),import('../src/lib/memory-synthesis'),import('../src/lib/memory-derived-state'),import('../src/daemon/memory/fs-api')])
 const db=openDb({path:join(stateDir,'memory.db')}),observations=makeObservationsStore(db,'owner'),milestones=makeMilestonesStore(db,'owner'),lifeStores=makeLifeStoresReader(db,stateDir)
 const initial='你平时喜欢晚上集中工作。',correction='你现在喜欢早晨集中工作，晚上留给休息。'
 writeFileSync(join(root,'rhythm.md'),initial);writeFileSync(join(root,'projects.md'),'你正在整理 CC 工作台。');writeFileSync(join(root,'reading.md'),'你喜欢简洁的说明和可核对的来源。');writeFileSync(join(root,'_overview.md'),'过时的总结：晚上才工作。')
 const obsId=await observations.append({body:'你总是深夜工作。',tone:'curious'})
 await milestones.fire({id:'first_project',body:'你完成了第一版工作台。'})
 const generation={stateDir,adminChatId:'owner',projectsRoot,lifeStores,sdkEval:async(prompt:string)=>{
   const refs=[...prompt.matchAll(/【依据 (e_[a-f0-9]+)】([^\n]+)\n/g)].map(m=>({id:m[1]!,label:m[2]!}))
   const note=refs.find(ref=>ref.label==='rhythm.md'),obs=refs.find(ref=>ref.label.startsWith('观察：'))
   return JSON.stringify({insight:'你希望做事时能专心，也给生活留一些空白。',summary:'这里的理解来自你的记忆与观察，可以随时核对并改正。',tags:['重视专注'],traits:[{title:'作息节奏',body:readFileSync(join(root,'rhythm.md'),'utf8'),sourceRefs:note?[note.id]:[]}],preferences:obs?[{title:'最近的观察',body:'最近记录过你的工作时间。',sourceRefs:[obs.id]}]:[],rememberedEvents:[]})
 }}
 await synthesis.synthesizeProfile(generation)
 const api=createInternalApi({stateDir,daemonPid:process.pid,db,resolveAdminChatId:()=> 'owner',memoryProjectsRoot:projectsRoot,memoryLlm:{
  synthesize:async()=>synthesis.synthesizeOverview({...generation,sdkEval:async()=>readFileSync(join(root,'rhythm.md'),'utf8')}),generateProfile:async()=>synthesis.synthesizeProfile(generation),generatePortrait:async()=>({ok:false,error:'fixture_no_portrait'}),
 }})
 const {chromium}=createRequire(join(repo,'apps/desktop/package.json'))('@playwright/test')
 let host:ReturnType<typeof Bun.serve>|undefined,browser:any,page:any,stage='start'
 const pageErrors:string[]=[],requests:Array<{method:string,path:string,status:number}>=[],layouts:Array<Record<string,unknown>>=[]
 try{
  const info=await api.start();writeFileSync(join(stateDir,'internal-api-info.json'),JSON.stringify({baseUrl:`http://127.0.0.1:${info.port}`,operatorTokenFilePath:info.operatorTokenFilePath}),{mode:0o600})
  const token=readFileSync(info.tokenFilePath,'utf8').trim()
  const html=readFileSync(join(src,'index.html'),'utf8').replace('<script type="module" src="./animation-lab.js"></script>','').replace('<script type="module" src="./main.js"></script>','<script type="module" src="/harness.js"></script>')
  const cli=async(args:string[])=>{
   if(args[0]==='daemon'&&args[1]==='api-info')return {ok:true,baseUrl:`http://127.0.0.1:${host!.port}`,token:'fixture-local-renderer'}
   if(args[0]==='memory'&&args[1]==='list')return memory.listAllMemory(stateDir)
   if(args[0]==='memory'&&args[1]==='read')return {ok:true,content:memory.readMemoryFile(stateDir,args[2]!,args[3]!)}
   if(args[0]==='memory'&&args[1]==='profile-read')return {ok:true,content:memory.readMemoryProfileFile(stateDir,'owner')}
   if(args[0]==='memory'&&args[1]==='profile'&&args[2]==='status')return {ok:true,...await synthesis.getMemoryProfileStatus(generation)}
   if(args[0]==='observations'&&args[1]==='list')return {observations:await observations.listActive()}
   if(args[0]==='milestones'&&args[1]==='list')return {milestones:await milestones.list()}
   throw Error('Unexpected CLI fixture '+JSON.stringify(args))
  }
  host=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
   const url=new URL(req.url),path=url.pathname
   if(path==='/__fixture/cli'){try{return Response.json(await cli((await req.json()).args))}catch(e){return Response.json({error:String(e)},{status:500})}}
   let response:Response|undefined
   if(path.startsWith('/v1/memory/'))response=await fetch(`http://127.0.0.1:${info.port}${path}${url.search}`,{method:req.method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(req.method==='POST'?{body:await req.text()||'{}'}:{})})
   if(response){requests.push({method:req.method,path:path+url.search,status:response.status});return response}
   if(path==='/')return new Response(html,{headers:{'content-type':'text/html'}})
   if(path==='/harness.js')return new Response(harness,{headers:{'content-type':'text/javascript'}})
   const filename=resolve(src,'.'+path);if(!filename.startsWith(src+'/'))return new Response('Not found',{status:404})
   const file=Bun.file(filename);return await file.exists()?new Response(file):new Response('Not found',{status:404})
  }})
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(10_000);page.on('pageerror',(e:Error)=>pageErrors.push(e.message))
  const capture=async(name:string,widths=[1280,740])=>{for(const width of widths){await page.setViewportSize({width,height:900});const size=await page.evaluate(()=>({viewport:innerWidth,page:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll<HTMLElement>('dialog[open], dialog[open] .memory-evidence-reader')].filter(el=>el.scrollWidth>el.clientWidth+1).map(el=>el.className)}));layouts.push({screen:name,width,...size});await page.screenshot({path:join(evidence,`${name}-${width}.png`)});assert.equal(size.overflow.length,0,`${name} component overflow ${width}`);assert.ok(size.page<=size.viewport+1,`${name} page overflow ${width}`)}await page.setViewportSize({width:1280,height:900})}
  stage='profile evidence';await page.goto(`http://127.0.0.1:${host.port}`);await page.waitForFunction(()=>Boolean((window as any).__memoryReady))
  await page.locator('[data-memory-evidence]').first().waitFor();const target=await page.locator('[data-memory-evidence]').first().evaluate((el:HTMLElement)=>({font:Number.parseFloat(getComputedStyle(el).fontSize),scale:Number.parseFloat(getComputedStyle(document.querySelector('#memory-artboard')!).getPropertyValue('--memory-artboard-scale'))||1}));assert.ok(target.font*target.scale>=11,'evidence label stays readable');await capture('profile')
  await page.locator('[data-memory-evidence]').first().click();await page.waitForFunction((text:string)=>(document.querySelector('#memory-evidence-text') as HTMLTextAreaElement)?.value===text,initial)
  await capture('evidence',[1280,740,390])
  stage='real correction';await page.locator('#memory-evidence-text').fill(correction);await page.locator('[data-evidence-save]').click();await page.waitForFunction(()=>!document.querySelector('dialog.memory-evidence-dialog[open]'))
  assert.equal(readFileSync(join(root,'rhythm.md'),'utf8'),correction);assert.equal(derived.isDerivedMemoryStale(root,'profile'),true);assert.equal(derived.isDerivedMemoryStale(root,'overview'),true)
  assert.equal(await makeMemoryFS({rootDir:root}).read('_overview.md'),null)
  await page.waitForFunction(()=>Boolean(document.querySelector('#memory-profile-content')?.textContent?.includes('待更新')));await capture('corrected')
  stage='revision conflict';await page.locator('[data-memory-evidence]').first().click();await page.waitForFunction((text:string)=>(document.querySelector('#memory-evidence-text') as HTMLTextAreaElement)?.value===text,correction)
  await page.locator('#memory-evidence-text').fill('这个草稿应保留。');writeFileSync(join(root,'rhythm.md'),correction+'外部补充：每周一除外。')
  await page.locator('[data-evidence-save]').click();await page.waitForFunction(()=>Boolean(document.querySelector('.memory-evidence-error')?.textContent?.includes('来源已变化')))
  assert.equal(await page.locator('#memory-evidence-text').inputValue(),'这个草稿应保留。');await capture('conflict')
  await page.locator('[data-evidence-refresh]').click();await page.waitForFunction(()=>Boolean(document.querySelector('#memory-evidence-original')?.textContent?.includes('每周一除外')))
  assert.equal(await page.locator('#memory-evidence-text').inputValue(),'这个草稿应保留。');await capture('latest-source',[1280,740,390])
  await page.locator('[data-evidence-rebase]').click();await page.locator('#memory-evidence-text').fill(correction+'每周一可以灵活安排。');await page.locator('[data-evidence-save]').click();await page.waitForFunction(()=>!document.querySelector('dialog.memory-evidence-dialog[open]'))
  assert.equal(readFileSync(join(root,'rhythm.md'),'utf8'),correction+'每周一可以灵活安排。')
  stage='discard stays discarded';await page.locator('[data-memory-evidence]').first().click();await page.waitForFunction(()=>!(document.querySelector('#memory-evidence-text') as HTMLTextAreaElement)?.hidden)
  await page.locator('#memory-evidence-text').fill('要放弃的草稿');await page.locator('[data-evidence-close]').click();await page.locator('[data-evidence-leave="discard"]').click()
  await page.locator('[data-memory-evidence]').first().click();await page.waitForFunction((text:string)=>(document.querySelector('#memory-evidence-text') as HTMLTextAreaElement)?.value===text,correction+'每周一可以灵活安排。');await page.locator('[data-evidence-close]').click()
  stage='outdated observation';await page.locator('[data-memory-evidence]').nth(1).click();await page.waitForFunction(()=>!(document.querySelector('[data-evidence-outdated]') as HTMLButtonElement)?.disabled)
  await page.locator('[data-evidence-outdated]').click();await page.waitForFunction(()=>!document.querySelector('dialog.memory-evidence-dialog[open]'))
  assert.equal((await observations.listActive()).length,0);assert.equal((await observations.listArchived())[0]?.id,obsId)
  stage='regenerated profile';await page.getByRole('button',{name:'更新画像',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#memory-profile-content')?.textContent?.includes('待更新'))
  assert.equal(derived.isDerivedMemoryStale(root,'profile'),false);assert.equal(derived.isDerivedMemoryStale(root,'overview'),true)
  const profile=JSON.parse(memory.readMemoryProfileFile(stateDir,'owner'));assert.equal(profile.preferences.length,0);assert.ok(profile.traits[0].body.includes('早晨'))
  await capture('regenerated');assert.deepEqual(pageErrors,[])
  const report={ok:true,evidence,bootstrap:'production memory modules mounted on production index/CSS',backend:'real HTTP routes, SQLite and files in temporary state; fixture mount and host transport',model:'deterministic fixture',native:false,correctsRealSource:true,preservesConflictDraft:true,conflictCanBeReconciled:true,discardedDraftStaysDiscarded:true,archivesObservation:true,staleOverviewExcluded:true,regeneratedProfileUsesCurrentSources:true,layouts,requests}
  writeFileSync(join(evidence,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
 }catch(error){await page?.screenshot({path:join(evidence,'failure.png')}).catch(()=>{});writeFileSync(join(evidence,'failure.json'),JSON.stringify({stage,error:String(error),pageErrors,requests,layouts},null,2));throw Error(`Memory evidence smoke failed at ${stage}; ${evidence}`,{cause:error})}
 finally{await browser?.close();host?.stop(true);await api.stop();db.close();rmSync(temporary,{recursive:true,force:true})}
}
await main()
