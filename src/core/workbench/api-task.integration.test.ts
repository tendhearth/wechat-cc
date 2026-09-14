import {afterEach,beforeEach,expect,it} from 'vitest'
import {createServer,type Server} from 'node:http'
import {once} from 'node:events'
import {mkdtempSync,mkdirSync,realpathSync,rmSync,readFileSync,existsSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {openDb,type Db} from '../../lib/db'
import {createProviderRegistry} from '../provider-registry'
import {createApiModel} from './api-model'
import {createApiTaskProvider,apiTaskConnectionHash} from './api-task-provider'
import {makeApiSessionStore} from './api-sessions'
import {MANAGED_API_CAPABILITIES} from './executor-capabilities'
import {makeWorkbenchStore} from './store'
import {makeWorkbenchService,type WorkbenchService} from './service'

let root:string,state:string,project:string,db:Db,server:Server,service:WorkbenchService
beforeEach(()=>{root=realpathSync(mkdtempSync(join(tmpdir(),'cc-api-service-')));state=join(root,'state');project=join(root,'project');mkdirSync(state);mkdirSync(project);db=openDb({path:join(state,'test.db')})})
afterEach(async()=>{await service?.shutdown();if(server){server.closeAllConnections();server.close();await once(server,'close')}db.close();rmSync(root,{recursive:true,force:true})})
type Request={model:string;messages:Array<{role:string;content:unknown}>;tools:Array<{function:{name:string}}>}
async function endpoint(reply:(request:Request,count:number)=>{text?:string;tool?:{name:string;input:unknown};finish?:string}){
  const requests:Request[]=[]
  server=createServer(async(req,res)=>{
    const request=JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString()) as Request;requests.push(request)
    const result=reply(request,requests.length),delta=result.tool?{role:'assistant',tool_calls:[{index:0,id:`call-${requests.length}`,type:'function',function:{name:result.tool.name,arguments:JSON.stringify(result.tool.input)}}]}:{role:'assistant',content:result.text??''}
    const frame=(delta:unknown,finish:string|null)=>'data: '+JSON.stringify({id:`r-${requests.length}`,object:'chat.completion.chunk',created:1,model:'fixture-observed',choices:[{index:0,delta,finish_reason:finish}]})+'\n\n'
    res.writeHead(200,{'content-type':'text/event-stream'});res.end(frame(delta,null)+frame({},result.finish??(result.tool?'tool_calls':'stop'))+'data: [DONE]\n\n')
  });server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw Error('port')
  const config={baseURL:`http://127.0.0.1:${address.port}/v1`,apiKey:'owned-fixture-key',model:'fixture-requested'}
  const sessions=makeApiSessionStore(db),provider=createApiTaskProvider({sessions,model:createApiModel(config),configHash:apiTaskConnectionHash(config),configuredModel:config.model,privateStateDir:state})
  const registry=createProviderRegistry();registry.register('openai',provider,{displayName:'API fixture',canResume:provider.canResume,workbench:MANAGED_API_CAPABILITIES})
  const store=makeWorkbenchStore(db);service=makeWorkbenchService({store,registry,stateDir:state,ownerChatId:()=> 'owner'})
  return{requests,store,sessions,registry}
}
const settle=async(id:string)=>{await expect.poll(()=>service.detail(id).task.status).not.toMatch(/^(running|queued|cancelling)$/)}

it('completes an API task through the real service, collects an artifact and continues with the actual protocol history',async()=>{
  const fixture=await endpoint((_request,count)=>count===1?{tool:{name:'SaveArtifact',input:{name:'report.md',content:'# Actual artifact\n42'}}}:count===2?{text:'Saved report.md with 42.'}:{text:'The saved report contains 42.'})
  const task=service.create({path:project,providerId:'openai',text:'Generate report'})
  await expect.poll(()=>({count:service.detail(task.id).permissions.length,status:service.detail(task.id).task.status,events:service.detail(task.id).events})).toMatchObject({count:1})
  expect(existsSync(join(project,'.cc-workbench',task.id,'report.md'))).toBe(false)
  const permission=service.detail(task.id).permissions[0]!;expect(permission.description).toContain('report.md')
  service.resolvePermission(task.id,permission.id,'allow');await settle(task.id)
  const detail=service.detail(task.id)
  expect(detail.task.status,JSON.stringify(detail.events)).toBe('completed')
  expect(detail.artifacts.map(a=>a.name)).toEqual(['report.md'])
  expect(readFileSync(join(project,'.cc-workbench',task.id,'report.md'),'utf8')).toBe('# Actual artifact\n42')
  expect(detail.lastExecution?.effective?.model).toBe('fixture-observed')
  expect(fixture.requests[0]?.tools.map(t=>t.function.name)).toEqual(['ReadFile','ListFiles','SaveArtifact'])
  expect(JSON.stringify(fixture.requests)).not.toContain('WECHAT_SESSION_TOKEN')
  expect(service.prepareContinuation(task.id).mode).toBe('resume')
  service.continueTask(task.id,'What did it contain?');await settle(task.id)
  expect(service.detail(task.id).task.status).toBe('completed')
  expect(fixture.requests).toHaveLength(3)
  expect(fixture.requests[2]?.messages.some(m=>m.role==='tool'&&String(m.content).includes('Saved'))).toBe(true)
  expect(service.detail(task.id).events.filter(e=>e.kind==='text').map(e=>e.text).join(' ')).toContain('42')
})

it('stops a pending API tool at the real permission bridge and refuses replay after restarting the adapter',async()=>{
  const fixture=await endpoint(()=>({tool:{name:'SaveArtifact',input:{name:'late.md',content:'never'}}}))
  const task=service.create({path:project,providerId:'openai',text:'save'})
  await expect.poll(()=>({count:service.detail(task.id).permissions.length,status:service.detail(task.id).task.status,events:service.detail(task.id).events})).toMatchObject({count:1})
  const requestId=service.detail(task.id).permissions[0]!.id
  await service.cancel(task.id);await settle(task.id)
  expect(service.detail(task.id).task.status).toBe('cancelled')
  expect(()=>service.resolvePermission(task.id,requestId,'allow')).toThrow('permission_stale')
  expect(existsSync(join(project,'.cc-workbench',task.id,'late.md'))).toBe(false)
  expect(fixture.requests).toHaveLength(1)
  const id=fixture.store.get(task.id).sessionId!
  expect(fixture.sessions.get(id)?.state).toBe('interrupted')
  expect(service.prepareContinuation(task.id).mode).toBe('restart_required')
})

it.each([{name:'Shell',input:{command:'touch escaped'},error:'unsupported_api_tool'},{name:'ReadFile',input:{},error:'invalid_api_file_path'}])('returns a recorded error for $name without executing an invalid or unavailable tool',async(tool)=>{
  const fixture=await endpoint((_request,count)=>count===1?{tool}:{text:'That operation is unavailable; here is what I can do instead.'})
  const task=service.create({path:project,providerId:'openai',text:'try the request'});await settle(task.id)
  expect(service.detail(task.id).task.status,JSON.stringify(service.detail(task.id).events)).toBe('completed')
  expect(fixture.requests).toHaveLength(2)
  expect(fixture.requests[1]?.messages.some(m=>m.role==='tool'&&String(m.content).includes(tool.error))).toBe(true)
  expect(service.detail(task.id).permissions).toHaveLength(0)
  expect(service.detail(task.id).events.some(e=>e.activity?.label===tool.name&&e.activity.status==='failed')).toBe(true)
  expect(existsSync(join(project,'escaped'))).toBe(false)
})
