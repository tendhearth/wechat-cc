import {MANAGED_NATIVE_CAPABILITIES} from '../src/core/workbench/executor-capabilities'
/// <reference lib="dom" />
/** Production desktop modules → host proxy → internal HTTP → service → SQLite.
 * Native execution alone is a deterministic fixture; this is not native proof.
 * Run: bun scripts/workbench-background-browser-smoke.ts
 */
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {randomUUID} from 'node:crypto'
import type {AgentEvent,AgentProvider,AgentRuntimeSnapshot} from '../src/core/agent-provider'

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..'),src=join(repo,'apps/desktop/src')
interface Locator {fill(text:string):Promise<void>;click():Promise<void>;count():Promise<number>;textContent():Promise<string|null>}
interface Page {
  goto(url:string):Promise<unknown>;locator(selector:string):Locator;getByRole(role:string,options:{name:string;exact?:boolean}):Locator
  waitForFunction<T=void>(fn:(value:T)=>unknown,value?:T):Promise<unknown>;screenshot(options:{path:string}):Promise<Buffer>
  on(event:'pageerror',listener:(error:Error)=>void):void;setViewportSize(value:{width:number;height:number}):Promise<void>
}
interface Browser {newPage(options:{viewport:{width:number;height:number}}):Promise<Page>;close():Promise<void>}
function gate(){let release!:()=>void;const promise=new Promise<void>(done=>{release=done});return{promise,release}}
function channel(){
  const values:AgentEvent[]=[];let ended=false,wake=gate()
  return{
    push(value:AgentEvent){values.push(value);wake.release();wake=gate()},
    end(){ended=true;wake.release()},
    async *events(){while(!ended||values.length){if(values.length)yield values.shift()!;else await wake.promise}},
  }
}
async function eventually(test:()=>boolean){const deadline=Date.now()+10_000;while(!test()){if(Date.now()>deadline)throw Error('fixture deadline');await Bun.sleep(20)}}
const harness=`window.__TAURI__={core:{invoke:async(command,args)=>{
if(command!=='workbench_api')throw Error(command);const res=await fetch(args.path,{method:args.method,...(args.method==='POST'?{headers:{'content-type':'application/json'},body:args.body??'{}'}:{})});
const body=await res.text();if(!res.ok)throw Error(body);return body;
}}};const {initWorkbenchPage}=await import('/modules/workbench.js');const {invokeWorkbenchApi}=await import('/api.js');initWorkbenchPage({invokeWorkbenchApi,pollMs:100});`
const html='<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/styles/workbench.css"><style>*{box-sizing:border-box}body{margin:0;font-family:system-ui}#workbench-root{height:100vh}</style></head><body><div id="workbench-root"></div><script type="module" src="/harness.js"></script></body></html>'

async function main(){
  const temporary=realpathSync(mkdtempSync(join(tmpdir(),'cc-background-browser-state-'))),evidence=realpathSync(mkdtempSync(join(tmpdir(),'cc-background-browser-evidence-')))
  const stateDir=join(temporary,'state'),project=join(temporary,'project');mkdirSync(stateDir);mkdirSync(project)
  process.env.WECHAT_STATE_DIR=stateDir;process.env.WECHAT_DISABLE_LOG_FILE='1'
  const [{openDb},{makeWorkbenchStore},{makeWorkbenchService},{createProviderRegistry},{createInternalApi},{createWorkbenchProxy}]=await Promise.all([
    import('../src/lib/db'),import('../src/core/workbench/store'),import('../src/core/workbench/service'),import('../src/core/provider-registry'),import('../src/daemon/internal-api/index'),import('../apps/desktop/workbench-proxy'),
  ])
  const {chromium}=createRequire(join(repo,'apps/desktop/package.json'))('@playwright/test') as {chromium:{launch(options:{headless:boolean}):Promise<Browser>}}
  const ack=gate(),started:string[]=[],closed:string[]=[],submissions:Array<{requestId:string;text:string}>=[]
  const pipes=new Map<string,ReturnType<typeof channel>>(),states=new Map<string,AgentRuntimeSnapshot>()
  const provider:AgentProvider={async spawn(p,context){
    assert.equal(context.workbenchLifecycle,true)
    const id=p.alias.replace('workbench:',''),sessionId=randomUUID(),pipe=channel();pipes.set(id,pipe)
    const state:AgentRuntimeSnapshot={retained:false,foreground:'idle',backgroundCount:0,input:'send'};states.set(id,state)
    return{
      async *dispatch(){throw Error('legacy dispatch was used')},
      workbenchRuntime:{events:pipe.events(),snapshot:()=>({...state}),start(text){
        started.push(id);pipe.push({kind:'init',sessionId})
        if(started.length>1){pipe.push({kind:'text',text:'后续任务已经取得文件夹。'});pipe.push({kind:'result',sessionId,numTurns:1,durationMs:1});pipe.end();return}
        Object.assign(state,{retained:true,backgroundCount:2})
        pipe.push({kind:'text',text:'我已经整理好主要修改，两位子助手还在分别核对兼容性和测试。',itemId:'parent-one',textMode:'replace'})
        for(const child of ['兼容性','测试'])pipe.push({kind:'tool_call',tool:'Agent',activity:{id:child,type:'agent',label:`${child}核对`,status:'running'}})
        pipe.push({kind:'result',sessionId,numTurns:1,durationMs:1})
      },async submit(requestId,text){
        submissions.push({requestId,text});await ack.promise
        pipe.push({kind:'text',text:'收到。后续检查会保留原来的接口。',itemId:'parent-followup',textMode:'replace'})
        pipe.push({kind:'result',sessionId,numTurns:1,durationMs:1})
      }},
      async cancel(){ack.release();pipe.end()},async close(){closed.push(id);pipe.end()},
    }
  }}
  const registry=createProviderRegistry();registry.register('claude',provider,{workbench:MANAGED_NATIVE_CAPABILITIES,displayName:'Claude',canResume:()=>true})
  const db=openDb({path:join(stateDir,'workbench.db')}),store=makeWorkbenchStore(db),service=makeWorkbenchService({store,registry,stateDir,ownerChatId:()=>null})
  const api=createInternalApi({stateDir,daemonPid:process.pid,workbench:service,db})
  let host:ReturnType<typeof Bun.serve>|undefined,browser:Browser|undefined,page:Page|undefined
  const pageErrors:string[]=[],httpErrors:string[]=[]
  let detailUnavailable=false
  try{
    const info=await api.start();writeFileSync(join(stateDir,'internal-api-info.json'),JSON.stringify({baseUrl:`http://127.0.0.1:${info.port}`,operatorTokenFilePath:info.operatorTokenFilePath}),{mode:0o600})
    const proxy=createWorkbenchProxy({stateDir,dryRun:false,allowWrites:true}),csp=JSON.parse(readFileSync(join(src,'../src-tauri/tauri.conf.json'),'utf8')).app.security.csp as string
    host=Bun.serve({hostname:'127.0.0.1',port:0,idleTimeout:30,async fetch(request){
      const path=new URL(request.url).pathname
      if(detailUnavailable&&path==='/v1/workbench/task')return Response.json({error:'fixture_unavailable'},{status:503})
      const res=await proxy(request)
      if(res){if(res.status>=400)httpErrors.push(`${request.method} ${path}: ${await res.clone().text()}`);return res}
      if(path==='/')return new Response(html,{headers:{'content-type':'text/html','content-security-policy':csp}})
      if(path==='/harness.js')return new Response(harness,{headers:{'content-type':'text/javascript'}})
      const filePath=resolve(src,'.'+path);if(!filePath.startsWith(src+'/'))return new Response('Not found',{status:404})
      const file=Bun.file(filePath);return await file.exists()?new Response(file):new Response('Not found',{status:404})
    }})
    browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1280,height:900}});page.on('pageerror',error=>pageErrors.push(error.message))
    await page.goto(`http://127.0.0.1:${host.port}`);await page.locator('#wb-path').fill(project);await page.locator('#wb-create-text').fill('请修复导出问题，并请子助手核对兼容性和测试。')
    await page.getByRole('button',{name:'开始任务',exact:true}).click();await eventually(()=>started.length===1)
    const task=store.get(started[0]!),epoch=service.detail(task.id).runId!
    await page.waitForFunction(()=>document.body.textContent?.includes('后台执行中 · 2'))
    assert.equal(closed.length,0);assert.equal(store.artifacts(task.id).length,0)
    await page.screenshot({path:join(evidence,'background-running-1280.png')})
    detailUnavailable=true
    // Wake the outstanding long poll; the next request hits the outage.
    pipes.get(task.id)!.push({kind:'text',text:'检查仍在进行。',itemId:'outage-before',textMode:'replace'})
    await page.waitForFunction(()=>document.body.textContent?.includes('正在重新连接'))
    await page.screenshot({path:join(evidence,'task-reconnecting-1280.png')})
    detailUnavailable=false
    await page.getByRole('button',{name:'立即重试',exact:true}).click()
    await page.waitForFunction(()=>!document.body.textContent?.includes('正在重新连接'))
    await page.locator('#wb-followup-text').fill('重开后仍保留的草稿')
    await page.goto(`http://127.0.0.1:${host.port}`)
    await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('#wb-followup-text')?.value==='重开后仍保留的草稿')
    for(const child of ['兼容性','测试'])pipes.get(task.id)!.push({kind:'tool_call',tool:'Agent',activity:{id:child,type:'agent',label:`${child}核对`,status:'completed',output:child==='兼容性'?'原有接口保持兼容。\n<script>这只是公开回复中的文字</script>':'针对本次改动的测试通过，未运行用户外部服务。'}})
    Object.assign(states.get(task.id)!,{backgroundCount:0,foreground:'idle'})
    pipes.get(task.id)!.push({kind:'text',text:'两位子助手的结果已收到。兼容性没有冲突，测试也已通过。',itemId:'parent-late',textMode:'replace'})
    await page.waitForFunction(()=>!!document.querySelector('.wb-task-head [data-status="retained"]'))
    await page.locator('details[data-timeline-group] > summary').click()
    await page.locator('.wb-operation[data-activity-type="agent"]:first-child details > summary').click()
    await page.screenshot({path:join(evidence,'retained-child-reply-1280.png')})
    assert.equal(await page.locator('.wb-operation-output script').count(),0)
    await page.locator('#wb-followup-text').fill('保留原来的接口，继续检查错误处理。');await page.getByRole('button',{name:'发送补充',exact:true}).click()
    await eventually(()=>submissions.length===1)
    assert.equal(store.liveInputs.get(submissions[0]!.requestId)?.status,'sending')
    await page.waitForFunction(()=>document.body.textContent?.includes('等待交付确认'))
    await page.screenshot({path:join(evidence,'input-awaiting-native-ack.png')})
    ack.release();await eventually(()=>store.liveInputs.get(submissions[0]!.requestId)?.status==='delivered')
    assert.equal(store.liveInputs.get(submissions[0]!.requestId)?.runId,epoch);assert.equal(service.detail(task.id).runId,epoch)
    const next=service.create({providerId:'claude',path:project,text:'下一项独立任务'})
    assert.equal(next.status,'queued');assert.equal(started.length,1)
    const {outputDirectory}=await import('../src/core/workbench/artifacts')
    writeFileSync(join(outputDirectory(project,task.id),'background-result.md'),'# 已核对的成果\n')
    await page.getByRole('button',{name:'结束后台会话',exact:true}).click()
    await eventually(()=>store.get(task.id).status==='completed'&&store.get(next.id).status==='completed')
    assert.deepEqual(started,[task.id,next.id]);assert.ok(store.artifacts(task.id).some(a=>a.name==='background-result.md'));assert.equal(closed[0],task.id)
    await page.waitForFunction(()=>document.querySelector('.wb-task-head .wb-status')?.textContent==='已答复')
    await page.waitForFunction(id=>document.querySelector(`[data-task-id="${id}"]`)?.textContent?.includes('已答复'),next.id)
    await page.screenshot({path:join(evidence,'closed-and-saved-1280.png')})
    assert.deepEqual(pageErrors,[]);assert.deepEqual(httpErrors,[])
    const report={ok:true,transport:'production UI + host proxy + internal HTTP + SQLite',executor:'synthetic fixture, not native proof',tasks:started.length,inputReceipts:submissions.length,sameEpoch:true,noEarlyClose:true,closeBeforePathRelease:true,artifactsAfterClose:true,childOutputEscaped:true,taskReconnectVisible:true,reloadPreservesDraft:true,evidence}
    writeFileSync(join(evidence,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2))
  }catch(error){await page?.screenshot({path:join(evidence,'failure.png')}).catch(()=>{});writeFileSync(join(evidence,'failure.json'),JSON.stringify({error:String(error),pageErrors,httpErrors},null,2));throw Error(`Background browser smoke failed; ${evidence}`,{cause:error})}
  finally{ack.release();for(const pipe of pipes.values())pipe.end();await browser?.close();await service.shutdown();host?.stop(true);await api.stop();db.close();rmSync(temporary,{recursive:true,force:true})}
}
await main()
