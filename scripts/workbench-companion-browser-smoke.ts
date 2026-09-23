/// <reference lib="dom" />
/**
 * Run: bun scripts/workbench-companion-browser-smoke.ts
 * Production index/CSS + companion/workbench modules → host proxy → internal
 * HTTP → real workbench/matters services → SQLite. The narrow mount harness
 * replaces application bootstrap, presence and chat history are fixtures, and
 * the executor is deterministic. This is browser integration, NOT native proof.
 * All work happens in disposable state/projects; screenshots remain in /tmp.
 */
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {randomUUID} from 'node:crypto'
import type {AgentProvider} from '../src/core/agent-provider'
import {MANAGED_NATIVE_CAPABILITIES} from '../src/core/workbench/executor-capabilities'

interface Locator {
  fill(text:string):Promise<void>;click():Promise<void>;inputValue():Promise<string>;count():Promise<number>
  selectOption(value:{label:string}):Promise<string[]>;textContent():Promise<string|null>
}
interface Page {
  goto(url:string):Promise<unknown>;locator(selector:string):Locator
  getByRole(role:string,options:{name:string;exact?:boolean}):Locator
  waitForFunction<T=void>(fn:(value:T)=>unknown,value?:T):Promise<unknown>
  evaluate<T>(fn:()=>T):Promise<T>;screenshot(options:{path:string}):Promise<Buffer>
  setViewportSize(size:{width:number;height:number}):Promise<void>;setDefaultTimeout(ms:number):void
  on(event:'pageerror',listener:(error:Error)=>void):void
}
interface Browser {newPage(options:{viewport:{width:number;height:number}}):Promise<Page>;close():Promise<void>}

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..'),src=join(repo,'apps/desktop/src')
const privateHistory='私人聊天：今晚只想休息，这句话不能成为项目要求。'
const request='请检查项目说明，整理一份可复核的修改建议。'
const draftA='A 项目原有未发送要求：保留安装说明。',draftB='B 项目原有未发送要求：检查图片目录。'
const submitted=`${draftA}\n\n—— 从聊天交办 ——\n${request}`
const nextChat='另一句尚未发送的私人聊天。'
function gate(){let release!:()=>void;const promise=new Promise<void>(done=>{release=done});return{promise,release}}
async function eventually(label:string,test:()=>boolean){const deadline=Date.now()+15_000;while(!test()){if(Date.now()>deadline)throw Error(`Timed out: ${label}`);await Bun.sleep(20)}}

// Reuse the actual index and production components. Only mounting and IPC host
// transport are supplied here; no workbench or care response is synthesized.
const harness=`
window.__TAURI__={core:{invoke:async(command,args)=>{
  if(command!=='workbench_api')throw Error('Unexpected IPC command: '+command);
  const res=await fetch(args.path,{method:args.method,...(args.method==='POST'?{headers:{'content-type':'application/json'},body:args.body??'{}'}:{})});
  const text=await res.text();if(!res.ok){let message='HTTP '+res.status;try{message=JSON.parse(text).error??message}catch{}throw Error(message)}return text;
}}};
const {invoke}=await import('/ipc.js');
const {invokeWorkbenchApi}=await import('/api.js');
const {initConversePage}=await import('/modules/converse.js');
const {initWorkbenchPage,stopWorkbenchPolling,openWorkbenchTask,openWorkbenchDraft}=await import('/modules/workbench.js');
const {chooseWorkbenchProject}=await import('/modules/workbench-entry.js');
const {mountCurrentActivity}=await import('/modules/cc-life.js');
const {mountCareSheet}=await import('/modules/cc-care.js');
const {createPresencePoller}=await import('/presence-poller.js');
const {createWorkbenchNavigation,isCurrentWorkbenchPane}=await import('/modules/workbench-navigation.js');
const navigation=createWorkbenchNavigation({shell:document.querySelector('.dash-window'),rail:document.getElementById('dash-global-rail'),toggle:document.getElementById('workbench-nav-toggle'),scrim:document.getElementById('workbench-nav-scrim')});
const presencePoller=createPresencePoller({invokeApi:async()=>await(await fetch('/__fixture/presence')).json(),intervalMs:1000});
const deps={invoke,invokeWorkbenchApi,pollMs:250,onDelegate:async text=>{
  const project=await chooseWorkbenchProject(invokeWorkbenchApi);if(!project)return false;
  switchPane('workbench');return openWorkbenchDraft({...project,text});
}};
function switchPane(name){
  const current=document.querySelector('.dash-pane[data-pane]:not([hidden])');
  if(isCurrentWorkbenchPane(name,current)){navigation.setWorkbenchActive(true);return}
  document.querySelectorAll('.dash-pane[data-pane]').forEach(el=>{el.hidden=el.dataset.pane!==name});
  document.querySelectorAll('.dash-nav-link[data-pane]').forEach(el=>el.classList.toggle('active',el.dataset.pane===name));
  navigation.setWorkbenchActive(name==='workbench');
  if(name==='workbench')initWorkbenchPage(deps);else stopWorkbenchPolling();
  if(name==='overview'){initConversePage(deps,{focus:false});void presencePoller.refresh()}
}
const sheet=mountCareSheet({call:invokeWorkbenchApi,presencePoller,navigate:switchPane,openWorkbench:()=>switchPane('workbench'),openTask:async id=>{switchPane('workbench');await openWorkbenchTask(id)}});
mountCurrentActivity(document.getElementById('cc-current-activity'),presencePoller,switchPane,()=>sheet.open());
document.querySelectorAll('.dash-nav-link[data-pane]').forEach(el=>el.addEventListener('click',()=>switchPane(el.dataset.pane)));
document.documentElement.dataset.mode='dashboard';
switchPane('overview');presencePoller.start();
window.addEventListener('pagehide',()=>{sheet.destroy();presencePoller.stop();stopWorkbenchPolling()});
`

async function main(){
  const temporary=realpathSync(mkdtempSync(join(tmpdir(),'cc-companion-browser-state-'))),evidence=realpathSync(mkdtempSync(join(tmpdir(),'cc-companion-browser-evidence-')))
  const stateDir=join(temporary,'state'),projectA=join(temporary,'project-a'),projectB=join(temporary,'project-b')
  for(const path of [stateDir,projectA,projectB])mkdirSync(path)
  process.env.WECHAT_STATE_DIR=stateDir;process.env.WECHAT_DISABLE_LOG_FILE='1'
  const [{openDb},{makeWorkbenchStore},{makeWorkbenchService},{createProviderRegistry},{createInternalApi},{createWorkbenchProxy},{makeMatterStore},{makeMattersService}]=await Promise.all([
    import('../src/lib/db'),import('../src/core/workbench/store'),import('../src/core/workbench/service'),import('../src/core/provider-registry'),import('../src/daemon/internal-api/index'),import('../apps/desktop/workbench-proxy'),import('../src/core/matters/store'),import('../src/core/matters/service'),
  ])
  const {chromium}=createRequire(join(repo,'apps/desktop/package.json'))('@playwright/test') as {chromium:{launch(options:{headless:boolean}):Promise<Browser>}}
  const hold=gate(),started:Array<{taskId:string,text:string}>=[]
  const provider:AgentProvider={async spawn(project){const taskId=project.alias.replace(/^workbench:/,''),sessionId=randomUUID();return{
    async *dispatch(text){started.push({taskId,text});yield{kind:'init',sessionId};yield{kind:'text',text:'已经收到这次交办，正在核对项目说明。'};await hold.promise;yield{kind:'result',sessionId,numTurns:1,durationMs:1}},
    async cancel(){hold.release()},async close(){hold.release()},
  }}}
  const registry=createProviderRegistry()
  registry.register('codex',provider,{workbench:MANAGED_NATIVE_CAPABILITIES,displayName:'Codex',canResume:()=>true})
  registry.register('claude',provider,{workbench:MANAGED_NATIVE_CAPABILITIES,displayName:'Claude',canResume:()=>true})
  const db=openDb({path:join(stateDir,'workbench.db')}),store=makeWorkbenchStore(db)
  const service=makeWorkbenchService({store,registry,stateDir,ownerChatId:()=>null})
  service.addProject({path:projectA,name:'说明整理',providerId:'codex'});service.addProject({path:projectB,name:'图片整理',providerId:'claude'})
  const matters=makeMattersService({store:makeMatterStore(db),workbench:service,chat:{ownerChatId:()=> 'fixture-owner',say:async()=>{throw Error('Chat must not be sent')},recent:async()=>[{kind:'user',text:privateHistory,createdAt:1},{kind:'text',text:'好，今天先慢下来。',createdAt:2}]}})
  const api=createInternalApi({stateDir,daemonPid:process.pid,workbench:service,matters,db})
  let host:ReturnType<typeof Bun.serve>|undefined,browser:Browser|undefined,page:Page|undefined,stage='start services'
  const pageErrors:string[]=[],httpErrors:string[]=[],requests:Array<{method:string,path:string,status:number}>=[],layouts:Array<{screen:string,width:number,documentWidth:number,viewport:number,overflowing:string[]}>=[]
  const draftSnapshots:Array<{stage:string,drafts:Record<string,unknown>}>=[]
  try{
    const info=await api.start();writeFileSync(join(stateDir,'internal-api-info.json'),JSON.stringify({baseUrl:`http://127.0.0.1:${info.port}`,operatorTokenFilePath:info.operatorTokenFilePath}),{mode:0o600})
    const operatorToken=readFileSync(info.operatorTokenFilePath,'utf8').trim()
    const proxy=createWorkbenchProxy({stateDir,dryRun:false,allowWrites:true}),csp=JSON.parse(readFileSync(join(src,'../src-tauri/tauri.conf.json'),'utf8')).app.security.csp as string
    const html=readFileSync(join(src,'index.html'),'utf8').replace('<script type="module" src="./animation-lab.js"></script>','').replace('<script type="module" src="./main.js"></script>','<script type="module" src="/harness.js"></script>')
    host=Bun.serve({hostname:'127.0.0.1',port:0,idleTimeout:30,async fetch(req){
      const url=new URL(req.url),path=url.pathname
      if(path==='/__fixture/presence')return Response.json({presence:'ok',activity:{kind:store.list().some(t=>t.status==='running')?'working':'idle',label:'',since:null},news:{unread:0,latest_kind:null,latest_title:null}})
      // The development workbench proxy intentionally only owns /workbench.
      // Host-forward the two read-only matter routes, as native IPC does; the
      // operator credential stays outside the renderer in both cases.
      const matterRead=req.method==='GET'&&['/v1/matters','/v1/matter/owner-chat'].includes(path)
      const response=matterRead?await fetch(`http://127.0.0.1:${info.port}${url.pathname}${url.search}`,{headers:{authorization:`Bearer ${operatorToken}`}}):await proxy(req)
      if(response){requests.push({method:req.method,path:url.pathname+url.search,status:response.status});if(response.status>=400)httpErrors.push(`${req.method} ${url.pathname+url.search}: ${await response.clone().text()}`);return response}
      if(path==='/')return new Response(html,{headers:{'content-type':'text/html','content-security-policy':csp}})
      if(path==='/harness.js')return new Response(harness,{headers:{'content-type':'text/javascript'}})
      const filename=resolve(src,'.'+path);if(!filename.startsWith(src+'/'))return new Response('Not found',{status:404})
      const file=Bun.file(filename);return await file.exists()?new Response(file):new Response('Not found',{status:404})
    }})
    browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(15_000);page.on('pageerror',error=>pageErrors.push(error.message))
    const captureDrafts=async(label:string)=>{draftSnapshots.push({stage:label,drafts:await page!.evaluate(()=>Object.fromEntries(Object.keys(sessionStorage).filter(key=>key.startsWith('cc.workbench.window.v1:draft:new:')).map(key=>[key,JSON.parse(sessionStorage.getItem(key)!)])))})}
    const checkLayout=async(screen:string)=>{
      for(const width of [1280,740]){
        await page!.setViewportSize({width,height:900})
        await page!.waitForFunction(()=>Array.from(document.images).filter(image=>image.getClientRects().length).every(image=>image.complete))
        const dimensions=await page!.evaluate(()=>({documentWidth:document.documentElement.scrollWidth,viewport:innerWidth,overflowing:[...document.querySelectorAll<HTMLElement>('.dash-pane:not([hidden]),dialog[open],dialog[open] .cc-care-body,dialog[open] .wb-entry-form,.dash-pane:not([hidden]) .converse-compose')].filter(el=>el.scrollWidth>el.clientWidth+1).map(el=>`${el.tagName}.${el.className}: ${el.scrollWidth}>${el.clientWidth}`)}))
        layouts.push({screen,width,...dimensions})
        await page!.screenshot({path:join(evidence,`${screen}-${width}.png`)})
        assert.ok(dimensions.documentWidth<=dimensions.viewport+1,`${screen} has page overflow at ${width}`)
        assert.deepEqual(dimensions.overflowing,[],`${screen} has component overflow at ${width}`)
      }
      await page!.setViewportSize({width:1280,height:900})
    }
    const home=async()=>{await page!.locator('#workbench-nav-toggle').click();await page!.locator('.dash-nav-link[data-pane="overview"]').click();await page!.waitForFunction(()=>!document.querySelector<HTMLElement>('.dash-pane[data-pane="overview"]')?.hidden)}
    const selectProject=async(path:string)=>{await page!.locator('#wb-entry-project').selectOption({label:`${path===projectA?'说明整理':'图片整理'} · ${path}`});await page!.locator('.wb-entry-dialog button[type=submit]').click()}
    stage='home and project draft isolation'
    await page.goto(`http://127.0.0.1:${host.port}`)
    await page.waitForFunction(text=>document.querySelector('#converse-scroll')?.textContent?.includes(text),privateHistory)
    await checkLayout('home')
    await page.locator('.dash-nav-link[data-pane="workbench"]').click()
    await page.locator(`[data-action="new-project-task"][data-project-path="${projectA}"]`).click();await page.locator('#wb-create-text').fill(draftA)
    await page.locator(`[data-action="new-project-task"][data-project-path="${projectB}"]`).click();await page.locator('#wb-create-text').fill(draftB)
    assert.equal(await page.locator('#wb-provider').inputValue(),'claude','B should start with its registered executor')
    await captureDrafts('B draft before leaving workbench')
    await home()
    stage='cancel project choice'
    await page.locator('#converse-input').fill(request);await page.locator('#converse-delegate').click()
    await page.waitForFunction(()=>!!document.querySelector('dialog.wb-entry-dialog[open]'))
    await checkLayout('project-chooser')
    await page.locator('[data-entry-cancel]').click()
    assert.equal(await page.locator('#converse-input').inputValue(),request)
    assert.equal(store.list().length,0);assert.equal(started.length,0)
    stage='prepare without execution'
    await page.locator('#converse-delegate').click();await selectProject(projectA)
    await page.waitForFunction(text=>document.querySelector<HTMLTextAreaElement>('#wb-create-text')?.value===text,submitted)
    assert.equal(await page.locator('#wb-path').inputValue(),projectA);assert.equal(await page.locator('#wb-provider').inputValue(),'codex')
    assert.equal(await page.locator('#converse-input').inputValue(),'')
    assert.equal(store.list().length,0);assert.equal(started.length,0)
    await captureDrafts('A handover prepared after workbench remount')
    await checkLayout('prepared-request')
    stage='explicit task creation'
    await page.getByRole('button',{name:'开始任务',exact:true}).click();await eventually('executor started once',()=>started.length===1)
    const task=store.get(started[0]!.taskId)
    assert.equal(task.path,projectA);assert.equal(task.providerId,'codex')
    assert.deepEqual(store.events(task.id).filter(e=>e.kind==='user').map(e=>e.text),[submitted])
    assert.ok(!started[0]!.text.includes(privateHistory));assert.ok(!started[0]!.text.includes(draftB))
    await home();await page.locator('#converse-input').fill(nextChat)
    stage='care sheet opens original task'
    await page.locator('.cc-care-avatar').click()
    await page.waitForFunction(id=>!!document.querySelector(`[data-care-task="${id}"]`),task.id)
    await checkLayout('care-sheet')
    assert.ok((await page.locator(`[data-care-task="${task.id}"]`).textContent())?.includes('说明整理'))
    await page.locator(`[data-care-task="${task.id}"]`).click()
    await page.waitForFunction(id=>Array.from(document.querySelectorAll('#wb-task-info code')).some(el=>el.textContent===id),task.id)
    assert.equal(await page.locator('.cc-care-sheet[open]').count(),0);assert.equal(store.list().length,1)
    await page.screenshot({path:join(evidence,'same-task-return-1280.png')})
    stage='unrelated drafts remain separate'
    await page.locator(`[data-action="new-project-task"][data-project-path="${projectB}"]`).click()
    await page.waitForFunction(text=>document.querySelector<HTMLTextAreaElement>('#wb-create-text')?.value===text,draftB)
    await captureDrafts('B draft after care-sheet round trip')
    assert.equal(await page.locator('#wb-provider').inputValue(),'claude')
    await home();assert.equal(await page.locator('#converse-input').inputValue(),nextChat)
    assert.ok((await page.locator('#converse-scroll').textContent())?.includes(privateHistory))
    hold.release();await eventually('fixture finishes',()=>store.get(task.id).status==='completed')
    assert.deepEqual(pageErrors,[]);assert.deepEqual(httpErrors,[])
    assert.equal(requests.filter(r=>r.method==='POST'&&r.path==='/v1/workbench/create').length,1)
    const report={ok:true,transport:'production index/CSS/modules + host proxy + internal HTTP + services + SQLite',bootstrap:'narrow fixture mount, not full main.js startup',executor:'deterministic fixture, not native proof',presenceAndChatHistory:'fixtures',cancelPreservesRequest:true,noExecutionBeforeExplicitStart:true,sameTaskInCareSheet:true,originalProjectDraftMerged:true,otherProjectAndChatDraftsPreserved:true,privateHistoryExcluded:true,taskId:task.id,layouts,evidence}
    writeFileSync(join(evidence,'report.json'),JSON.stringify(report,null,2)+'\n');writeFileSync(join(evidence,'requests.json'),JSON.stringify(requests,null,2)+'\n');console.log(JSON.stringify(report,null,2))
  }catch(error){await page?.screenshot({path:join(evidence,'failure.png')}).catch(()=>{});writeFileSync(join(evidence,'failure.json'),JSON.stringify({stage,error:String(error),pageErrors,httpErrors,layouts,draftSnapshots,requests},null,2));throw Error(`Companion browser smoke failed at ${stage}; ${evidence}`,{cause:error})}
  finally{hold.release();await browser?.close();await service.shutdown();host?.stop(true);await api.stop();db.close();rmSync(temporary,{recursive:true,force:true})}
}
await main()
