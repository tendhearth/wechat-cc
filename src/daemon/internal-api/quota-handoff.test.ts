import {afterEach,beforeEach,describe,expect,it} from 'vitest'
import {randomUUID} from 'node:crypto'
import {mkdirSync,mkdtempSync,readFileSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openDb,type Db} from '../../lib/db'
import {removeTempDir} from '../../lib/test-temp'
import {createProviderRegistry} from '../../core/provider-registry'
import {makeWorkbenchStore} from '../../core/workbench/store'
import {makeWorkbenchService,type WorkbenchService} from '../../core/workbench/service'
import {MANAGED_NATIVE_CAPABILITIES} from '../../core/workbench/executor-capabilities'
import {createInternalApi,type InternalApi} from './index'

const QUOTA="You've hit your usage limit. Try again at 10:00"
describe('desktop quota handoff through the authenticated HTTP handler and real service',()=>{
 let dir:string,project:string,db:Db,workbench:WorkbenchService,api:InternalApi,base:string,operator:string,trusted:string,admin:string,guest:string
 let unblock:()=>void=()=>{}
 const blocked=new Set<string>()
 const prompts:Array<{provider:string,text:string}>=[]
 beforeEach(async()=>{
  prompts.length=0;blocked.clear();dir=realpathSync(mkdtempSync(join(tmpdir(),'desktop-quota-handoff-')));project=join(dir,'project');mkdirSync(project)
  db=openDb({path:join(dir,'state.db')});const registry=createProviderRegistry()
  for(const provider of ['claude','codex','cursor'])registry.register(provider,{async spawn(){return{async *dispatch(text:string){prompts.push({provider,text});yield{kind:'init',sessionId:provider};if(text==='stay busy')await new Promise<void>(resolve=>{unblock=resolve});yield provider==='claude'?{kind:'error',message:QUOTA}:{kind:'text',text:'finished'};yield{kind:'result',sessionId:provider}},async close(){unblock()}}}} as never,{displayName:provider,canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  workbench=makeWorkbenchService({store:makeWorkbenchStore(db),registry,stateDir:dir,ownerChatId:()=> 'owner',usage:id=>blocked.has(id)?{providerId:id==='claude'?'claude':'codex',plan:null,windows:[{name:'window',usedPercent:100,resetsAt:Date.now()+3600000,durationMins:60}],exhausted:true,fetchedAt:Date.now()}:null})
  api=createInternalApi({stateDir:dir,daemonPid:1,workbench,resolveAdminChatId:()=> 'owner'} as never)
  admin=api.mintSessionToken('admin','owner');guest=api.mintSessionToken('guest','guest')
  const started=await api.start();base=`http://127.0.0.1:${started.port}`;operator=readFileSync(started.operatorTokenFilePath,'utf8').trim();trusted=readFileSync(started.tokenFilePath,'utf8').trim()
 })
 afterEach(async()=>{unblock();await api?.stop();await workbench?.shutdown();db?.close();removeTempDir(dir)})
 const post=(body:unknown,token=operator,path='/v1/workbench/quota-handoff')=>fetch(base+path,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)})
 const get=async(id:string)=>{const response=await fetch(base+`/v1/workbench/task?id=${id}`,{headers:{authorization:`Bearer ${operator}`}});expect(response.status).toBe(200);return response.json()}
 const exhausted=async()=>{const source=workbench.create({path:project,providerId:'claude',title:'修登录页',text:'original private conversation'});await expect.poll(()=>workbench.detail(source.id).task.status).toBe('failed');return source}
 it('projects read-only offers and creates one actual task in the same folder, preserving idempotency',async()=>{
  const source=await exhausted(),input={id:source.id,requestId:randomUUID(),providerId:'codex'}
  const detail=await get(source.id);expect(detail.quotaHandoff).toMatchObject({state:'offer',from:'claude',to:'codex'});expect(workbench.list().tasks).toHaveLength(1)
  const response=await post(input);expect(response.status).toBe(202);const made=await response.json();expect(made).toMatchObject({created:true});expect(made.taskId).not.toBe(source.id)
  expect(workbench.detail(made.taskId).task).toMatchObject({path:project,providerId:'codex',title:'修登录页'})
  await expect.poll(()=>prompts.some(p=>p.provider==='codex')).toBe(true);expect(prompts.find(p=>p.provider==='codex')?.text).toContain('接替 Claude');expect(prompts.find(p=>p.provider==='codex')?.text).not.toContain('original private conversation')
  expect((await get(source.id)).quotaHandoff).toEqual({state:'handed',from:'claude',to:'codex',matterId:made.taskId})
  for(const requestId of [input.requestId,randomUUID()]){const repeated=await post({...input,requestId});expect(repeated.status).toBe(202);expect(await repeated.json()).toEqual({taskId:made.taskId,created:false})}
  expect(workbench.list().tasks).toHaveLength(2)
 })
 it('enforces admin tier, the exact operator route and strict body without owner injection',async()=>{
  const source=await exhausted(),input={id:source.id,requestId:randomUUID(),providerId:'codex'}
  for(const token of [trusted,guest])expect((await post(input,token)).status).toBe(403)
  const restricted=api.mintSessionToken('admin','restricted',{routeAllow:new Set(['GET /v1/workbench/task'])});expect((await post(input,restricted)).status).toBe(403)
  for(const body of [null,[],{}, {...input,requestId:'bad'}, {...input,id:'bad'}, {...input,providerId:'Bad Id'},...['owner','ownerChatId','accountId','surface','path','text'].map(key=>({...input,[key]:'forged'}))])expect((await post(body)).status).toBe(400)
  expect((await post(input,operator,'/v1/workbench/quota-handoff?owner=forged')).status).toBe(400)
  for(const suffix of ['/','/extra','-extra'])expect((await post(input,operator,'/v1/workbench/quota-handoff'+suffix)).status).toBe(404)
  expect((await fetch(base+'/v1/workbench/quota-handoff',{headers:{authorization:`Bearer ${operator}`}})).status).toBe(404)
  expect(workbench.list().tasks).toHaveLength(1)
  expect((await post(input,admin)).status).toBe(202)
 })
 it('keeps ownership on the server and rejects a task owned by someone else',async()=>{
  const source=await exhausted();db.query('UPDATE workbench_tasks SET owner_chat_id=? WHERE id=?').run('someone-else',source.id)
  expect((await get(source.id)).quotaHandoff).toBeNull()
  const rejected=await post({id:source.id,requestId:randomUUID(),providerId:'codex'});expect(rejected.status).toBe(403);expect(await rejected.json()).toEqual({error:'invalid_entry_owner'})
  expect(workbench.list().tasks).toHaveLength(1)
 })
 it('rejects stale candidates and busy sources without creating another task',async()=>{
  const source=await exhausted(),input={id:source.id,requestId:randomUUID(),providerId:'codex'}
  blocked.add('codex');expect((await get(source.id)).quotaHandoff).toMatchObject({state:'offer',to:'cursor'})
  const changed=await post(input);expect(changed.status).toBe(409);expect(await changed.json()).toEqual({error:'quota_handoff_changed'})
  blocked.add('cursor');expect((await get(source.id)).quotaHandoff).toMatchObject({state:'none'})
  const unavailable=await post({...input,providerId:'cursor'});expect(unavailable.status).toBe(503);expect(await unavailable.json()).toEqual({error:'quota_handoff_unavailable'})
  blocked.clear()
  const busy=workbench.create({path:project,providerId:'codex',text:'stay busy'})
  await expect.poll(()=>workbench.detail(busy.id).task.status).toBe('running')
  const rejected=await post({...input,id:busy.id,requestId:randomUUID(),providerId:'cursor'});expect(rejected.status).toBe(409);expect(await rejected.json()).toEqual({error:'workbench_busy'})
  expect(workbench.list().tasks).toHaveLength(2)
 })
})
