/** Production Codex runtime proof, using only owned native config and loopback responses.
 * Invoked by workbench-codex-background-smoke.ts --run --production --runtime=v1|v2.
 * Add --stop-held to stop while the native child still owns a model request. */
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {chmod,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises'
import {createServer,type ServerResponse} from 'node:http'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {gunzipSync} from 'node:zlib'
import {createWorkbenchCodexProvider} from '../src/core/workbench/codex-app-server'
import {findCodexBinary} from '../src/lib/find-codex-binary'
import {TIER_PROFILES} from '../src/core/user-tier'
import type {AgentEvent,AgentSession} from '../src/core/agent-provider'

assert(process.argv.includes('--run'));assert.equal(process.platform,'darwin')
const binary=findCodexBinary();assert(binary)
const version=execFileSync(binary,['--version'],{encoding:'utf8'}).trim()
const mode=process.argv.find(value=>value.startsWith('--runtime='))?.split('=')[1]??'v1'
assert(['v1','v2'].includes(mode))
const commandMode=process.argv.includes('--background-command'),stopHeld=process.argv.includes('--stop-held')||commandMode,scenario=commandMode?'background-command':stopHeld?'stop-held':'late-permission-followup'
const area=await realpath(await mkdtemp(join(tmpdir(),'cc-codex-background-runtime-')))
const safePath=process.env.PATH??'/usr/bin:/bin'
for(const key of Object.keys(process.env))delete process.env[key]
Object.assign(process.env,{PATH:safePath,HOME:area,CODEX_HOME:area,TMPDIR:area,LANG:'en_US.UTF-8',TERM:'dumb'})
const trace:any[]=[],events:AgentEvent[]=[],started=Date.now(),activeResponses=new Set<ServerResponse>()
const record=(kind:string,data:any={})=>trace.push({atMs:Date.now()-started,kind,...data})
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
async function until(label:string,test:()=>boolean,budget=10000){const deadline=Date.now()+budget;while(!test()){assert(Date.now()<deadline,`Timed out: ${label}`);await delay(20)}}
const quote=(value:string)=>`'${value.replaceAll("'","'\\''")}'`
const message=(text:string,id:string)=>({id,type:'message',role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text,annotations:[]}]})
function send(response:ServerResponse,items:any[],id:string){
  assert(!response.destroyed,'Owned response transport ended before delivery')
  response.writeHead(200,{'content-type':'text/event-stream'})
  const list:any[]=[{type:'response.created',response:{id}}]
  items.forEach((item,index)=>list.push({type:'response.output_item.added',output_index:index,item},{type:'response.output_item.done',output_index:index,item}))
  list.push({type:'response.completed',response:{id,status:'completed',output:items,usage:{input_tokens:10,output_tokens:10,total_tokens:20}}})
  response.end(list.map(item=>`event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`).join(''))
}
function toolList(body:any){return [...(body.tools??[]),...(body.input??[]).filter((item:any)=>item.type==='additional_tools').flatMap((item:any)=>item.tools??[])].flatMap((tool:any)=>tool.type==='namespace'?(tool.tools??[]).map((item:any)=>({...item,namespace:tool.name})):[tool])}
let parentId='',childId='',parentRequests=0,childRequests=0,childResponse:ServerResponse|undefined,childTools:any[]=[],followupResponse:ServerResponse|undefined,permissionResolve:((allow:boolean)=>void)|undefined
const marker=join(area,'OWNED_APPROVAL_EXECUTED'),commandPidFile=join(area,'owned-command.pid')
let commandPid=0,commandGroup=0
const server=createServer(async(req,res)=>{
  activeResponses.add(res);res.on('close',()=>activeResponses.delete(res))
  try{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk))
    const bytes=Buffer.concat(chunks),body=JSON.parse((req.headers['content-encoding']==='gzip'?gunzipSync(bytes):bytes).toString()||'{}')
    assert(req.url?.endsWith('/responses'),'Unexpected owned endpoint route')
    const metadata=body.client_metadata??{},isChild=!!metadata['x-codex-parent-thread-id'],tools=toolList(body)
    if(isChild){childId=metadata.thread_id;childRequests++}else{parentId=metadata.thread_id;parentRequests++}
    const id=`owned-${isChild?'child':'parent'}-${isChild?childRequests:parentRequests}`
    record('model_request',{role:isChild?'child':'parent',threadId:metadata.thread_id,turnId:metadata.turn_id,parentThreadId:metadata['x-codex-parent-thread-id'],model:body.model,tools:tools.map((tool:any)=>`${tool.namespace??''}.${tool.name}`)})
    record('owned_function_output',{outputs:(body.input??[]).filter((item:any)=>item.type==='custom_tool_call_output'||item.type==='function_call_output')})
    if(isChild){
      if(childRequests===1){childResponse=res;childTools=tools;return}
      send(res,[message('OWNED_CHILD_PUBLIC_RESULT',id)],id);return
    }
    if(parentRequests===1){
      if(commandMode){
        const exec=tools.find((tool:any)=>tool.type==='custom'&&tool.name==='exec');assert(exec)
        const args={cmd:`printf '%s' $$ > ${quote(commandPidFile)}; sleep 30; printf SHOULD_NOT_FINISH > ${quote(marker)}`,yield_time_ms:1000,sandbox_permissions:'require_escalated',justification:'Run the owned background command fixture.'}
        send(res,[{id:`call-${id}`,type:'custom_tool_call',call_id:`call-${id}`,name:exec.name,namespace:exec.namespace,input:`const tool = ALL_TOOLS.find(value => value.name.endsWith('exec_command')); if (!tool) throw Error('Owned command missing'); text(await tools[tool.name](${JSON.stringify(args)}));`}],id)
        return
      }
      const direct=tools.find((tool:any)=>tool.name==='spawn_agent')
      if(direct){const args=direct.parameters?.properties?.task_name?{task_name:'owned_child',message:'OWNED_CHILD_TASK',fork_turns:'none'}:{message:'OWNED_CHILD_TASK',fork_context:false};send(res,[{id:`call-${id}`,type:'function_call',call_id:`call-${id}`,name:direct.name,namespace:direct.namespace,arguments:JSON.stringify(args)}],id)}
      else{const exec=tools.find((tool:any)=>tool.type==='custom'&&tool.name==='exec');assert(exec);send(res,[{id:`call-${id}`,type:'custom_tool_call',call_id:`call-${id}`,name:exec.name,namespace:exec.namespace,input:"const tool = ALL_TOOLS.find(value => value.name.endsWith('spawn_agent')); if (!tool) throw Error('Owned native spawn missing'); text(await tools[tool.name]({message:'OWNED_CHILD_TASK',fork_context:false}));"}],id)}
    }else if(parentRequests===2)send(res,[message('OWNED_PARENT_FIRST_RESULT',id)],id)
    else if(parentRequests===3){followupResponse=res}
    else send(res,[message('OWNED_PARENT_AFTER_STEER_RESULT',id)],id)
  }catch(error){record('endpoint_error',{message:String(error)});res.writeHead(500);res.end('{}')}
})
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as {port:number}).port
const wirePath=join(area,'owned-wire.jsonl'),bridge=join(area,'bridge.mjs'),wrapper=join(area,'codex-owned'),profile='(version 1) (allow default) (deny network*) (allow network-outbound (remote ip "localhost:*"))'
await writeFile(join(area,'config.toml'),`model_provider='owned_fixture'\nweb_search='disabled'\n[model_providers.owned_fixture]\nname='Owned runtime fixture'\nbase_url='http://127.0.0.1:${port}/v1'\nwire_api='responses'\nrequires_openai_auth=false\nsupports_websockets=false\n[features]\nplugins=false\napps=false\nhooks=false\nmulti_agent=true\n`)
await writeFile(bridge,`import {spawn} from 'node:child_process';import {appendFileSync} from 'node:fs';import {createInterface} from 'node:readline';
const record=(direction,message)=>appendFileSync(${JSON.stringify(wirePath)},JSON.stringify({direction,message,pid:process.pid})+'\\n');
const child=spawn('/usr/bin/sandbox-exec',['-p',${JSON.stringify(profile)},${JSON.stringify(binary)},...process.argv.slice(2)],{stdio:['pipe','pipe','inherit'],windowsHide:true});
record('process',{nativePid:child.pid,args:process.argv.slice(2)});
if(process.argv.includes('app-server')){
createInterface({input:process.stdin}).on('line',line=>{record('request',JSON.parse(line));child.stdin.write(line+'\\n')}).on('close',()=>child.stdin.end());
createInterface({input:child.stdout}).on('line',line=>{record('response',JSON.parse(line));process.stdout.write(line+'\\n')});
}else{process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout)}
child.stdin.on('error',()=>{});child.on('error',()=>process.exit(1));child.on('close',code=>process.exit(code??0));
`)
await writeFile(wrapper,`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(bridge)} "$@"\n`);await chmod(wrapper,0o700)
async function wire(){return (await readFile(wirePath,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))}
const exists=(pid:number)=>{try{process.kill(pid,0);return true}catch{return false}}
const connections=()=>{let data='';try{data=execFileSync('/usr/sbin/lsof',['-nP',`-iTCP:${port}`,'-Fpn'],{encoding:'utf8',stdio:['ignore','pipe','ignore']})}catch{};return data.split('\n').filter(line=>line.startsWith('n')&&line.endsWith(`->127.0.0.1:${port}`))}
let session:AgentSession|undefined,done:Promise<void>|undefined,ended=false,result:any
try{
  const provider=createWorkbenchCodexProvider({codexPathOverride:wrapper,rpcTimeoutMs:10000})
  const project={alias:'owned-background-runtime',path:area},catalog=await provider.modelCatalog!(project)
  assert.equal(parentRequests+childRequests,0)
  const models=(await wire()).flatMap(row=>row.message.result?.data??[])
  const selected=models.find((model:any)=>model.multiAgentVersion===mode);assert(selected,`No native ${mode} model advertised`)
  assert(catalog.models.some(model=>model.id===selected.model))
  session=await provider.spawn(project,{tierProfile:TIER_PROFILES.trusted,permissionMode:'strict',chatId:'owned-task:one-run',workbenchLifecycle:true,workbenchTimeline:true,execution:{defaults:'native',model:selected.model,reasoningEffort:'low'},requestPermission:(permission,signal)=>{
    assert(signal&&!signal.aborted);record('permission_requested',{permission,afterParentResult:events.some(event=>event.kind==='result')})
    if(commandMode)return Promise.resolve(true)
    return new Promise<boolean>(resolve=>{permissionResolve=resolve;signal.addEventListener('abort',()=>resolve(false),{once:true})})
  }})
  const runtime=session.workbenchRuntime;assert(runtime)
  done=(async()=>{for await(const event of runtime.events){events.push(event);record('agent_event',{event,snapshot:runtime.snapshot()})}ended=true})()
  runtime.start('OWNED_PARENT_TASK. Spawn the child and reply immediately.')
  await until('parent result while child request held',()=>events.some(event=>event.kind==='result')&&(commandMode||!!childResponse))
  assert(!ended);assert.equal(runtime.snapshot().retained,true)
  await until('verified child occurrence',()=>runtime.snapshot().backgroundCount===1)
  assert.equal(runtime.snapshot().foreground,'idle');assert.equal(runtime.snapshot().input,'send')
  record('parent_result_child_held',{snapshot:runtime.snapshot(),parentId,childId})
  if(commandMode){
    commandPid=Number(await readFile(commandPidFile,'utf8'));assert(commandPid>0&&exists(commandPid))
    commandGroup=Number(execFileSync('/bin/ps',['-o','pgid=','-p',String(commandPid)],{encoding:'utf8'}).trim());assert(commandGroup>0)
    record('owned_command_still_running',{pid:commandPid,group:commandGroup,snapshot:runtime.snapshot()})
  }

  if(!stopHeld){
    const exec=childTools.find(tool=>tool.type==='custom'&&tool.name==='exec');assert(exec,'Native child command wrapper unavailable')
    const command=`printf OWNED_APPROVED > ${quote(marker)}`
    send(childResponse!,[{id:'owned-child-permission',type:'custom_tool_call',call_id:'owned-child-permission',name:exec.name,namespace:exec.namespace,input:`const tool = ALL_TOOLS.find(value => value.name.endsWith('exec_command')); if (!tool) throw Error('Owned command tool missing'); text(await tools[tool.name](${JSON.stringify({cmd:command,sandbox_permissions:'require_escalated',justification:'Run the owned fixture command after explicit approval.'})}));`}],'owned-permission-response')
    await until('child permission after parent result',()=>!!permissionResolve)
    const permissions=(await wire()).filter(row=>row.message.method==='item/commandExecution/requestApproval')
    assert.equal(permissions.length,1);assert.equal(permissions[0].message.params.threadId,childId)
    assert.notEqual(childId,parentId);permissionResolve!(true)
    await until('late child public output terminal',()=>events.some(event=>event.kind==='tool_call'&&event.activity?.status==='completed'&&event.activity.output==='OWNED_CHILD_PUBLIC_RESULT'))
    assert.equal(await readFile(marker,'utf8'),'OWNED_APPROVED')
    assert(!events.some(event=>event.kind==='text'&&event.text.includes('OWNED_CHILD_PUBLIC_RESULT')))
    assert(!events.some(event=>event.kind==='error'));assert(!ended)
    assert.equal(runtime.snapshot().backgroundCount,0)
    await runtime.submit('owned-followup-id','OWNED_PARENT_FOLLOWUP')
    await until('same-parent followup model request',()=>!!followupResponse)
    assert.equal(runtime.snapshot().input,'steer')
    await runtime.submit('owned-steer-id','OWNED_ACTIVE_STEER')
    const submitted=(await wire()).filter(row=>['turn/start','turn/steer'].includes(row.message.method))
    assert(submitted.every(row=>row.message.params.threadId===parentId),'CC changed native parent thread')
    assert.equal(submitted.filter(row=>row.message.method==='turn/start').length,2)
    assert.equal(submitted.filter(row=>row.message.method==='turn/steer').length,1)
    send(followupResponse!,[message('OWNED_PARENT_FOLLOWUP_RESULT','owned-followup-result')],'owned-followup-result')
    await until('same-parent followup result',()=>events.filter(event=>event.kind==='result').length===2)
    assert(!ended);assert.equal(runtime.snapshot().retained,true)
    record('same_epoch_followup_acknowledged',{snapshot:runtime.snapshot(),nativeRequests:submitted.map(row=>row.message)})
  }else if(!commandMode)assert(connections().length>0)
  await session.cancel!();await session.close();await done
  const rows=await wire(),processes=rows.filter(row=>row.direction==='process')
  assert(processes.length>0)
  for(const row of processes){assert(!exists(row.pid),`Fixture bridge PID ${row.pid} survived`);assert(!exists(row.message.nativePid),`Native PID ${row.message.nativePid} survived`);assert(!exists(-row.pid),`Owned group ${row.pid} survived`)}
  assert.equal(connections().length,0)
  if(commandMode){assert(!exists(commandPid),'Owned command survived close');assert(!exists(-commandGroup),'Owned command process group survived close');await assert.rejects(readFile(marker))}
  if(stopHeld&&!commandMode)assert(rows.some(row=>row.message.method==='turn/interrupt'&&row.message.params.threadId===childId))
  record('owned_process_groups_reaped',{pids:processes.map(row=>({bridge:row.pid,native:row.message.nativePid})),connections:connections()})
  result={passed:true,mode,scenario,model:selected.model,parentId,childId,parentRequests,childRequests,permissionAfterParentResult:!stopHeld,groupsReaped:true}
}catch(error){result={passed:false,mode,scenario,error:String(error)};process.exitCode=1}
finally{
  await session?.close().catch(error=>record('cleanup_error',{error:String(error)}));await done;
  if(commandMode){
    if(!commandPid)commandPid=Number(await readFile(commandPidFile,'utf8').catch(()=>''))
    if(commandPid&&exists(commandPid)){
      if(!commandGroup)commandGroup=Number(execFileSync('/bin/ps',['-o','pgid=','-p',String(commandPid)],{encoding:'utf8'}).trim())
      if(commandGroup>0){try{process.kill(-commandGroup,'SIGKILL')}catch{};await until('emergency owned command cleanup',()=>!exists(-commandGroup),1000);record('fixture_emergency_command_cleanup',{pid:commandPid,group:commandGroup})}
    }
  }
  for(const response of activeResponses)response.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));const wireTrace=await wire().catch(()=>[]);await writeFile(`/tmp/cc-codex-background-runtime-${mode}-${scenario}.json`,JSON.stringify({version,result,trace,wire:wireTrace},null,2));await rm(area,{recursive:true,force:true})}
console.log(JSON.stringify({version,result,traceFile:`/tmp/cc-codex-background-runtime-${mode}-${scenario}.json`},null,2))
