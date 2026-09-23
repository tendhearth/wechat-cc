/** Owned, loopback-only investigation of installed Codex child-agent lifecycle.
 * Run: bun scripts/workbench-codex-background-smoke.ts --run
 * No production adapter, account, user config, or MCP is used. */
import assert from 'node:assert/strict'
import {spawn,execFileSync} from 'node:child_process'
import {mkdtemp,realpath,writeFile,rm} from 'node:fs/promises'
import {createServer,type ServerResponse} from 'node:http'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {gunzipSync} from 'node:zlib'
import {findCodexBinary} from '../src/lib/find-codex-binary'

if(!process.argv.includes('--run')){console.log('Use --run for the owned native background probe.');process.exit(0)}
if(process.argv.includes('--production')) { await import('./workbench-codex-background-runtime-smoke'); process.exit(process.exitCode ?? 0) }
assert.equal(process.platform,'darwin','This fixture requires sandbox-exec network isolation.')
const foundBinary=findCodexBinary();assert(foundBinary)
const binary:string=foundBinary
const version=execFileSync(binary,['--version'],{encoding:'utf8'}).trim()
type Trace={atMs:number;kind:string;[key:string]:unknown}
type Rpc={id?:number|string;method?:string;params?:any;result?:any;error?:any}
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
async function until(label:string,ready:()=>boolean,budget=8000){const end=Date.now()+budget;while(!ready()){assert(Date.now()<end,`Timed out: ${label}`);await delay(20)}}
function toolList(tools:any[]):any[]{return tools.flatMap(tool=>tool.type==='namespace'?(tool.tools??[]).map((entry:any)=>({...entry,namespace:tool.name})):[tool])}
function sendItems(response:ServerResponse,items:any[],id:string){
  if(response.destroyed)return
  response.writeHead(200,{'content-type':'text/event-stream'})
  const events:any[]=[{type:'response.created',response:{id}}]
  items.forEach((item,index)=>events.push({type:'response.output_item.added',output_index:index,item},{type:'response.output_item.done',output_index:index,item}))
  events.push({type:'response.completed',response:{id,status:'completed',output:items,usage:{input_tokens:10,output_tokens:10,total_tokens:20}}})
  response.end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
}
const message=(text:string,id:string)=>({id,type:'message',role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text,annotations:[]}]})

async function probe(scenario:string,runtime:string){
  const area=await realpath(await mkdtemp(join(tmpdir(),'cc-codex-background-'))),started=Date.now(),trace:Trace[]=[]
  const record=(kind:string,data:Record<string,unknown>={})=>trace.push({atMs:Date.now()-started,kind,...data})
  const pending=new Map<number,{resolve:(value:any)=>void;reject:(reason:any)=>void;timer:ReturnType<typeof setTimeout>}>()
  let rpcId=0,parentId='',parentTurn='',childId='',requestCount=0,parentRequests=0,childRequests=0,spawnTool:any,childResponse:ServerResponse|undefined,parentResponse:ServerResponse|undefined
  let childRequestClosed=false,parentFinal=false,closed=false,spawnOutput:any
  const notifications:Rpc[]=[],activeResponses=new Set<ServerResponse>()
  const server=createServer(async(request,response)=>{
    activeResponses.add(response);response.on('close',()=>activeResponses.delete(response))
    try{
      const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk))
      const bytes=Buffer.concat(chunks),body=JSON.parse((request.headers['content-encoding']==='gzip'?gunzipSync(bytes):bytes).toString()||'{}')
      if(!request.url?.endsWith('/responses')){record('unexpected_http',{path:request.url});response.writeHead(404);response.end('{}');return}
      const users=(body.input??[]).filter((item:any)=>item.type==='message'&&item.role==='user')
      const lastUser=JSON.stringify(users.at(-1)??'')
      const metadata=body.client_metadata??{}
      const child=metadata['x-codex-parent-thread-id']===parentId||lastUser.includes('OWNED_CHILD_TASK')
      const id=`owned-response-${++requestCount}`,tools=toolList([...(body.tools??[]),...(body.input??[]).filter((item:any)=>item.type==='additional_tools').flatMap((item:any)=>item.tools??[])])
      record('model_request',{request:requestCount,role:child?'child':'parent',model:body.model,threadId:metadata.thread_id,parentThreadId:metadata['x-codex-parent-thread-id'],turnId:metadata.turn_id,parentTurnId:metadata.parent_turn_id,childResultInInput:JSON.stringify(body.input).includes('OWNED_CHILD_RESULT'),tools:tools.map(tool=>`${tool.namespace?tool.namespace+'.':''}${tool.name??tool.type}`)})
      if(child){
        childRequests++;childResponse=response
        response.on('close',()=>{childRequestClosed=true;record('child_http_closed',{released:response.writableEnded})})
        request.socket.on('close',()=>{childRequestClosed=true;record('child_socket_closed',{released:response.writableEnded})})
        request.on('aborted',()=>{childRequestClosed=true;record('child_request_aborted')})
        return
      }
      parentRequests++
      const outputs=(body.input??[]).filter((item:any)=>item.type==='function_call_output'||item.type==='custom_tool_call_output')
      if(parentRequests===3&&scenario==='late')record('followup_mailbox_items',{items:(body.input??[]).filter((item:any)=>item.type==='agent_message'||JSON.stringify(item).includes('subagent_notification'))})
      if(parentRequests===1){
        spawnTool=tools.find(tool=>tool.name==='spawn_agent')
        if(!spawnTool&&runtime==='v1'){
          const exec=tools.find(tool=>tool.name==='exec'&&tool.type==='custom')
          if(exec){
            spawnTool=exec;record('spawn_via_native_code_mode')
            sendItems(response,[{id:`call-${id}`,type:'custom_tool_call',call_id:`spawn-${id}`,name:exec.name,namespace:exec.namespace,input:`const tool = ALL_TOOLS.find(value => value.name.endsWith('spawn_agent')); if (tool) { text(await tools[tool.name]({message:'OWNED_CHILD_TASK. Produce the owned child result.',fork_context:false})); } else { text('OWNED_NO_SPAWN_TOOL'); }`}],id)
            return
          }
        }
        if(!spawnTool){record('spawn_unavailable');sendItems(response,[message('OWNED_NO_SPAWN_TOOL',id)],id);return}
        record('spawn_tool_schema',{namespace:spawnTool.namespace,parameters:spawnTool.parameters})
        const args=spawnTool.parameters?.properties?.task_name?{task_name:'owned_child',message:'OWNED_CHILD_TASK. Produce the owned child result.',fork_turns:'none'}:{message:'OWNED_CHILD_TASK. Produce the owned child result.',fork_context:false}
        sendItems(response,[{id:`call-${id}`,type:'function_call',call_id:`spawn-${id}`,name:spawnTool.name,...(spawnTool.namespace?{namespace:spawnTool.namespace}:{}),arguments:JSON.stringify(args)}],id)
      }else{
        if(outputs.length){spawnOutput=outputs.at(-1).output;record('parent_tool_output',{output:spawnOutput});if(JSON.stringify(spawnOutput).includes('OWNED_NO_SPAWN_TOOL'))record('spawn_unavailable')}
        if(parentRequests===2&&['model-wait','model-close'].includes(scenario)){
          await until('held child before parent control tool',()=>!!childResponse&&!!childId)
          const name=scenario==='model-wait'?'wait_agent':runtime==='v1'?'close_agent':'interrupt_agent'
          record('model_control_tool',{name,childId})
          const args=scenario==='model-wait'?(runtime==='v1'?{targets:[childId],timeout_ms:10000}:{timeout_ms:10000}):{target:runtime==='v1'?childId:'/root/owned_child'}
          const direct=tools.find(tool=>tool.name===name)
          if(direct)sendItems(response,[{id:`call-${id}`,type:'function_call',call_id:`control-${id}`,name,...(direct.namespace?{namespace:direct.namespace}:{}),arguments:JSON.stringify(args)}],id)
          else{
            const exec=tools.find(tool=>tool.name==='exec'&&tool.type==='custom');assert(exec,'Native control tool not available')
            sendItems(response,[{id:`call-${id}`,type:'custom_tool_call',call_id:`control-${id}`,name:exec.name,namespace:exec.namespace,input:`const tool = ALL_TOOLS.find(value => value.name.endsWith(${JSON.stringify(name)})); if (!tool) throw Error('Native control tool unavailable'); text(await tools[tool.name](${JSON.stringify(args)}));`}],id)
          }
          return
        }
        if(scenario==='parent-interrupt'&&!parentFinal){parentResponse=response;return}
        sendItems(response,[message(parentRequests===2?'OWNED_PARENT_FINAL':'OWNED_PARENT_AFTER_CHILD',id)],id)
      }
    }catch(error){record('endpoint_error',{error:String(error)});response.writeHead(500);response.end('{}')}
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as {port:number}).port
  const clientConnections=()=>{
    let output=''
    try{output=execFileSync('/usr/sbin/lsof',['-nP',`-iTCP:${port}`,'-Fpn'],{encoding:'utf8',stdio:['ignore','pipe','ignore']})}catch{}
    let pid='';const clients:{pid:string;connection:string}[]=[]
    for(const line of output.split('\n')){if(line.startsWith('p'))pid=line.slice(1);if(line.startsWith('n')&&line.endsWith(`->127.0.0.1:${port}`))clients.push({pid,connection:line.slice(1)})}
    return clients
  }
  await writeFile(join(area,'config.toml'),`model_provider='owned_fixture'\nweb_search='disabled'\n[model_providers.owned_fixture]\nname='Owned background fixture'\nbase_url='http://127.0.0.1:${port}/v1'\nwire_api='responses'\nrequires_openai_auth=false\nsupports_websockets=false\n[features]\nplugins=false\napps=false\nhooks=false\nmulti_agent=true\n`)
  const child=spawn('/usr/bin/sandbox-exec',['-p','(version 1) (allow default) (deny network*) (allow network-outbound (remote ip "localhost:*"))',binary,'app-server'],{cwd:area,env:{PATH:process.env.PATH,HOME:area,CODEX_HOME:area,TMPDIR:area,LANG:'en_US.UTF-8'},stdio:['pipe','pipe','pipe'],detached:true,windowsHide:true})
  record('native_started',{pid:child.pid})
  const send=(value:Rpc)=>child.stdin.write(JSON.stringify(value)+'\n')
  const rpc=(method:string,params:Record<string,unknown>)=>new Promise<any>((resolve,reject)=>{
    const id=++rpcId,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`RPC timeout ${method}`))},8000)
    pending.set(id,{resolve,reject,timer});record('request',{method,params});send({id,method,params})
  })
  let lines=''
  child.stdout.on('data',chunk=>{lines+=String(chunk);while(lines.includes('\n')){
    const end=lines.indexOf('\n'),line=lines.slice(0,end);lines=lines.slice(end+1)
    const value=JSON.parse(line) as Rpc
    if(value.id!==undefined&&!value.method){const call=pending.get(Number(value.id));if(call){clearTimeout(call.timer);pending.delete(Number(value.id));value.error?call.reject(new Error(JSON.stringify(value.error))):call.resolve(value.result)};record('response',{id:value.id,result:value.result,error:value.error});continue}
    notifications.push(value);record('notification',{method:value.method,params:value.params})
    if(value.method==='thread/started'&&value.params?.thread?.source?.subAgent?.thread_spawn?.parent_thread_id===parentId)childId=value.params.thread.id
    if(value.params?.item?.type==='collabAgentToolCall'&&value.params.item.tool==='spawnAgent'&&value.params.item.receiverThreadIds?.[0])childId=value.params.item.receiverThreadIds[0]
    if(value.params?.item?.type==='subAgentActivity'&&value.params.item.kind==='started')childId=value.params.item.agentThreadId
    if(value.method==='turn/completed'&&value.params?.threadId===parentId)parentFinal=true
    if(value.id!==undefined){record('unexpected_server_request',{method:value.method});send({id:value.id,error:{code:-32601,message:'Owned fixture does not permit external operations'}} as any)}
  }})
  child.stderr.on('data',()=>{})
  child.on('close',()=>{closed=true;record('native_closed');for(const call of pending.values()){clearTimeout(call.timer);call.reject(new Error('Native closed'))};pending.clear()})
  const groupExists=()=>{try{process.kill(-child.pid!,0);return true}catch{return false}}
  const stop=async()=>{
    if(!closed)try{process.kill(-child.pid!,'SIGTERM')}catch{}
    await until('owned native exit',()=>closed,1000).catch(()=>{try{process.kill(-child.pid!,'SIGKILL')}catch{}})
    await until('native reaped',()=>closed,1000)
    if(groupExists())try{process.kill(-child.pid!,'SIGKILL')}catch{}
    await until('owned native process group exit',()=>!groupExists(),1000)
    record('native_process_group_exited',{pid:child.pid})
  }
  let result:any
  try{
    await rpc('initialize',{clientInfo:{name:'cc_background_owned_probe',version:'1'},capabilities:{experimentalApi:false}});send({method:'initialized'})
    const catalog=await rpc('model/list',{limit:100,includeHidden:false})
    record('catalog',{models:catalog.data.map((model:any)=>({id:model.id,model:model.model,multiAgentVersion:model.multiAgentVersion}))})
    const selected=catalog.data.find((model:any)=>model.multiAgentVersion===runtime)??catalog.data.find((model:any)=>model.isDefault)??catalog.data[0]
    assert(selected)
    const start=await rpc('thread/start',{cwd:area,model:selected.model,approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:'workspace-write',config:{model_reasoning_effort:'low',sandbox_workspace_write:{network_access:false,writable_roots:[],exclude_tmpdir_env_var:true,exclude_slash_tmp:true}},developerInstructions:'Owned deterministic lifecycle fixture; tools other than agent orchestration are unavailable.'})
    parentId=start.thread.id
    const turn=await rpc('turn/start',{threadId:parentId,input:[{type:'text',text:'OWNED_PARENT_TASK. Spawn the owned child task and provide your parent final reply immediately.',text_elements:[]}]})
    parentTurn=turn.turn.id
    await until('child request or unavailable spawn',()=>!!childResponse||trace.some(value=>value.kind==='spawn_unavailable'))
    if(!childResponse){result={supported:false,reason:'spawn_tool_unavailable',model:selected.model};return {scenario,runtime,result,trace}}
    await until('child identity',()=>!!childId)
    if(scenario==='model-wait'){
      await until('native wait invoked',()=>trace.some(value=>value.kind==='model_control_tool'))
      await delay(200);record('release_child_to_wait');sendItems(childResponse,[message('OWNED_CHILD_RESULT','owned-child-wait-result')],'owned-child-wait')
    }
    if(scenario==='parent-interrupt'){
      await until('parent request held',()=>!!parentResponse)
      await rpc('turn/interrupt',{threadId:parentId,turnId:parentTurn})
      await until('parent interrupted',()=>parentFinal)
    }else await until('parent final while child held',()=>parentFinal)
    const before=await rpc('thread/read',{threadId:childId,includeTurns:false})
    assert.equal(before.thread.source?.subAgent?.thread_spawn?.parent_thread_id,parentId,'Native child ownership mismatch')
    if(['late','parent-interrupt','child-interrupt','unsubscribe','process-close'].includes(scenario))assert.equal(before.thread.status.type,'active','Native child did not remain active after parent turn ended')
    record('child_after_parent_final',{childId,status:before.thread.status,source:before.thread.source,heldResponse:!childResponse.writableEnded})
    if(scenario==='process-close'){
      const before=clientConnections();record('transport_before_process_close',{clients:before});assert(before.length>0,'OS probe did not see the owned native connection')
      await stop();const after=clientConnections();record('transport_after_process_close',{clients:after,bunSocketDestroyed:childResponse.socket?.destroyed,bunResponseClosed:childRequestClosed})
      assert.equal(after.length,0,'Owned native client connection survived process cleanup')
    }else if(scenario==='child-interrupt'){
      const snapshot=await rpc('thread/read',{threadId:childId,includeTurns:true})
      const childTurn=snapshot.thread.turns.find((value:any)=>value.status==='inProgress')?.id??snapshot.thread.turns.at(-1)?.id
      assert(childTurn,'No actual child turn ID was discoverable')
      await rpc('turn/interrupt',{threadId:childId,turnId:childTurn})
      await until('child native turn interrupted',()=>notifications.some(value=>value.method==='turn/completed'&&value.params?.threadId===childId&&value.params?.turn?.status==='interrupted'))
      await delay(200);record('child_interrupt_transport',{bunCloseCallbackObserved:childRequestClosed})
      sendItems(childResponse,[message('OWNED_LATE_AFTER_INTERRUPT','owned-late-interrupt')],'owned-late-interrupt')
      await delay(200)
      assert(!notifications.some(value=>value.params?.item?.text==='OWNED_LATE_AFTER_INTERRUPT'),'Late child response escaped native interruption')
    }else if(!['model-wait','model-close'].includes(scenario)){
      if(scenario==='unsubscribe')await rpc('thread/unsubscribe',{threadId:parentId})
      await delay(200)
      record('release_child');sendItems(childResponse,[message('OWNED_CHILD_RESULT','owned-child-result')],'owned-child-complete')
      await delay(800)
    }else if(scenario==='model-close'){
      await delay(200);record('model_close_transport',{bunCloseCallbackObserved:childRequestClosed})
      sendItems(childResponse,[message('OWNED_LATE_AFTER_CLOSE','owned-late-close')],'owned-late-close')
      await delay(200)
      assert(!notifications.some(value=>value.params?.item?.text==='OWNED_LATE_AFTER_CLOSE'),'Late child response escaped native stop tool')
    }
    if(!closed){
      const after=await rpc('thread/read',{threadId:childId,includeTurns:true})
      record('child_final_snapshot',{thread:after.thread})
      await delay(200)
      if(scenario==='late'){
        assert.equal(parentRequests,2,'Child completion unexpectedly generated a new parent turn')
        record('no_automatic_parent_turn_after_child')
        const followup=await rpc('turn/start',{threadId:parentId,input:[{type:'text',text:'OWNED_PARENT_FOLLOWUP. Summarize the owned child result.',text_elements:[]}]})
        await until('explicit parent follow-up completion',()=>notifications.some(value=>value.method==='turn/completed'&&value.params?.threadId===parentId&&value.params?.turn?.id===followup.turn.id))
        const delivered=trace.some(value=>value.kind==='model_request'&&value.role==='parent'&&value.turnId===followup.turn.id&&value.childResultInInput===true)
        record('explicit_followup_child_result',{delivered})
      }
    }
    result={supported:true,model:selected.model,declaredRuntime:selected.multiAgentVersion,parentId,childId,parentRequests,childRequests,serverCloseEventObservedBeforeCleanup:childRequestClosed,parentFinal,spawnOutput,...(scenario==='late'?{explicitFollowupIncludesChildResult:trace.find(value=>value.kind==='explicit_followup_child_result')?.delivered}:{} )}
  }catch(error){result={supported:false,error:String(error),parentId,childId,parentRequests,childRequests}}
  finally{await stop();for(const response of activeResponses)response.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(area,{recursive:true,force:true})}
  return {scenario,runtime,result,trace}
}
const scenario=process.argv.find(value=>value.startsWith('--scenario='))?.split('=')[1]??'late'
const runtime=process.argv.find(value=>value.startsWith('--runtime='))?.split('=')[1]??'v1'
assert(['late','parent-interrupt','child-interrupt','unsubscribe','process-close','model-close','model-wait'].includes(scenario),'Unknown owned scenario')
assert(['v1','v2'].includes(runtime),'Unknown native runtime')
const outcome=await probe(scenario,runtime)
await writeFile(`/tmp/cc-codex-background-${runtime}-${scenario}.json`,JSON.stringify({version,...outcome},null,2))
console.log(JSON.stringify({version,scenario,runtime,result:outcome.result,traceFile:`/tmp/cc-codex-background-${runtime}-${scenario}.json`},null,2))
