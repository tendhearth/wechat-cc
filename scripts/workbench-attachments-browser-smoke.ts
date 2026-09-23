import {MANAGED_NATIVE_CAPABILITIES} from '../src/core/workbench/executor-capabilities'
/// <reference lib="dom" />
/**
 * Run: bun scripts/workbench-attachments-browser-smoke.ts
 * Add --execution after the model service slice is integrated to also verify
 * lazy discovery, execution selection/observations, automatic restoration and
 * next-turn choice persistence and model-bound restart confirmation through the
 * same production transport.
 * Requires the desktop workspace's Playwright package and installed Chromium.
 * Exercises production browser modules -> workbench proxy -> internal HTTP ->
 * service -> SQLite/snapshot storage. Only AgentProvider execution is a fixture.
 * State and projects are temporary and removed; synthetic evidence stays in /tmp.
 */
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createRequire} from 'node:module'
import type {AgentAttachment,AgentProvider,AgentExecutionChoice} from '../src/core/agent-provider'

// Resolve the desktop dependency at runtime so this root script does not depend
// on Bun's versioned node_modules layout. Keep the used browser surface typed.
type FilePayload={name:string;mimeType:string;buffer:Buffer}
interface Locator {
  click():Promise<void>;fill(text:string):Promise<void>;selectOption(value:string):Promise<string[]>;waitFor():Promise<void>
  textContent():Promise<string|null>;inputValue():Promise<string>;count():Promise<number>
  evaluate<T>(fn:(element:HTMLElement,value:T)=>unknown,value:T):Promise<unknown>
}
interface Page {
  goto(url:string):Promise<unknown>;reload():Promise<unknown>
  locator(selector:string):Locator;getByRole(role:string,options?:{name:string;exact?:boolean}):Locator
  waitForFunction<T=void>(fn:(value:T)=>unknown,value?:T):Promise<unknown>
  waitForEvent(event:'filechooser'):Promise<{setFiles(files:FilePayload[]):Promise<void>}>
  waitForEvent(event:'download'):Promise<{suggestedFilename():string;saveAs(path:string):Promise<void>}>
  screenshot(options:{path:string}):Promise<Buffer>;setViewportSize(size:{width:number;height:number}):Promise<void>
  on(event:'pageerror',handler:(error:Error)=>void):void
}
interface Browser {newPage(options:{viewport:{width:number;height:number};acceptDownloads:boolean}):Promise<Page>;close():Promise<void>}

const executionChecks=process.argv.includes('--execution')
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const src=join(repo,'apps/desktop/src')
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=','base64')
const brief=Buffer.from('真实浏览器附件：请保留这份说明的原始字节。\n','utf8')
const followup=Buffer.from('Attachment-only continuation after switching tasks.\n')
const queued=Buffer.from('Durable queued attachment-only input.\n')
const sourceFiles=new Map([['reference.png',png],['brief.txt',brief],['followup.txt',followup],['queued.txt',queued]])

function gate(){let release!:()=>void;const promise=new Promise<void>(done=>{release=done});return{promise,release}}
async function eventually(label:string,check:()=>boolean,timeout=15_000){
  const deadline=Date.now()+timeout
  while(!check()){if(Date.now()>deadline)throw Error(`Timed out: ${label}`);await Bun.sleep(25)}
}
async function choose(page:Page,files:FilePayload[]){
  const opening=page.waitForEvent('filechooser')
  await page.getByRole('button',{name:'＋ 添加附件',exact:true}).click()
  await(await opening).setFiles(files)
}
async function readyFiles(page:Page,count:number){
  await page.waitForFunction(n=>document.querySelectorAll('.wb-compose-attachments [data-upload-status="ready"]').length===n||document.querySelector('.wb-compose-attachments [data-upload-status="failed"]'),count)
  assert.equal(await page.locator('.wb-compose-attachments [data-upload-status="failed"]').count(),0,'Upload failed; inspect HTTP error bodies in failure.json')
}
async function openSettings(page:Page,id:string){
  if(!await page.locator(id).evaluate(element=>element.hasAttribute('open'),undefined))await page.locator(id+' summary').click()
  await page.waitForFunction(()=>!!document.querySelector('#wb-model option[value="fixture-model-A"]'))
}
async function openTask(page:Page,id:string){
  await page.locator(`.wb-task[data-task-id="${id}"]`).click()
  // Navigation fetches the new detail before swapping the composer. Do not type
  // into the preceding task's still-visible editor while that fetch is pending.
  await page.waitForFunction(taskId=>Array.from(document.querySelectorAll('#wb-task-info code')).some(node=>node.textContent===taskId),id)
}

// This narrow IPC transport harness performs real HTTP requests. It does not
// substitute responses, upload storage, or service methods. The operator token
// is loaded only by the production host proxy and never enters browser JS.
const harness=`
window.__TAURI__={core:{invoke:async(command,args)=>{
  if(command!=='workbench_api')throw Error('Unexpected IPC command: '+command);
  const response=await fetch(args.path,{method:args.method,...(args.method==='POST'?{headers:{'content-type':'application/json'},body:args.body??'{}'}:{})});
  const text=await response.text();
  if(!response.ok){let message='HTTP '+response.status;try{message=JSON.parse(text).error??message}catch{}throw Error(message)}
  return text;
}}};
const {initWorkbenchPage}=await import('/modules/workbench.js');
const {invokeWorkbenchApi}=await import('/api.js');
initWorkbenchPage({invokeWorkbenchApi,pollMs:100});
`
const html='<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/styles/workbench.css"><style>*{box-sizing:border-box}body{margin:0;font-family:system-ui}#workbench-root{height:100vh}</style></head><body><div id="workbench-root"></div><script type="module" src="/harness.js"></script></body></html>'

async function main(){
  const temporary=realpathSync(mkdtempSync(join(tmpdir(),'cc-attachments-browser-state-')))
  const evidence=realpathSync(mkdtempSync(join(tmpdir(),'cc-attachments-browser-evidence-')))
  const stateDir=join(temporary,'state'),projectA=join(temporary,'project-a'),projectB=join(temporary,'project-b')
  for(const dir of [stateDir,projectA,projectB])mkdirSync(dir)
  // Set these before importing production modules whose log/config defaults are
  // captured at module load. Nothing reads or writes the user's real bot state.
  process.env.WECHAT_STATE_DIR=stateDir
  process.env.WECHAT_DISABLE_LOG_FILE='1'
  const [{openDb},{makeWorkbenchStore},{makeWorkbenchService},{createProviderRegistry},{createInternalApi},{createWorkbenchProxy}]=await Promise.all([
    import('../src/lib/db'),import('../src/core/workbench/store'),import('../src/core/workbench/service'),
    import('../src/core/provider-registry'),import('../src/daemon/internal-api/index'),
    import('../apps/desktop/workbench-proxy'),
  ])
  const {chromium}=createRequire(join(repo,'apps/desktop/package.json'))('@playwright/test') as {chromium:{launch(options:{headless:boolean}):Promise<Browser>}}
  type Captured={taskId:string,text:string,execution?:AgentExecutionChoice,attachments:Array<AgentAttachment&{fileBytes:Buffer,dataBytes?:Buffer}>}
  const captured:Captured[]=[],catalogProjects:string[]=[]
  let nextRunGate:ReturnType<typeof gate>|null=null,resumeAvailable=true
  let restartVerification:{tokenChanged:boolean;choice:AgentExecutionChoice}|undefined
  const activeGates=new Set<ReturnType<typeof gate>>()
  const provider:AgentProvider={...(executionChecks?{async modelCatalog(project:{path:string}){catalogProjects.push(project.path);return{source:'native' as const,models:[{id:'fixture-model-A',displayName:'Fixture A',reasoningEfforts:['low','deep']},{id:'fixture-model-B',displayName:'Fixture B',reasoningEfforts:['high']}]}}}:{}),async spawn(project,context){
    const sessionId=context.resumeSessionId??randomUUID(),taskId=project.alias.replace(/^workbench:/,'')
    return{
      async *dispatch(text,attachments){
        const hold=nextRunGate;nextRunGate=null;if(hold)activeGates.add(hold)
        captured.push({taskId,text,...(context.execution?{execution:structuredClone(context.execution)}:{}),attachments:(attachments??[]).map(a=>({...a,fileBytes:readFileSync(a.path),...(a.data?{dataBytes:Buffer.from(a.data,'base64')}:{})}))})
        yield{kind:'init',sessionId}
        if(executionChecks)context.reportExecution?.({model:'observed-'+(context.execution?.model??'automatic'),source:'native_response',sessionId})
        if(hold){await hold.promise;activeGates.delete(hold)}
        yield{kind:'text',text:`已收到 ${attachments?.length??0} 个附件，文件已进入真实任务记录。`}
        yield{kind:'result',sessionId,numTurns:1,durationMs:1}
      },
      async close(){for(const pending of activeGates)pending.release()},
    }
  }}
  const registry=createProviderRegistry();registry.register('claude',provider,{workbench:MANAGED_NATIVE_CAPABILITIES,displayName:'Claude fixture',canResume:()=>resumeAvailable})
  const dbPath=join(stateDir,'workbench.db');let db=openDb({path:dbPath})
  const store=makeWorkbenchStore(db)
  const service=makeWorkbenchService({store,registry,stateDir,ownerChatId:()=>null})
  const api=createInternalApi({stateDir,daemonPid:process.pid,workbench:service,db})
  let host:ReturnType<typeof Bun.serve>|undefined
  let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined
  let page:Page|undefined
  let delayedUpload:ReturnType<typeof gate>|null=null,uploadWaiting=false
  let stage='start services',serviceStopped=false,apiStopped=false
  const network:Array<{method:string,path:string,status:number;origin:string|null;requestOrigin:string;fetchSite:string|null;errorBody?:string;discardId?:string}>=[],pageErrors:string[]=[]
  try{
    const info=await api.start()
    writeFileSync(join(stateDir,'internal-api-info.json'),JSON.stringify({baseUrl:`http://127.0.0.1:${info.port}`,operatorTokenFilePath:info.operatorTokenFilePath}),{mode:0o600})
    const proxy=createWorkbenchProxy({stateDir,dryRun:false,allowWrites:true})
    const csp=JSON.parse(readFileSync(join(repo,'apps/desktop/src-tauri/tauri.conf.json'),'utf8')).app.security.csp as string
    host=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
      const path=new URL(request.url).pathname
      if(path==='/v1/workbench/attachment'&&request.method==='POST'&&delayedUpload){const pending=delayedUpload;uploadWaiting=true;await pending.promise;delayedUpload=null}
      const discarded=path==='/v1/workbench/discard-attachment'&&request.method==='POST'?await request.clone().json() as {id?:string}:null
      const proxied=await proxy(request)
      if(proxied){network.push({method:request.method,path,status:proxied.status,...(discarded?.id?{discardId:discarded.id}:{}),origin:request.headers.get('origin'),requestOrigin:new URL(request.url).origin,fetchSite:request.headers.get('sec-fetch-site'),...(proxied.status>=400?{errorBody:(await proxied.clone().text()).slice(0,2000)}:{})});return proxied}
      if(path==='/')return new Response(html,{headers:{'content-type':'text/html','content-security-policy':csp}})
      if(path==='/harness.js')return new Response(harness,{headers:{'content-type':'text/javascript'}})
      const filePath=resolve(src,'.'+path)
      if(!filePath.startsWith(src+'/'))return new Response('Not found',{status:404})
      const file=Bun.file(filePath);return await file.exists()?new Response(file):new Response('Not found',{status:404})
    }})
    browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1280,height:900},acceptDownloads:true})
    page.on('pageerror',error=>pageErrors.push(error.message))
    await page.goto(`http://127.0.0.1:${host.port}`)

    stage='browser upload and attachment-only new task'
    await page.locator('#wb-path').fill(projectA)
    if(executionChecks){
      assert.equal(catalogProjects.length,0,'Catalog discovery must be lazy')
      await openSettings(page,'#wb-options')
      await page.waitForFunction(()=>!!document.querySelector('#wb-model option[value="fixture-model-A"]'))
      await page.locator('#wb-model').selectOption('fixture-model-A');await page.locator('#wb-reasoning-effort').selectOption('deep')
      await page.screenshot({path:join(evidence,'create-execution-options.png')})
    }
    await choose(page,[{name:'reference.png',mimeType:'image/png',buffer:png},{name:'brief.txt',mimeType:'text/plain',buffer:brief}])
    await readyFiles(page,2)
    assert.equal(captured.length,0,'Choosing files must not dispatch a task')
    assert.equal(db.query<{n:number},[]>('SELECT COUNT(*) AS n FROM workbench_attachments WHERE task_id IS NULL').get()!.n,2)
    await page.getByRole('button',{name:'开始任务',exact:true}).click()
    await eventually('first task completed',()=>store.list().length===1&&store.list()[0]!.status==='completed')
    const taskA=store.list()[0]!
    await page.locator('form[data-action="continue"]').waitFor()
    const first=captured.find(c=>c.taskId===taskA.id)!
    if(executionChecks)assert.deepEqual(first.execution,{defaults:'provider',model:'fixture-model-A',reasoningEffort:'deep'})
    assert.equal(first.text,'');assert.deepEqual(first.attachments.map(a=>a.name),['reference.png','brief.txt'])
    for(const attachment of first.attachments){
      const original=sourceFiles.get(attachment.name)!
      assert.deepEqual(attachment.fileBytes,original)
      assert.equal(attachment.sha256,sha(original))
      if(attachment.mime==='image/png')assert.deepEqual(attachment.dataBytes,png,'Image pixels must reach AgentAttachment.data')
    }
    const originalMetadata=service.detail(taskA.id).events.find(e=>e.kind==='user')!.attachments!
    assert.deepEqual(originalMetadata.map(a=>a.sha256),[sha(png),sha(brief)])

    stage='real snapshot preview and download'
    const textAttachment=originalMetadata.find(a=>a.name==='brief.txt')!,imageAttachment=originalMetadata.find(a=>a.name==='reference.png')!
    await page.locator(`[data-action="preview-input-attachment"][data-attachment-id="${textAttachment.id}"]`).click()
    await page.getByRole('dialog').waitFor()
    assert.equal(await page.locator('.wb-input-preview-body pre').textContent(),brief.toString('utf8'))
    await page.screenshot({path:join(evidence,'text-preview.png')})
    await page.getByRole('button',{name:'关闭',exact:true}).click()
    await page.locator(`[data-action="preview-input-attachment"][data-attachment-id="${imageAttachment.id}"]`).click()
    await page.waitForFunction(()=>{const image=document.querySelector('.wb-input-preview-body img');return image instanceof HTMLImageElement&&image.complete&&image.naturalWidth===1})
    await page.getByRole('button',{name:'关闭',exact:true}).click()
    const downloading=page.waitForEvent('download')
    await page.locator(`[data-action="download-input-attachment"][data-attachment-id="${textAttachment.id}"]`).click()
    const download=await downloading;assert.equal(download.suggestedFilename(),'brief.txt')
    const downloaded=join(evidence,'downloaded-brief.txt');await download.saveAs(downloaded);assert.deepEqual(readFileSync(downloaded),brief)

    stage='second task and delayed upload scope'
    await page.getByRole('button',{name:'＋ 新建',exact:true}).click()
    await page.locator('#wb-path').fill(projectB);await page.locator('#wb-create-text').fill('第二项任务，用于验证附件草稿隔离。')
    if(executionChecks){
      await openSettings(page,'#wb-options');await eventually('project B catalog',()=>catalogProjects.includes(projectB))
      await page.locator('#wb-model').selectOption('fixture-model-B');await page.locator('#wb-reasoning-effort').selectOption('high')
    }
    await page.getByRole('button',{name:'开始任务',exact:true}).click()
    await eventually('second task completed',()=>store.list().length===2&&store.list().every(t=>t.status==='completed'))
    const taskB=store.list().find(t=>t.id!==taskA.id)!
    if(executionChecks)assert.deepEqual(captured.find(c=>c.taskId===taskB.id)!.execution,{defaults:'provider',model:'fixture-model-B',reasoningEffort:'high'})
    await openTask(page,taskA.id)
    await page.locator('form[data-action="continue"]').waitFor()
    delayedUpload=gate();uploadWaiting=false
    await choose(page,[{name:'followup.txt',mimeType:'text/plain',buffer:followup}])
    await eventually('upload held at host transport',()=>uploadWaiting)
    await openTask(page,taskB.id)
    await page.locator('#wb-followup-text').fill('保留 B 的草稿')
    delayedUpload.release()
    await eventually('late upload reached SQLite',()=>db.query<{n:number},[string]>('SELECT COUNT(*) AS n FROM workbench_attachments WHERE name=?').get('followup.txt')!.n===1)
    assert.equal(await page.locator('.wb-compose-attachments .wb-attachment-chip').count(),0)
    assert.equal(await page.locator('#wb-followup-text').inputValue(),'保留 B 的草稿')
    assert.equal(service.detail(taskB.id).attachments.length,0)
    await openTask(page,taskA.id);await readyFiles(page,1)
    if(executionChecks){
      await openSettings(page,'#wb-task-info')
      assert.equal(await page.locator('#wb-model').inputValue(),'fixture-model-A')
      assert((await page.locator('.wb-execution-observation').textContent())?.includes('observed-fixture-model-A'))
      assert((await page.locator('.wb-execution-observation').textContent())?.includes('思考强度未报告'))
      await page.locator('#wb-model').selectOption('')
    }
    await page.reload();await readyFiles(page,1)
    if(executionChecks){
      assert.equal(await page.locator('#wb-model').inputValue(),'');assert.equal(await page.locator('#wb-reasoning-effort').inputValue(),'')
      await openSettings(page,'#wb-task-info')
      await page.locator('.wb-task-info-body').evaluate(element=>{element.scrollTop=element.scrollHeight},undefined)
      await page.screenshot({path:join(evidence,'task-execution-options.png')})
      await page.locator('#wb-task-info summary').click()
    }
    assert.equal(await page.locator('#wb-followup-text').inputValue(),'')
    await page.getByRole('button',{name:'继续',exact:true}).click()
    await eventually('attachment-only continuation dispatch',()=>captured.filter(c=>c.taskId===taskA.id).length===2&&store.get(taskA.id).status==='completed')
    const continued=captured.filter(c=>c.taskId===taskA.id)[1]!
    if(executionChecks)assert.deepEqual(continued.execution,{defaults:'provider',model:null,reasoningEffort:null})
    assert.equal(continued.text,'');assert.deepEqual(continued.attachments[0]!.fileBytes,followup);assert.equal(continued.attachments[0]!.sha256,sha(followup))

    stage='real durable queued input'
    const liveGate=gate();nextRunGate=liveGate
    await page.locator('form[data-action="continue"]').waitFor()
    await page.locator('#wb-followup-text').fill('等待本轮正常结束后接收补充附件。')
    await page.getByRole('button',{name:'继续',exact:true}).click()
    await page.locator('form[data-action="send-input"]').waitFor()
    const originalRunId=service.detail(taskA.id).runId!
    if(executionChecks){assert.equal(await page.locator('#wb-model').evaluate(element=>element.hasAttribute('disabled'),undefined),true);assert.equal(await page.locator('#wb-reasoning-effort').evaluate(element=>element.hasAttribute('disabled'),undefined),true)}
    await page.locator('#wb-followup-text').evaluate((element,text)=>{
      const transfer=new DataTransfer();transfer.items.add(new File([text],'queued.txt',{type:'text/plain'}))
      element.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,clipboardData:transfer}))
    },queued.toString('utf8'))
    await readyFiles(page,1)
    assert.equal(await page.locator('#wb-followup-text').inputValue(),'')
    await page.locator('form[data-action="send-input"] button[type="submit"]').click()
    await eventually('durable pending input',()=>service.detail(taskA.id).inputs.some(input=>input.status==='pending'))
    const receipt=service.detail(taskA.id).inputs.find(input=>input.status==='pending')!
    assert.equal(receipt.text,'');assert.equal(receipt.runId,originalRunId);assert.equal(receipt.attachments![0]!.sha256,sha(queued))
    await page.screenshot({path:join(evidence,'queued-input.png')})
    liveGate.release()
    await eventually('queued input delivered',()=>store.liveInputs.get(receipt.id)?.status==='delivered'&&store.get(taskA.id).status==='completed')
    const last=captured.filter(c=>c.taskId===taskA.id).at(-1)!
    assert.equal(last.text,'');assert.deepEqual(last.attachments[0]!.fileBytes,queued)
    assert.equal(store.liveInputs.get(receipt.id)!.runId,originalRunId)
    if(executionChecks)assert.deepEqual(last.execution,continued.execution)
    assert.notEqual(store.events(taskA.id).filter(e=>e.kind==='user').at(-1)!.runId,originalRunId)
    if(executionChecks){
      stage='model-bound ordinary restart preview and dispatch'
      resumeAvailable=false
      await page.waitForFunction(()=>!!document.querySelector('form[data-action="restart"][data-restart-token]'))
      const previousToken=await page.locator('form[data-action="restart"]').evaluate(element=>element.dataset.restartToken,undefined)
      assert.equal(typeof previousToken,'string')
      await openSettings(page,'#wb-task-info')
      await page.locator('#wb-model').selectOption('fixture-model-B');await page.locator('#wb-reasoning-effort').selectOption('high')
      await page.locator('#wb-task-info summary').click()
      await page.waitForFunction(old=>{const form=document.querySelector('form[data-action="restart"]');return form instanceof HTMLElement&&!!form.dataset.restartToken&&form.dataset.restartToken!==old&&!form.querySelector('button[type="submit"]:disabled')},previousToken)
      const nextToken=await page.locator('form[data-action="restart"]').evaluate(element=>element.dataset.restartToken,undefined)
      assert.notEqual(nextToken,previousToken)
      await page.locator('#wb-followup-text').fill('使用本次选择和已确认的记录，重新开始下一轮。')
      await page.screenshot({path:join(evidence,'restart-execution-preview.png')})
      const beforeRestart=captured.length
      await page.getByRole('button',{name:'带这些记录新开一轮',exact:true}).click()
      await eventually('selected restart completed',()=>captured.length===beforeRestart+1&&store.get(taskA.id).status==='completed')
      const choice={defaults:'provider' as const,model:'fixture-model-B',reasoningEffort:'high'}
      assert.deepEqual(captured.at(-1)!.execution,choice)
      restartVerification={tokenChanged:nextToken!==previousToken,choice}
      resumeAvailable=true
      await page.locator('form[data-action="continue"]').waitFor()
    }
    for(const width of [1280,760,430]){
      await page.setViewportSize({width,height:900})
      if(executionChecks){
        await openSettings(page,'#wb-task-info');await page.locator('.wb-task-info-body').evaluate(element=>{element.scrollTop=element.scrollHeight},undefined)
        await page.screenshot({path:join(evidence,`task-options-${width}.png`)})
        await page.locator('#wb-task-info summary').click()
      }
      await page.screenshot({path:join(evidence,`workbench-${width}.png`)})
    }
    assert.deepEqual(pageErrors,[])
    assert(network.some(n=>n.path==='/v1/workbench/attachment'&&n.method==='POST'&&n.status===200))
    assert(network.some(n=>n.path==='/v1/workbench/input'&&n.status===200))
    // A receipt can clear the draft before the send's finally block releases its
    // reservation. The resulting best-effort discard must be refused for a bound
    // attachment. Accept only that precise response, then prove the same ID and
    // immutable bytes remain owned by a task; all other HTTP failures still fail.
    const refusedDiscards=network.filter(n=>n.method==='POST'&&n.path==='/v1/workbench/discard-attachment'&&n.status===404&&n.discardId&&n.errorBody&&JSON.parse(n.errorBody).error==='not_found')
    for(const request of refusedDiscards){
      const owner=store.list().find(task=>store.attachments.list(task.id).some(a=>a.id===request.discardId))
      assert(owner,'Refused discard must leave its attachment task-owned')
      const read=store.attachments.read(owner.id,request.discardId!,stateDir),bytes=Buffer.from(read.base64,'base64')
      assert.deepEqual(bytes,sourceFiles.get(read.attachment.name));assert.equal(sha(bytes),read.attachment.sha256)
    }
    const failures=network.filter(n=>n.status>=400&&!refusedDiscards.includes(n))
    assert.equal(failures.length,0,`Unexpected HTTP error: ${JSON.stringify(failures)}`)

    stage='SQLite reopen and persisted snapshots'
    await browser.close();browser=undefined
    await service.shutdown();serviceStopped=true
    host.stop(true);host=undefined
    await api.stop();apiStopped=true
    db.close();db=openDb({path:dbPath})
    const restored=makeWorkbenchStore(db)
    assert.equal(restored.liveInputs.get(receipt.id)!.status,'delivered')
    assert.equal(restored.liveInputs.get(receipt.id)!.runId,originalRunId)
    if(executionChecks){assert.equal(restored.execution.choice(taskA.id).model,'fixture-model-B');assert.equal(restored.execution.choice(taskA.id).reasoningEffort,'high');assert.equal(restored.execution.choice(taskB.id).model,'fixture-model-B');assert.equal(restored.execution.last(taskA.id)?.effective?.model,'observed-fixture-model-B')}
    const persisted=restored.events(taskA.id).flatMap(e=>e.attachments??[])
    assert.deepEqual(persisted.map(a=>a.name),['reference.png','brief.txt','followup.txt','queued.txt'])
    for(const attachment of persisted){
      const read=restored.attachments.read(taskA.id,attachment.id,stateDir),bytes=Buffer.from(read.base64,'base64')
      assert.deepEqual(bytes,sourceFiles.get(attachment.name));assert.equal(sha(bytes),attachment.sha256)
    }
    const report={ok:true,executionChecks,...(executionChecks?{catalogProjects,executionChoices:captured.map(c=>c.execution),restartVerification}:{}),transport:'production browser API + browser proxy + internal HTTP',execution:'fixture AgentProvider only',taskCount:restored.list().length,dispatchCount:captured.length,attachmentHashes:Object.fromEntries([...sourceFiles].map(([name,bytes])=>[name,sha(bytes)])),queuedReceipt:{id:receipt.id,runId:originalRunId,status:'delivered'},databaseReopened:true,refusedClaimedDiscards:refusedDiscards.length,evidenceDirectory:evidence}
    writeFileSync(join(evidence,'report.json'),JSON.stringify(report,null,2)+'\n')
    console.log(JSON.stringify(report,null,2))
  }catch(error){
    await page?.screenshot({path:join(evidence,'failure.png')}).catch(()=>{})
    writeFileSync(join(evidence,'failure.json'),JSON.stringify({stage,error:String(error),network,pageErrors},null,2)+'\n')
    throw new Error(`Browser attachment smoke failed at ${stage}; evidence: ${evidence}`,{cause:error})
  }finally{
    delayedUpload?.release();nextRunGate?.release();for(const pending of activeGates)pending.release()
    await browser?.close()
    if(!serviceStopped)await service.shutdown()
    host?.stop(true)
    if(!apiStopped)await api.stop()
    db.close();rmSync(temporary,{recursive:true,force:true})
  }
}

await main()
