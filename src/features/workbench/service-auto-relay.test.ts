import {afterEach,expect,it,vi} from 'vitest'
import {execFileSync} from 'node:child_process'
import {existsSync,unlinkSync,writeFileSync,mkdtempSync,mkdirSync,realpathSync,renameSync,symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {openTestDb} from '../../lib/db'
import {removeTempDir} from '../../lib/test-temp'
import {makeWorkbenchStore} from '../../adapters/store/workbench/store'
import {makeMatterStore} from '../../adapters/store/matters-store'
import {makePlacesStore} from '../../adapters/store/places-store'
import {createProviderRegistry} from '../../app/provider-registry'
import {MANAGED_NATIVE_CAPABILITIES,MANAGED_API_CAPABILITIES,UNATTENDED_CAPABILITIES} from '../../domain/workbench/executor-capabilities'
import type {UsageSnapshot} from '../../domain/subscription-usage'
import type {AgentEvent,AgentInputAcceptance,AgentRuntimeSnapshot,SpawnContext} from '../../ports/agent-provider'
import {AsyncQueue} from '../../lib/async-queue'
import {makeWorkbenchService,type WorkbenchService} from './service'
import {ledgerRoutes} from './ledger-routes'
import {createOpenAiAgentProvider} from '../../adapters/executors/openai/openai-agent-provider'
import {scriptedOpenAiModel,scriptedMcpTools} from '../../test-support/executors/openai-scripted'
import {collectTurn} from '../../ports/agent-provider'
import {MatterPlanRequest} from '../../../packages/protocol/src/desktop-api'
import {prepareChatApprovalPrompt} from '../../adapters/executors/chat-approval'
import {makeReportOutboxStore} from '../reports/outbox'
import {makeReportSink} from '../reports/report-sink'
import {TIER_PROFILES} from '../../domain/user-tier'

vi.setConfig({testTimeout:30_000})
const cleanups:Array<()=>Promise<void>>=[]
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup()})
function setup(retainedFirst:boolean|'all'=false,signals=true,extra:Partial<Parameters<typeof makeWorkbenchService>[0]>={}){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cc-auto-relay-'))),project=join(root,'project'),stateDir=join(root,'state');mkdirSync(project);mkdirSync(stateDir)
  const db=openTestDb(),store=makeWorkbenchStore(db),matters=makeMatterStore(db),registry=createProviderRegistry()
  const calls:Array<{executor:string;context:SpawnContext;text:string;queue:AsyncQueue<AgentEvent>;idle?:(mode?:AgentRuntimeSnapshot['input'])=>void}>=[],notices:string[]=[],ordinaryReports:string[]=[],order:string[]=[]
  let nextBlock:null|'quota'|'refused'|'ack'=null
  let nextInputAck:Promise<AgentInputAcceptance>|undefined
  for(const executor of ['codex','claude','openai'])registry.register(executor,{async spawn(_p,context){
    const queue=new AsyncQueue<AgentEvent>()
    order.push(`spawn:${executor}`)
    if(retainedFirst&&executor==='codex'&&(retainedFirst==='all'||!calls.length)){
      let snapshot:AgentRuntimeSnapshot={retained:true,foreground:'running',backgroundCount:0,input:'send'}
      return {workbenchRuntime:{events:queue.iterable(),snapshot:()=>snapshot,start(text){calls.push({executor,context,text,queue,idle:(input=snapshot.input)=>{snapshot={...snapshot,foreground:'idle',input}}})},async submit(_id,text){snapshot={...snapshot,foreground:'running'};calls.push({executor,context,text,queue,idle:(input=snapshot.input)=>{snapshot={...snapshot,foreground:'idle',input}}});const ack=nextInputAck;nextInputAck=undefined;return ack}},async *dispatch(){},async close(){order.push(`close:${executor}`);queue.end()}}
    }
    return {dispatch(text){calls.push({executor,context,text,queue});return queue.iterable()},async close(){order.push(`close:${executor}`);queue.end()}}
  }},{displayName:executor,canResume:()=>executor!=='openai',workbench:executor==='openai'?MANAGED_API_CAPABILITIES:MANAGED_NATIVE_CAPABILITIES})
  const opts={store,registry,stateDir,managedWorkspaceRoot:join(root,'Tasks'),ownerChatId:()=>'owner',matters,
    usage:(id:string):UsageSnapshot|null=>id==='claude'&&nextBlock==='quota'?{providerId:'claude',plan:null,fetchedAt:Date.now(),exhausted:true,windows:[{name:'5h',usedPercent:100,resetsAt:Date.now()+3600_000,durationMins:300}]}:null,
    ...(signals?{refusal:(id:string)=>id==='claude'&&nextBlock==='refused'?{code:'refused',since:'2026-11-14T00:00:00Z'}:null}:{}),executionConflict:()=>false,reports:{enqueue(id:string){ordinaryReports.push(id)},enqueueRelay(_id:string,text:string){notices.push(text)},async enqueueComparison(_id:string,text:string){notices.push(text)}}}
  Object.assign(opts,extra)
  let service=makeWorkbenchService(opts)
  cleanups.push(async()=>{await service.shutdown();db.close();removeTempDir(root)})
  const request=()=>({requestId:randomUUID(),target:{kind:'managed' as const},title:'三棒接力',legs:[{executor:'codex',brief:'出三张图'},{executor:'claude',brief:'接入插图'},{executor:'openai',brief:'跑测试'}]})
  const create=async()=>{const result=await service.matterPlan(request());await expect.poll(()=>calls.length).toBe(1);return result.task.id}
  const finish=async(index:number,text='已完成。',error=false)=>{const call=calls[index]!;call.idle?.();call.queue.push({kind:'init',sessionId:call.context.resumeSessionId??`session-${index}`});call.queue.push({kind:'text',itemId:'private',text:'RAW_TRANSCRIPT_CANARY'});call.queue.push({kind:'text',itemId:'final',text});if(error)call.queue.push({kind:'error',message:'synthetic_failure'});else call.queue.push({kind:'result',sessionId:call.context.resumeSessionId??`session-${index}`,numTurns:1,durationMs:1});if(!call.idle)call.queue.end()}
  return {root,project,db,store,matters,registry,calls,notices,ordinaryReports,order,request,create,finish,holdNextInputAck(ack:Promise<AgentInputAcceptance>){nextInputAck=ack},blockNext(mode:typeof nextBlock){nextBlock=mode;if(mode==='ack')registry.get('claude')!.opts.workbench=UNATTENDED_CAPABILITIES},get service(){return service},async restart(overrides:Partial<Parameters<typeof makeWorkbenchService>[0]>={}){await service.shutdown();service=makeWorkbenchService({...opts,...overrides})}}
}

it.each([false,true])('one leg creates an ordinary task without a relay plan or relay report (retained=%s)',async retained=>{
  const f=setup(retained),request={...f.request(),title:'整理插图',legs:[{executor:'codex',brief:'整理插图'}]}
  f.db.exec("CREATE TRIGGER reject_single_plan BEFORE INSERT ON matter_plans BEGIN SELECT RAISE(ABORT,'single_must_not_write_plan'); END")
  f.db.exec("CREATE TRIGGER reject_single_leg BEFORE INSERT ON matter_plan_legs BEGIN SELECT RAISE(ABORT,'single_must_not_write_leg'); END")
  const first=await f.service.matterPlan(request),id=first.task.id
  expect((await f.service.matterPlan(request)).receipt).toEqual(first.receipt)
  await expect.poll(()=>f.calls.length).toBe(1)
  expect(f.store.list()).toHaveLength(1)
  expect(f.matters.list({kind:'task'})).toHaveLength(1)
  expect(f.matters.get(id)?.originMatterId).toBeTruthy()
  expect(f.db.query('SELECT * FROM matter_plans').all()).toEqual([])
  expect(f.db.query('SELECT * FROM matter_plan_legs').all()).toEqual([])
  expect(f.service.detail(id).agentRuns).toBeUndefined()
  expect(f.calls[0]!.text).not.toContain('matter_ledger_data')
  await f.finish(0)
  await expect.poll(()=>f.ordinaryReports).toEqual([id])
  expect(f.notices).toEqual([])
  expect(f.calls).toHaveLength(1)
  expect(f.service.detail(id).events.some(e=>e.text?.includes('棒都做完了'))).toBe(false)
  await expect(f.service.matterPlan({...request,legs:[...request.legs,{executor:'claude',brief:'接着做'}]})).rejects.toThrow('creation_conflict')
})

it.each([0,7])('rejects %s legs with a Chinese explanation and creates nothing',async length=>{
  const f=setup(),route=ledgerRoutes({workbench:f.service,resolveAdminChatId:()=>'owner'})['POST /v1/matter/plan']!
  const result=await route(new URLSearchParams(),{...f.request(),legs:Array.from({length},()=>({executor:'codex',brief:'整理插图'}))},{tier:'admin',origin:'session',chatId:'owner'})
  expect(result.status).toBe(400)
  expect(result.body).toMatchObject({error:'invalid_matter_plan',approved:false,message:expect.stringContaining('1–6')})
  expect(JSON.stringify(result.body)).toContain('没建成')
  expect(f.store.list()).toEqual([])
  expect(f.db.query('SELECT * FROM matter_plans').all()).toEqual([])
  expect(f.db.query('SELECT * FROM matter_plan_legs').all()).toEqual([])
  expect(f.calls).toEqual([])
})

it('fills the desktop default before showing the approval card and keeps the original input bound to it',async()=>{
 const context={scope:'default-executor-turn'},caller={chatId:'owner',provider:'codex'}
 const f=setup(false,true,{defaultProvider:'claude',planConversation:()=>context})
 const {requestId:_id,...body}=f.request(),input={...body,title:'加个收藏',legs:[{brief:'加一个收藏按钮'}]}
 const shown=structuredClone(input),tool='mcp__wechat__matter_plan'
 expect(MatterPlanRequest.safeParse(input).success).toBe(true)
 expect(f.service.entryOptions({ownerKey:'owner',surface:'desktop'}).defaultProviderId).toBe('claude')
 const {prompt:card}=await prepareChatApprovalPrompt('Codex',tool,shown,'test',{
   resolveMatterPlan:(args,chatId,provider)=>f.service.matterPlanPreview(args as typeof input,{chatId,provider}),
 },'owner')
 expect(card).toContain('确认交办：加个收藏')
 expect(card).toContain('第 1 棒 · claude：\n│ 加一个收藏按钮')
 expect(shown.legs).toEqual([{executor:'claude',brief:'加一个收藏按钮'}])
 expect(f.calls).toEqual([])
 f.service.noteMatterApproval(tool,input,caller)
 expect(f.service.matterApprovalStatus(tool,shown,caller)).toBe(true)
 const route=ledgerRoutes({workbench:f.service,resolveAdminChatId:()=>'owner',planConversation:()=>context})['POST /v1/matter/plan']!
 const post=(args:unknown)=>route(new URLSearchParams(),args,{tier:'admin',origin:'session',...caller})
 f.blockNext('quota')
 expect(await post(input)).toMatchObject({status:409,body:{error:'provider_quota_exhausted',approved:true}})
 expect(f.calls).toEqual([])
 f.blockNext(null)
 const result=await post(input)
 expect(result).toMatchObject({status:202,body:{task:{providerId:'claude'}}})
 f.blockNext('quota')
 expect(await post(input)).toEqual(result)
 expect(await post(shown)).toEqual(result)
 await expect.poll(()=>f.calls.map(call=>call.executor)).toEqual(['claude'])
})

it.each(['quota','ack'] as const)('replays the accepted default when it is blocked by %s',async block=>{
 const f=setup(false,true,{defaultProvider:'claude'})
 const input={...f.request(),legs:[{brief:'加收藏'}]}
 const first=await f.service.matterPlan(input)
 await expect.poll(()=>f.calls.map(call=>call.executor)).toEqual(['claude'])
 f.blockNext(block)
 expect((await f.service.matterPlan(input)).receipt).toEqual(first.receipt)
 await expect(f.service.matterPlan({...input,legs:[{brief:'改成导出'}]})).rejects.toThrow('creation_conflict')
 await expect(f.service.matterPlan({...input,legs:[{executor:'codex',brief:'加收藏'}]})).rejects.toThrow('creation_conflict')
 expect(f.calls).toHaveLength(1)
})

it('replays the accepted default after the configured default changes',async()=>{
 const f=setup(false,true,{defaultProvider:'claude'})
 const input={...f.request(),legs:[{brief:'加收藏'}]}
 const first=await f.service.matterPlan(input)
 await expect.poll(()=>f.calls.map(call=>call.executor)).toEqual(['claude'])
 await f.finish(0)
 await f.restart({defaultProvider:'codex'})
 expect(f.service.planExecutors().defaultProviderId).toBe('codex')
 expect((await f.service.matterPlan(input)).receipt).toEqual(first.receipt)
 expect(f.calls).toHaveLength(1)
})

it.each([
 ['quota','额度已用完'],
 ['ack','请先在电脑上确认免审执行'],
] as const)('explains why the configured default is blocked by %s',async(block,reason)=>{
 const f=setup(false,true,{defaultProvider:'claude'})
 f.blockNext(block)
 const input={...f.request(),legs:[{brief:'加收藏'}]}
 const route=ledgerRoutes({workbench:f.service,resolveAdminChatId:()=>'owner'})['POST /v1/matter/plan']!
 const post=()=>route(new URLSearchParams(),input,{tier:'admin',origin:'session',chatId:'owner'})
 expect(await post()).toMatchObject({status:409,body:{error:'unavailable_provider',message:expect.stringContaining('当前可用的执行者 id：codex、openai')}})
 expect(await post()).toMatchObject({body:{message:expect.stringContaining(reason)}})
 for(const id of ['codex','openai'])f.registry.get(id)!.opts.workbench=undefined
 const result=await post()
 expect(result).toMatchObject({body:{message:expect.stringContaining(reason)}})
 expect(result.body).not.toMatchObject({message:expect.stringContaining('连接一位工作执行者')})
 expect(f.calls).toEqual([])
})

it.each([
 {label:'missing executor in a relay',legs:[{brief:'改'},{executor:'claude',brief:'检查'}],status:400,error:'invalid_matter_plan',message:'多棒时每棒都要填'},
 {label:'no available executor',legs:[{brief:'改'}],empty:true,status:409,error:'unavailable_provider',message:'现在没有可用的执行者'},
 {label:'unknown executor',legs:[{executor:'CC',brief:'改'}],status:409,error:'unavailable_provider',message:'当前可用的执行者 id：codex、claude、openai'},
 {label:'no default with other executors available',legs:[{brief:'改'}],status:409,error:'unavailable_provider',message:'当前可用的执行者 id：codex、claude、openai'},
])('rejects $label with actionable feedback',async({legs,empty,status,error,message})=>{
 const f=setup()
 if(empty)for(const id of f.registry.list())f.registry.get(id)!.opts.workbench=undefined
 const input={...f.request(),legs}
 expect(MatterPlanRequest.safeParse(input).success).toBe(status!==400)
 const route=ledgerRoutes({workbench:f.service,resolveAdminChatId:()=>'owner'})['POST /v1/matter/plan']!
 expect(await route(new URLSearchParams(),input,{tier:'admin',origin:'session',chatId:'owner'})).toMatchObject({
   status,body:{error,approved:false,message:expect.stringContaining(message)},
 })
 expect(f.store.list()).toEqual([])
 expect(f.calls).toEqual([])
})

it('three approved legs run in order with ledger openings and no prior raw transcript',async()=>{
  const f=setup(),id=await f.create()
  expect(f.service.detail(id).agentRuns?.map(a=>a.status)).toEqual(['running','queued','queued'])
  expect(f.store.plans.get(id)).toMatchObject({state:'approved',legs:[{position:1,state:'running',autoDispatches:0},{position:2,state:'pending'},{position:3,state:'pending'}]})
  for(let index=0;index<3;index++){
    expect(f.calls[index]!.text).toContain('matter_ledger_data')
    expect(f.calls[index]!.text).not.toContain('RAW_TRANSCRIPT_CANARY')
    expect(f.calls[index]!.context.resumeSessionId).toBeUndefined()
    await f.finish(index)
    if(index<2)await expect.poll(()=>f.calls.length).toBe(index+2)
  }
  await expect.poll(()=>f.store.plans.get(id)?.state).toBe('done')
  expect(f.store.plans.get(id)?.legs.map(l=>[l.state,l.autoDispatches])).toEqual([['completed',0],['completed',1],['completed',1]])
  expect(f.notices).toHaveLength(3)
  expect(f.ordinaryReports).toEqual([])
  expect(f.matters.list({kind:'task'})).toHaveLength(1)
})

it('retained completion closes the previous writer before dispatch and ignores duplicate settlements',async()=>{
  const f=setup(true),id=await f.create();await f.finish(0)
  await expect.poll(()=>f.calls.length).toBe(2)
  expect(f.order.slice(0,3)).toEqual(['spawn:codex','close:codex','spawn:claude'])
  expect(f.store.plans.get(id)?.legs[1]?.autoDispatches).toBe(1)
  expect(f.notices).toHaveLength(1);expect(f.ordinaryReports).toEqual([])
})

it('closing a retained final leg after done never emits an ordinary duplicate report',async()=>{
  const f=setup('all'),request=f.request();request.legs=[{executor:'claude',brief:'先做'},{executor:'codex',brief:'收尾'}]
  const id=(await f.service.matterPlan(request)).task.id
  await expect.poll(()=>f.calls.length).toBe(1);await f.finish(0)
  await expect.poll(()=>f.calls.length).toBe(2);await f.finish(1)
  await expect.poll(()=>f.store.plans.get(id)?.state).toBe('done')
  await f.service.cancel(id)
  await expect.poll(()=>f.service.detail(id).task.status).toBe('completed')
  expect(f.ordinaryReports).toEqual([]);expect(f.notices).toHaveLength(2)
})

it('manual handoff of a quiet retained plan does not announce a false automatic stop',async()=>{
  const f=setup(true),id=await f.create();await f.finish(0)
  await f.service.matterHandoff(id,'openai','主人手动换人')
  expect(f.store.plans.get(id)?.state).toBe('cancelled')
  expect(f.notices.some(text=>text.includes('停在'))).toBe(false)
})

it('a retained continuation without this turn conclusion cannot reuse an earlier done reply',async()=>{
  const f=setup(true),id=await f.create(),first=f.calls[0]!
  f.store.liveInputs.add({id:randomUUID(),taskId:id,runId:f.service.detail(id).runId!,text:'等一下'})
  await f.finish(0)
  await expect.poll(()=>f.service.detail(id).events.some(e=>e.text==='已完成。')).toBe(true)
  for(const input of f.store.liveInputs.list(id))f.store.liveInputs.set(input.id,'withdrawn')
  await f.service.submitInput(id,{runId:f.service.detail(id).runId!,requestId:randomUUID(),text:'继续'})
  await expect.poll(()=>f.calls.length).toBe(2)
  first.idle!();first.queue.push({kind:'result',sessionId:'session-0',numTurns:2,durationMs:1})
  await expect.poll(()=>f.store.plans.get(id)?.legs[0]?.stopReason).toBe('leg_silent')
  expect(f.calls).toHaveLength(2)
})

it.each(['question','permission'] as const)('retained %s stops before closing its request bridge',async kind=>{
  const f=setup(true),id=await f.create(),context=f.calls[0]!.context
  if(kind==='question')void context.requestUserInput!({questions:[{id:'choice',header:'选择',question:'用哪一版？',options:[],allowOther:true}]})
  else void context.requestPermission!({tool:'Bash',description:'需要批准',command:'echo offline'})
  await expect.poll(()=>f.service.detail(id)[kind==='question'?'questions':'permissions'].length).toBe(1)
  await f.finish(0)
  await expect.poll(()=>f.store.plans.get(id)?.legs[0]?.stopReason).toBe('leg_asked')
  expect(f.calls).toHaveLength(1);expect(f.notices).toHaveLength(1)
  expect(f.notices[0]).not.toContain('继续')
})

it.each([['failed','没能完成。',true,'leg_failed'],['asked','请确认用哪一版。',false,'leg_asked']] as const)('second leg %s stops, continuing resumes that same baton then completes third',async(_label,text,error,reason)=>{
  const f=setup(),id=await f.create();await f.finish(0);await expect.poll(()=>f.calls.length).toBe(2)
  const baton=f.store.plans.get(id)!.legs[1]!.runId
  await f.finish(1,text,error)
  await expect.poll(()=>f.store.plans.get(id)?.legs[1]?.state).toBe('stopped')
  expect(f.store.plans.get(id)?.legs[1]?.stopReason).toBe(reason);expect(f.calls).toHaveLength(2)
  expect(f.notices.at(-1)).toContain('第 2 棒')
  if(reason==='leg_asked')expect(f.notices.at(-1)).toBe('第 2 棒（Claude）在等你回话，你回了它接着做。')
  else expect(f.notices.at(-1)).toContain('说「继续」让它接着做')
  // 在等回话的那一棒:主人回的是答案,不必以「继续」开头,拆法照旧
  f.service.continueTask(id,reason==='leg_asked'?'用第二版':'继续')
  await expect.poll(()=>f.calls.length).toBe(3)
  expect(f.store.plans.get(id)?.state).toBe('approved')
  expect(f.store.plans.get(id)?.legs[1]).toMatchObject({state:'running',runId:baton,autoDispatches:1})
  await f.finish(2);await expect.poll(()=>f.calls.length).toBe(4);await f.finish(3)
  await expect.poll(()=>f.store.plans.get(id)?.state).toBe('done')
  expect(f.store.ledger.agents(id)).toHaveLength(3)
})

it('queued owner words wait for the current baton to finish its next round',async()=>{
  const f=setup(),id=await f.create(),run=f.service.detail(id).runId!
  f.store.liveInputs.add({id:randomUUID(),taskId:id,runId:run,text:'再加深色版'})
  await f.finish(0)
  await expect.poll(()=>f.calls.length).toBe(2)
  expect(f.calls[1]!.executor).toBe('codex')
  expect(f.store.plans.get(id)?.legs[0]?.state).toBe('running')
  expect(f.notices).toEqual([])
  await f.finish(1);await expect.poll(()=>f.calls.length).toBe(3)
  expect(f.calls[2]!.executor).toBe('claude')
})

it.each(['manual','new-round'] as const)('%s takes over and cancels remaining plan',async mode=>{
  const f=setup(),id=await f.create();await f.finish(0,'没能完成。')
  await expect.poll(()=>f.store.plans.get(id)?.legs[0]?.state).toBe('stopped')
  if(mode==='manual')expect(await f.service.matterHandoff(id,'openai','换人继续')).toMatchObject({planCancelled:true})
  else f.service.continueTask(id,'另起一轮，重新整理')
  expect(f.store.plans.get(id)?.state).toBe('cancelled')
  await expect.poll(()=>f.calls.length).toBe(2);await f.finish(1)
  await expect.poll(()=>f.service.detail(id).task.status).toBe('completed')
  expect(f.calls).toHaveLength(2)
  expect(f.service.ledgerRead(id).agentRuns?.some(a=>a.status==='queued')).toBe(false)
})

it('restart stops running plan legs and never redispatches',async()=>{
  const f=setup(),id=await f.create();await f.restart()
  expect(f.store.plans.get(id)?.legs[0]).toMatchObject({state:'stopped',stopReason:'leg_interrupted'})
  await Promise.resolve();expect(f.calls).toHaveLength(1)
})

it('a persisted running leg with no live run is interrupted after a crash window',async()=>{
  const f=setup(),id=await f.create();await f.service.shutdown()
  f.db.query("UPDATE matter_plan_legs SET state='running',stop_reason=NULL WHERE matter_id=? AND position=1").run(id)
  await f.restart()
  expect(f.store.plans.get(id)?.legs[0]).toMatchObject({state:'stopped',stopReason:'leg_interrupted'})
  expect(f.calls).toHaveLength(1)
})

it('cancelling a plan leg still queued behind another writer stops the leg without dispatch',async()=>{
  const f=setup(true)
  f.service.create({path:f.project,providerId:'codex',text:'先占用目录'})
  await expect.poll(()=>f.calls.length).toBe(1)
  f.service.addProject({path:f.project,providerId:'codex'})
  const request=f.request(),project=f.service.projects().find(p=>p.path===f.project)!
  const id=(await f.service.matterPlan({...request,target:{kind:'project',projectId:project.id}})).task.id
  expect(f.service.detail(id).task.status).toBe('queued')
  await f.service.cancel(id)
  await expect.poll(()=>f.store.plans.get(id)?.legs[0]?.state).toBe('stopped')
  expect(f.store.plans.get(id)?.legs[0]?.stopReason).toBe('leg_cancelled')
  expect(f.calls).toHaveLength(1);expect(f.notices).toHaveLength(1)
})

it('owner stopping a quiet retained leg waiting on queued input must not dispatch the next leg',async()=>{
  const f=setup(true),id=await f.create()
  f.store.liveInputs.add({id:randomUUID(),taskId:id,runId:f.service.detail(id).runId!,text:'等一下'})
  await f.finish(0)
  await expect.poll(()=>f.service.detail(id).events.some(e=>e.text==='已完成。')).toBe(true)
  await f.service.cancel(id)
  await expect.poll(()=>f.store.plans.get(id)?.legs[0]?.state).toBe('stopped')
  expect(f.store.plans.get(id)?.legs[0]?.stopReason).toBe('leg_cancelled')
  expect(f.calls).toHaveLength(1)
})

it.each(['quota','refused','ack'] as const)('real next executor %s admission prevents automatic dispatch',async mode=>{
  const f=setup(),id=await f.create();f.blockNext(mode);await f.finish(0)
  await expect.poll(()=>f.store.plans.get(id)?.legs[1]?.stopReason).toBe('next_unavailable')
  expect(f.store.plans.get(id)?.legs).toMatchObject([{state:'completed',stopReason:null},{state:'pending',runId:null,autoDispatches:0},{state:'pending',stopReason:null}])
  expect(f.notices.at(-1)).toBe(`第 1 棒（Codex）做完了，第 2 棒（Claude）没派出去：${{quota:'额度用完了',refused:'执行者的服务拒绝了请求',ack:'需要先确认免审执行'}[mode]}。好了之后说「继续」。`)
  expect(f.calls).toHaveLength(1)
})

it('missing executor refusal signal stops conservatively instead of inventing availability',async()=>{
  const f=setup(false,false),id=await f.create();await f.finish(0)
  await expect.poll(()=>f.store.plans.get(id)?.legs[1]?.stopReason).toBe('next_unavailable')
  expect(f.calls).toHaveLength(1)
})

it.each(['继续','继续 按原方案做'])('Wechat %s resumes the stopped baton instead of cancelling the plan',async command=>{
  const f=setup(),id=await f.create();await f.finish(0,'请确认。')
  await expect.poll(()=>f.store.plans.get(id)?.legs[0]?.state).toBe('stopped')
  const baton=f.store.plans.get(id)!.legs[0]!.runId
  await f.service.handleWechat('owner',`任务 ${id} ${command}`)
  await expect.poll(()=>f.calls.length).toBe(2)
  expect(f.store.plans.get(id)).toMatchObject({state:'approved',legs:[{state:'running',runId:baton},{state:'pending'},{state:'pending'}]})
})

it('an unregistered next executor holds the next leg without touching the third',async()=>{
  const f=setup(),id=await f.create()
  const original=f.registry.get.bind(f.registry)
  vi.spyOn(f.registry,'get').mockImplementation(executor=>executor==='claude'?null:original(executor))
  await f.finish(0)
  await expect.poll(()=>f.store.plans.get(id)?.legs[1]?.stopReason).toBe('next_unavailable')
  expect(f.store.plans.get(id)?.legs[0]).toMatchObject({state:'completed',stopReason:null})
  expect(f.notices.at(-1)).toContain('执行者还没登记')
  expect(f.calls).toHaveLength(1)
  expect(f.store.plans.get(id)?.legs.slice(1).map(l=>l.state)).toEqual(['pending','pending'])
})

it.each([false,true])('owner resumes the pending baton after quota recovery (retained=%s), then finishes the plan',async retained=>{
  const f=setup(retained),id=await f.create();f.blockNext('quota');await f.finish(0)
  await expect.poll(()=>f.notices.length).toBe(1)
  const first=f.store.plans.get(id)!.legs[0]!.runId
  f.blockNext(null)
  await f.service.handleWechat('owner',`任务 ${id} 继续`)
  await expect.poll(()=>f.calls.length).toBe(2)
  expect(f.calls.map(c=>c.executor)).toEqual(['codex','claude'])
  expect(f.store.plans.get(id)?.legs).toMatchObject([{state:'completed',runId:first},{state:'running',stopReason:null,autoDispatches:0},{state:'pending'}])
  expect(f.notices.at(-1)).toBe('Codex 做完了，Claude 接着做第 2 棒。')
  await f.finish(1);await expect.poll(()=>f.calls.length).toBe(3);await f.finish(2)
  await expect.poll(()=>f.store.plans.get(id)?.state).toBe('done')
  expect(f.store.ledger.agents(id)).toHaveLength(3)
})

it.each([false,true])('owner resume while quota is still exhausted reports the hold without rerunning the completed executor (retained=%s)',async retained=>{
  const f=setup(retained),id=await f.create();f.blockNext('quota');await f.finish(0)
  await expect.poll(()=>f.notices.length).toBe(1)
  const reply=await f.service.handleWechat('owner',`任务 ${id} 继续`)
  await expect.poll(()=>f.notices.length).toBe(2)
  expect(reply).not.toContain('已传达给执行者')
  expect(f.calls).toHaveLength(1)
  expect(f.store.plans.get(id)?.legs).toMatchObject([{state:'completed'},{state:'pending',stopReason:'next_unavailable',autoDispatches:0},{state:'pending'}])
  expect(f.notices[1]).toBe(f.notices[0])
})

it.each([false,true])('replaying the same owner resume receipt never sends another input to the next executor (retained=%s)',async retained=>{
  const f=setup(retained),id=await f.create();f.blockNext('quota');await f.finish(0)
  await expect.poll(()=>f.notices.length).toBe(1)
  f.blockNext(null)
  const identity={accountId:'offline',userId:'owner',msgId:'same-continue',createTimeMs:1}
  await f.service.handleWechat('owner',`任务 ${id} 继续`,identity)
  await expect.poll(()=>f.calls.length).toBe(2)
  const accepted=f.store.liveInputs.list(id)
  expect(accepted).toHaveLength(1);expect(accepted[0]?.status).toBe('delivered')
  await f.service.handleWechat('owner',`任务 ${id} 继续`,identity)
  expect(f.store.liveInputs.list(id)).toEqual(accepted)
  expect(f.calls).toHaveLength(2);expect(f.notices).toHaveLength(2)
})

it('resume waits for real queued owner input without changing it or restarting the completed baton',async()=>{
  const f=setup(),id=await f.create();f.blockNext('quota');await f.finish(0)
  await expect.poll(()=>f.notices.length).toBe(1);f.blockNext(null)
  const input=f.store.liveInputs.add({id:randomUUID(),taskId:id,runId:f.store.execution.last(id)!.runId,text:'还要加一版'})
  f.service.continueTask(id,'继续')
  expect(f.calls).toHaveLength(1);expect(f.store.liveInputs.get(input.id)).toEqual(input)
  expect(f.notices.at(-1)).toBe('你之前的补充还在等处理，接力先等一下。')
  expect(f.store.plans.get(id)?.legs).toMatchObject([{state:'completed'},{state:'pending',stopReason:'next_unavailable'},{state:'pending'}])
})

it('resume rejects a replacement directory using the persisted accepted directory identity',async()=>{
  const f=setup(),id=await f.create();f.blockNext('quota');await f.finish(0)
  await expect.poll(()=>f.notices.length).toBe(1);f.blockNext(null)
  const path=f.store.get(id).path
  renameSync(path,path+'-original');mkdirSync(path)
  f.service.continueTask(id,'继续')
  expect(f.calls).toHaveLength(1)
  expect(f.store.plans.get(id)?.legs[1]).toMatchObject({state:'pending',stopReason:'matter_blocked'})
  expect(f.notices.at(-1)).toContain('第 1 棒（Codex）做完了，第 2 棒（Claude）没派出去：工作区暂时不能继续开工')
})

it('a new owner request on a retained completed baton cancels its held relay plan',async()=>{
  const f=setup(true),id=await f.create();f.blockNext('quota');await f.finish(0)
  await expect.poll(()=>f.notices.length).toBe(1)
  await f.service.submitInput(id,{runId:f.service.detail(id).runId!,requestId:randomUUID(),text:'另起一轮，重新整理'})
  expect(f.store.plans.get(id)?.state).toBe('cancelled')
  expect(f.calls.map(c=>c.executor)).toEqual(['codex','codex'])
})

it.each([false,true])('held resume with new attachments rejects the unsupported combination without losing materials or claiming delivery (retained=%s)',async retained=>{
  const f=setup(retained),id=await f.create();f.blockNext('quota');await f.finish(0)
  await expect.poll(()=>f.notices.length).toBe(1);f.blockNext(null)
  const draftId=randomUUID(),attachment=f.service.uploadAttachment({id:randomUUID(),draftId,taskId:id,name:'brief.txt',mime:'text/plain',base64:Buffer.from('新材料').toString('base64')})
  const requestId=randomUUID(),materials={draftId,attachmentIds:[attachment.id]}
  if(retained)await expect(f.service.submitInput(id,{runId:f.service.detail(id).runId!,requestId,text:'继续',...materials})).rejects.toThrow('invalid_request')
  else expect(()=>f.service.continueTask(id,'继续',{inputRequestId:requestId,...materials})).toThrow('invalid_request')
  expect(f.store.liveInputs.get(requestId)).toBeNull();expect(f.calls).toHaveLength(1)
  expect(f.store.attachments.select([attachment.id],id,draftId)).toEqual([attachment])
  expect(f.store.plans.get(id)?.legs[1]).toMatchObject({state:'pending',stopReason:'next_unavailable'})
})

it.each(['plan_stale','next_already_tried'] as const)('owner resume passes the %s automatic-only guard without adding an automatic attempt',async reason=>{
  const f=setup(),id=await f.create()
  if(reason==='plan_stale')f.db.query('UPDATE matter_plans SET approved_at=? WHERE matter_id=?').run(Date.now()-8*86_400_000,id)
  else f.db.query('UPDATE matter_plan_legs SET auto_dispatches=1 WHERE matter_id=? AND position=2').run(id)
  await f.finish(0);await expect.poll(()=>f.store.plans.get(id)?.legs[1]?.stopReason).toBe(reason)
  f.service.continueTask(id,'继续')
  await expect.poll(()=>f.calls.length).toBe(2)
  expect(f.calls[1]!.executor).toBe('claude')
  expect(f.store.plans.get(id)?.legs[1]).toMatchObject({state:'running',stopReason:null,autoDispatches:reason==='plan_stale'?0:1})
})

it.each([['provider_quota_exhausted','next_unavailable','额度用完了'],['native_session_busy','matter_blocked','工作区暂时不能继续开工']] as const)('automatic handoff failing before acceptance with %s holds the pending baton',async(code,reason,message)=>{
  const f=setup(),id=await f.create()
  vi.spyOn(f.store,'switchExecutor').mockImplementationOnce(()=>{if(reason==='next_unavailable')f.blockNext('quota');throw Error(code)})
  await f.finish(0);await expect.poll(()=>f.store.plans.get(id)?.legs[1]?.stopReason).toBe(reason)
  expect(f.store.plans.get(id)?.legs).toMatchObject([{state:'completed',stopReason:null},{state:'pending',runId:null,autoDispatches:0},{state:'pending'}])
  expect(f.calls).toHaveLength(1);expect(f.store.ledger.agents(id)).toHaveLength(1)
  expect(f.notices.at(-1)).toContain(`没派出去：${message}。好了之后说「继续」。`)
})

it.each(['question','permission'] as const)('unanswered %s is captured before terminal cleanup',async kind=>{
  const f=setup(),id=await f.create(),context=f.calls[0]!.context
  if(kind==='question')void context.requestUserInput!({questions:[{id:'choice',header:'选择',question:'用哪一版？',options:[],allowOther:true}]})
  else void context.requestPermission!({tool:'Bash',description:'需要批准',command:'echo offline'})
  await expect.poll(()=>f.service.detail(id)[kind==='question'?'questions':'permissions'].length).toBe(1)
  await f.finish(0)
  await expect.poll(()=>f.store.plans.get(id)?.legs[0]?.stopReason).toBe('leg_asked')
  expect(f.calls).toHaveLength(1)
})

it('plan route rejects visitors, unrelated chats and nonconversation sources without creating work',async()=>{
  const f=setup(),route=ledgerRoutes({workbench:f.service,resolveAdminChatId:()=>'owner'})['POST /v1/matter/plan']!
  for(const caller of [undefined,{tier:'guest',origin:'session',chatId:'owner'},{tier:'admin',origin:'session',chatId:'other'},{tier:'admin',origin:'operator'},{tier:'admin',origin:'session',sharedTurn:'ambiguous',turnChatId:'owner'}]){
    expect(await route(new URLSearchParams(),f.request(),caller as never)).toMatchObject({status:403})
  }
  expect(f.store.list()).toEqual([]);expect(f.calls).toEqual([])
})

it('a creation transaction failure leaves no matter, plan, baton or running executor',async()=>{
  const f=setup()
  f.db.exec("CREATE TRIGGER reject_plan BEFORE INSERT ON matter_plans BEGIN SELECT RAISE(ABORT,'synthetic_plan_fault'); END")
  await expect(f.service.matterPlan(f.request())).rejects.toThrow('synthetic_plan_fault')
  expect(f.store.list()).toEqual([]);expect(f.db.query('SELECT * FROM matter_plans').all()).toEqual([])
  expect(f.db.query('SELECT * FROM matter_agents').all()).toEqual([]);expect(f.calls).toEqual([])
})

it.each(['inbound','background'] as const)('unapproved %s model tool call never reaches matter creation',async source=>{
  const f=setup(),input=f.request(),cards:string[]=[],route=ledgerRoutes({workbench:f.service,resolveAdminChatId:()=>'owner'})['POST /v1/matter/plan']!
  const bridge=scriptedMcpTools({tools:[{name:'matter_plan',server:'wechat'}],call:async(_name,body)=>JSON.stringify(await route(new URLSearchParams(),body,{tier:'admin',origin:'session',chatId:'owner'}))})
  const model=scriptedOpenAiModel([{calls:[{name:'matter_plan',input}]},{text:'未交办。'}])
  const provider=createOpenAiAgentProvider({makeChatModel:()=>model.model,makeMcpBridge:async()=>bridge.bridge,approval:{adminFor:()=>'owner',askUser:async(_chat,prompt)=>{cards.push(prompt);return 'deny'}}})
  const session=await provider.spawn({alias:'offline',path:'/tmp'},{tierProfile:TIER_PROFILES.admin,permissionMode:'strict',chatId:'owner'})
  try{await collectTurn(session.dispatch('安排接力',undefined,{source}))}finally{await session.close()}
  expect(cards).toHaveLength(source==='inbound'?1:0)
  expect(bridge.calls).toEqual([]);expect(f.store.list()).toEqual([]);expect(f.calls).toEqual([])
})

it('replaying a plan request does not create another matter; changing a later brief conflicts',async()=>{
  const f=setup(),request=f.request(),first=await f.service.matterPlan(request)
  expect((await f.service.matterPlan(request)).receipt).toEqual(first.receipt)
  await expect(f.service.matterPlan({...request,legs:[request.legs[0]!,{...request.legs[1]!,brief:'换了分工'},request.legs[2]!]})).rejects.toThrow('creation_conflict')
  await expect.poll(()=>f.calls.length).toBe(1)
  expect(f.store.list()).toHaveLength(1)
})


it('same normalized plan in one owner turn has one durable receipt; different content or turn has another',async()=>{
 const f=setup(),input=f.request(),{requestId:_id,...body}=input
 const caller={scope:'owner-turn-1',path:f.project}
 const [a,b]=await Promise.all([f.service.matterPlan(body,caller),f.service.matterPlan({...body,title:'  三棒接力  ',legs:body.legs.map(l=>({...l,brief:'  '+l.brief+'  '}))},caller)])
 expect(b.receipt).toEqual(a.receipt)
 await f.restart()
 expect((await f.service.matterPlan(body,caller)).receipt).toEqual(a.receipt)
 const c=await f.service.matterPlan({...body,title:'另一件事'},caller)
 const d=await f.service.matterPlan(body,{...caller,scope:'owner-turn-2'})
 expect(c.receipt.requestId).not.toBe(a.receipt.requestId)
 expect(d.receipt.requestId).not.toBe(a.receipt.requestId)
 expect(f.store.list()).toHaveLength(3)
})

it.each(['relay-lab','RELAY-LAB','id','path','current'] as const)('resolves %s to a catalog project without a model-generated id',async kind=>{
 const f=setup();f.service.addProject({path:f.project,providerId:'claude'})
 // Registered names are authoritative, not the folder basename.
 const g=setup(false,true,{registeredProjects:()=>[{alias:'relay-lab',path:f.project}]})
 const p=g.service.entryOptions({ownerKey:'owner',surface:'desktop'}).projects.find(p=>p.path===f.project)!
 const {requestId:_id,target:_target,...body}=g.request()
 const input={...body,...(kind==='current'?{}:{project:kind==='id'?p.id:kind==='path'?f.project:kind})}
 const result=await g.service.matterPlan(input,{scope:'turn',path:f.project})
 expect(result.task.path).toBe(f.project)
 expect(g.store.list()).toHaveLength(1)
})

it.each([
 {label:'invented projectId',input:{target:{kind:'project',projectId:'p-00000000000000000000',base:'relay-lab'}}},
 {label:'local target',input:{target:{kind:'local'}}},
 {label:'project without id',input:{target:{kind:'project'}}},
 {label:'missing project outside catalog',input:{}},
 {label:'unknown project',input:{project:'made-up'}},
])('acceptance input $label returns a useful project error and creates nothing',async row=>{
 const f=setup(),g=setup(false,true,{registeredProjects:()=>[{alias:'relay-lab',path:f.project}]}),{requestId:_id,target:_target,...body}=g.request()
 const route=ledgerRoutes({workbench:g.service,resolveAdminChatId:()=>'owner',planConversation:()=>({scope:'turn',path:g.project})})['POST /v1/matter/plan']!
 const result=await route(new URLSearchParams(),{...body,...row.input},{tier:'admin',origin:'session',chatId:'owner',sessionKey:'openai/offline/owner'})
 expect(result.status).toBeGreaterThanOrEqual(400)
 expect(result.body).toMatchObject({error:expect.any(String),message:expect.stringContaining('relay-lab')})
 expect(JSON.stringify(result.body)).toContain('没建成')
 expect(g.store.list()).toHaveLength(0)
})

it('duplicate registered names require an exact catalog id or path instead of guessing',async()=>{
 const a=setup(),b=setup(),f=setup(false,true,{registeredProjects:()=>[{alias:'Relay-Lab',path:a.project},{alias:'relay-lab',path:b.project}]})
 const {requestId:_id,target:_target,...body}=f.request()
 const route=ledgerRoutes({workbench:f.service,resolveAdminChatId:()=>'owner',planConversation:()=>({scope:'turn',path:f.project})})['POST /v1/matter/plan']!
 const result=await route(new URLSearchParams(),{...body,project:'RELAY-LAB'},{tier:'admin',origin:'session',chatId:'owner'})
 expect(result.body).toMatchObject({error:'matter_project_ambiguous',message:expect.stringContaining('重名')})
 // 比对解析后的文字:JSON 文本里 Windows 路径的反斜杠是转义过的。
 const message=(result.body as {message:string}).message
 expect(message).toContain(a.project)
 expect(message).toContain(b.project)
 expect(f.store.list()).toHaveLength(0)
})

it.each(['native_session_busy','unavailable_provider','invalid_matter_plan'] as const)('approved plan %s failure explicitly explains approval and recovery',async code=>{
 const f=setup(false,true,{...(code==='native_session_busy'?{executionConflict:()=>true}:{}),planConversation:()=>({scope:'approved-turn'})})
 const request=f.request()
 if(code==='unavailable_provider')request.legs[1]!.executor='relay-unregistered'
 if(code==='invalid_matter_plan')request.legs=[]
 f.service.noteMatterApproval('mcp__wechat__matter_plan',request,{chatId:'owner',provider:'openai'})
 const route=ledgerRoutes({workbench:f.service,resolveAdminChatId:()=>'owner'})['POST /v1/matter/plan']!
 const result=await route(new URLSearchParams(),request,{tier:'admin',origin:'session',chatId:'owner'})
 expect(result.status).toBeGreaterThanOrEqual(400)
 expect(result.body).toMatchObject({error:code,message:expect.stringContaining('主人已批准')})
 expect(JSON.stringify(result.body)).toContain('没建成')
 expect(JSON.stringify(result.body)).toContain(code==='native_session_busy'?'工作区':code==='unavailable_provider'?'执行者':'1–6')
 expect(f.store.list()).toHaveLength(0)
})

it('accepted relay retry returns its receipt even when a later executor is now unavailable',async()=>{
 const f=setup(),request=f.request(),first=await f.service.matterPlan(request)
 f.blockNext('quota')
 expect((await f.service.matterPlan(request)).receipt).toEqual(first.receipt)
 expect(f.store.list()).toHaveLength(1)
})

it('daemon pins the approved original project input even if its name now resolves elsewhere',async()=>{
 const a=setup(),b=setup();let named=a.project
 const context={scope:'live-owner-turn',path:b.project}
 const f=setup(false,true,{registeredProjects:()=>[{alias:'relay-lab',path:named},{alias:'old-project',path:a.project}],planConversation:()=>context})
 const {requestId:_id,target:_target,...body}=f.request(),input={...body,project:'relay-lab'},caller={chatId:'owner',provider:'openai'}
 const shown=f.service.matterPlanPreview(input,caller)
 f.service.noteMatterApproval('mcp__wechat__matter_plan',input,caller)
 named=b.project
 expect((await f.service.matterPlan(input,context)).task.path).toBe(shown.projectPath)
 expect(f.store.list()[0]!.path).toBe(a.project)
 expect(f.service.matterApprovalStatus('mcp__wechat__matter_plan',input,caller)).toBe(true)
 expect(f.service.matterApprovalStatus('mcp__wechat__matter_plan',{...input,title:'别的'},caller)).toBe(false)
})

it('a bypassed tool invocation never claims the owner clicked approval',async()=>{
 const f=setup(false,true,{executionConflict:()=>true,planConversation:()=>({scope:'turn'})})
 const route=ledgerRoutes({workbench:f.service,resolveAdminChatId:()=>'owner'})['POST /v1/matter/plan']!
 const result=await route(new URLSearchParams(),f.request(),{tier:'admin',origin:'session',chatId:'owner',sessionKey:'openai/lab/owner'})
 expect(result.body).toMatchObject({error:'native_session_busy',approved:false})
 expect(JSON.stringify(result.body)).not.toContain('主人已批准')
 expect(JSON.stringify(result.body)).toContain('没建成')
})

it('a long live turn retains the accepted project binding for a delayed retry',async()=>{
 const a=setup(),b=setup();let named=a.project
 const context={scope:'long-live-turn',path:b.project},caller={chatId:'owner',provider:'openai'}
 const f=setup(false,true,{registeredProjects:()=>[{alias:'relay-lab',path:named},{alias:'old-project',path:a.project}],planConversation:()=>context})
 const {requestId:_id,target:_target,...body}=f.request(),input={...body,project:'relay-lab'}
 f.service.matterPlanPreview(input,caller);f.service.noteMatterApproval('mcp__wechat__matter_plan',input,caller)
 const first=await f.service.matterPlan(input,context)
 named=b.project
 const future=Date.now()+16*60_000,clock=vi.spyOn(Date,'now').mockReturnValue(future)
 try{expect((await f.service.matterPlan(input,context)).receipt).toEqual(first.receipt);expect(f.store.list()).toHaveLength(1)}finally{clock.mockRestore()}
})

it('an accepted external structured-target request replays even after the project folder disappears',async()=>{
 const f=setup();f.service.addProject({path:f.project,providerId:'claude'})
 const p=f.service.entryOptions({ownerKey:'owner',surface:'desktop'}).projects[0]!,input={...f.request(),target:{kind:'project' as const,projectId:p.id}}
 const first=await f.service.matterPlan(input)
 renameSync(f.project,join(f.root,'moved-project'))
 expect((await f.service.matterPlan(input)).receipt).toEqual(first.receipt)
 expect(f.store.list()).toHaveLength(1)
})

it('same turn overlapping approval previews retain the first target rather than overwrite its card',async()=>{
 const a=setup(),b=setup();let named=a.project
 const context={scope:'overlapping-cards',path:b.project},caller={chatId:'owner',provider:'codex'}
 const f=setup(false,true,{registeredProjects:()=>[{alias:'relay-lab',path:named},{alias:'old-project',path:a.project}],planConversation:()=>context})
 const {requestId:_id,target:_target,...body}=f.request(),input={...body,project:'relay-lab'}
 const first=f.service.matterPlanPreview(input,caller)
 named=b.project
 expect(f.service.matterPlanPreview(input,caller).projectPath).toBe(first.projectPath)
 f.service.noteMatterApproval('mcp__wechat__matter_plan',input,caller)
 expect((await f.service.matterPlan(input,context)).task.path).toBe(first.projectPath)
})

it('project approval preview checks owner identity before resolving or exposing the catalog',()=>{
 const f=setup(false,true,{planConversation:()=>({scope:'unrelated-admin'})})
 expect(()=>f.service.matterPlanPreview({...f.request(),target:undefined,project:'private-project'},{chatId:'other-admin',provider:'openai'})).toThrow('matter_ledger_forbidden')
 expect(f.store.list()).toHaveLength(0)
})

it('handoff failure retains approval after MCP trims the brief',async()=>{
 const f=setup(false,true,{planConversation:()=>({scope:'handoff-turn'})}),id=await f.create()
 const args={matter:id,executor:'relay-unregistered',brief:'  接着做  '}
 f.service.noteMatterApproval('mcp__wechat__matter_handoff',args,{chatId:'owner',provider:'openai'})
 const route=ledgerRoutes({workbench:f.service,resolveAdminChatId:()=>'owner'})['POST /v1/matter/relay']!
 const result=await route(new URLSearchParams(),{...args,brief:'接着做'},{tier:'admin',origin:'session',chatId:'owner'})
 expect(result.body).toMatchObject({error:'unavailable_provider',approved:true,message:expect.stringContaining('主人已批准')})
 expect(JSON.stringify(result.body)).toContain('没接成')
})

it('relay legs are asked for a closing status line and the line decides; a single leg is not asked',async()=>{
  const f=setup(),id=await f.create()
  expect(f.calls[0]!.text).toContain('「状态:做完」')
  // 措辞像做完,状态行说没做完 → 停,不派下一棒
  await f.finish(0,'已按要求处理。\n\n状态:没做完')
  await expect.poll(()=>f.store.plans.get(id)?.legs[0]?.stopReason).toBe('leg_blocked')
  expect(f.calls).toHaveLength(1)
  const single=setup(),request={...single.request(),title:'整理插图',legs:[{executor:'codex',brief:'整理插图'}]}
  await single.service.matterPlan(request);await expect.poll(()=>single.calls.length).toBe(1)
  expect(single.calls[0]!.text).not.toContain('状态:做完')
})

function registrationSetup(executionConflict=()=>false){
 const context={scope:'register-on-handoff'}
 const caller={chatId:'owner',provider:'openai',tier:'admin' as const,origin:'session' as const}
 const tool='mcp__wechat__matter_plan'
 const f=setup(false,true,{planPlaces:()=>places.list(),planConversation:()=>context,executionConflict})
 const places=makePlacesStore(f.db),addProject=vi.spyOn(f.store,'addProject')
 const addPlace=(name:string,root:string)=>places.add([{key:root,root,name,position:places.list().length,hidden:false}],1)
 const route=ledgerRoutes({workbench:f.service,resolveAdminChatId:()=>'owner',planConversation:()=>context})['POST /v1/matter/plan']!
 const input={title:'加个收藏',project:'rici',legs:[{executor:'claude',brief:'添加收藏'}]}
 const call=(body:unknown=input)=>route(new URLSearchParams(),body,caller)
 const card=async(body=input)=>(await prepareChatApprovalPrompt('OpenAI',tool,structuredClone(body),'test',{
  resolveMatterPlan:args=>f.service.matterPlanPreview(MatterPlanRequest.parse(args),caller),
 },'owner')).prompt
 const approve=(body=input)=>f.service.noteMatterApproval(tool,body,caller)
 return {f,input,call,card,approve,addPlace,addProject}
}

it.each(['rici','RICI','stored-basename','root'])('a stored place resolves via %s and displays its own folder',async match=>{
 const t=registrationSetup(),root=join(t.f.root,'stored-basename')
 mkdirSync(root)
 t.addPlace('rici',root)
 const input={...t.input,project:match==='root'?root:match}
 expect(await t.card(input)).toContain('工作区：rici（'+root+'）· 还没登记，批准后登记为工作项目')
 expect(t.addProject).not.toHaveBeenCalled()
 expect(t.f.store.projects()).toEqual([])
})

it('shows the actual registration folder and its saved symlink on the card',async()=>{
 const t=registrationSetup(),destination=join(t.f.root,'destination')
 t.addPlace('rici',t.f.project)
 renameSync(t.f.project,destination)
 symlinkSync(destination,t.f.project,process.platform==='win32'?'junction':'dir')
 expect(await t.card()).toContain(`工作区：rici（${destination}，由 ${t.f.project} 指过去）· 还没登记，批准后登记为工作项目`)
 t.approve()
 expect(await t.call()).toMatchObject({status:202,body:{task:{path:destination}}})
 expect(t.addProject).toHaveBeenCalledExactlyOnceWith({path:destination,name:'rici',providerId:'claude'})
})

it('a missing match or unknown path offers only candidate names',async()=>{
 const t=registrationSetup()
 t.addPlace('rici',t.f.project)
 for(const project of ['unknown',join(t.f.root,'other','rici')]){
  const result=await t.call({...t.input,project})
  expect(result.body).toMatchObject({error:'project_stale',message:expect.stringContaining('可选项目：rici。')})
  expect(JSON.stringify(result.body)).not.toContain(t.f.root)
 }
 expect(t.addProject).not.toHaveBeenCalled()
})

it('ambiguity lists matching place names without directory paths or identifiers',async()=>{
 const t=registrationSetup(),other=join(t.f.root,'rici')
 mkdirSync(other)
 t.addPlace('rici',t.f.project)
 t.addPlace('菜谱本',other)
 const result=await t.call()
 expect(result.body).toMatchObject({error:'matter_place_ambiguous',message:expect.stringContaining('可选项目：rici、菜谱本。')})
 expect(JSON.stringify(result.body)).not.toContain(t.f.root)
 expect(t.addProject).not.toHaveBeenCalled()
})

it('registration follows the approved card and a different project or path needs another card',async()=>{
 const t=registrationSetup(),other=join(t.f.root,'melu')
 mkdirSync(other)
 t.addPlace('rici',t.f.project)
 t.addPlace('melu',other)
 // The model supplied a folder basename as the project selector. Only the saved root is displayed.
 const input={...t.input,project:'project'}
 expect(await t.card(input)).toContain('工作区：rici（'+t.f.project+'）· 还没登记，批准后登记为工作项目')
 expect((await t.call(input)).body).toMatchObject({error:'matter_project_registration_requires_approval',approved:false})
 expect(t.addProject).not.toHaveBeenCalled()
 t.approve(input)
 expect((await t.call({...input,legs:[{executor:'codex',brief:'换分工'}]})).body)
  .toMatchObject({error:'matter_project_registration_requires_approval',approved:false})
 const result=await t.call(input)
 expect(result.status).toBe(202)
 expect(result.body).toMatchObject({task:{path:t.f.project,providerId:'claude'}})
 expect((await t.call(input)).body).toMatchObject({receipt:(result.body as {receipt:unknown}).receipt})
 expect(t.addProject).toHaveBeenCalledExactlyOnceWith({path:t.f.project,name:'rici',providerId:'claude'})
 const changed={...input,project:'melu'}
 expect((await t.call(changed)).body).toMatchObject({error:'matter_project_registration_requires_approval',approved:false})
 expect(await t.card(changed)).toContain('工作区：melu（'+other+'）· 还没登记，批准后登记为工作项目')
 const changedPath={...input,project:other}
 expect((await t.call(changedPath)).body).toMatchObject({error:'matter_project_registration_requires_approval',approved:false})
 expect(await t.card(changedPath)).toContain('工作区：melu（'+other+'）· 还没登记，批准后登记为工作项目')
 expect(t.addProject).toHaveBeenCalledTimes(1)
})

it('a missing place folder prevents the approval card and registration',async()=>{
 const t=registrationSetup()
 t.addPlace('rici',join(t.f.root,'missing'))
 await expect(t.card()).rejects.toThrow('这个地方的文件夹不存在')
 expect((await t.call()).body).toMatchObject({error:'matter_place_invalid_path',approved:false})
 expect(t.addProject).not.toHaveBeenCalled()
})

it('an approved project survives a later workbench creation failure',async()=>{
 const t=registrationSetup(()=>true)
 t.addPlace('rici',t.f.project)
 await t.card()
 t.approve()
 expect((await t.call()).body).toMatchObject({error:'native_session_busy',approved:true})
 expect(t.addProject).toHaveBeenCalledExactlyOnceWith({path:t.f.project,name:'rici',providerId:'claude'})
 expect(t.f.store.projects()).toMatchObject([{path:t.f.project,name:'rici',providerId:'claude'}])
 expect(t.f.store.list()).toEqual([])
})

it('approval keeps the original stored folder if the place name later becomes ambiguous',async()=>{
 const t=registrationSetup(),other=join(t.f.root,'other')
 mkdirSync(other)
 t.addPlace('rici',t.f.project)
 expect(await t.card()).toContain('工作区：rici（'+t.f.project+'）')
 t.addPlace('rici',other)
 t.approve()
 expect((await t.call()).body).toMatchObject({task:{path:t.f.project}})
 expect(t.addProject).toHaveBeenCalledExactlyOnceWith({path:t.f.project,name:'rici',providerId:'claude'})
})

it('rejects approval when a different directory replaces the folder shown on the card',async()=>{
 const t=registrationSetup()
 t.addPlace('rici',t.f.project)
 await t.card()
 renameSync(t.f.project,join(t.f.root,'original-project'))
 mkdirSync(t.f.project)
 t.approve()
 expect(await t.call()).toMatchObject({status:409,body:{
  error:'matter_place_changed',approved:true,message:expect.stringContaining('这个文件夹和你确认的那个不是同一个了'),
 }})
 expect(t.addProject).not.toHaveBeenCalled()
 expect(t.f.store.projects()).toEqual([])
 expect(t.f.store.list()).toEqual([])
 expect(t.f.calls).toEqual([])
})

it('requires fresh approval for a replacement folder in the same turn',async()=>{
 const t=registrationSetup()
 t.addPlace('rici',t.f.project)
 await t.card()
 t.approve()
 renameSync(t.f.project,join(t.f.root,'original-project'))
 mkdirSync(t.f.project)
 expect(await t.call()).toMatchObject({status:409,body:{error:'matter_place_changed',approved:true}})
 await t.card()
 expect(await t.call()).toMatchObject({status:409,body:{error:'matter_project_registration_requires_approval',approved:false}})
 expect(t.addProject).not.toHaveBeenCalled()
 t.approve()
 const result=await t.call()
 expect(result).toMatchObject({status:202,body:{task:{path:t.f.project}}})
 expect(await t.call()).toMatchObject({status:202,body:{receipt:(result.body as {receipt:unknown}).receipt}})
 expect(t.addProject).toHaveBeenCalledExactlyOnceWith({path:t.f.project,name:'rici',providerId:'claude'})
 expect(t.f.store.list()).toHaveLength(1)
})

it('replays the original receipt when a retry selects the newly registered catalog ID',async()=>{
 const t=registrationSetup()
 t.addPlace('rici',t.f.project)
 await t.card()
 t.approve()
 const first=await t.call()
 expect(first.status).toBe(202)
 const projectId=t.f.service.projects()[0]!.id
 const retry=await t.call({...t.input,project:projectId})
 expect(retry).toMatchObject({status:202,body:{receipt:(first.body as {receipt:unknown}).receipt}})
 expect(t.f.store.list()).toHaveLength(1)
 expect(t.addProject).toHaveBeenCalledTimes(1)
})

it('reports project registration on dispatch failure only when this call added it',async()=>{
 const t=registrationSetup(()=>true)
 t.addPlace('rici',t.f.project)
 await t.card()
 t.approve()
 expect(await t.call()).toMatchObject({status:409,body:{
  error:'native_session_busy',approved:true,projectRegistered:true,message:expect.stringContaining('项目已经登记'),
 }})
 expect(t.f.store.projects()).toMatchObject([{path:t.f.project,name:'rici'}])
 expect(t.f.store.list()).toEqual([])
 const retry=await t.call({...t.input,project:t.f.service.projects()[0]!.id})
 expect(retry).toMatchObject({status:409,body:{error:'native_session_busy'}})
 expect(retry.body).not.toHaveProperty('projectRegistered')
 expect(t.addProject).toHaveBeenCalledTimes(1)
})

it.each(['moved','draining'])('replays accepted registration with a changed workspace state (%s)',async scenario=>{
 const t=registrationSetup()
 t.addPlace('rici',t.f.project)
 await t.card()
 t.approve()
 const first=await t.call()
 expect(first.status).toBe(202)
 if(scenario==='moved')renameSync(t.f.project,join(t.f.root,'moved-project'))
 else await t.f.service.shutdown()
 const {receipt}=first.body as {receipt:{requestId:string}}
 expect(await t.call()).toMatchObject({status:202,body:{receipt}})
 await expect(t.card()).resolves.toContain('确认交办')
 // A receipt alone does not authorize a different plan with the same ID.
 const target=t.f.store.entryRequests.get('owner',receipt.requestId)?.target
 expect(target).toMatchObject({kind:'project'})
 const {project:_project,...plan}=t.input
 expect(await t.call({...plan,requestId:receipt.requestId,title:'另一件事',target})).toMatchObject({status:409,body:{error:'creation_conflict'}})
 expect(t.addProject).toHaveBeenCalledTimes(1)
 expect(t.f.store.list()).toHaveLength(1)
})

it('keeps a desktop-added project basename ahead of an unregistered place with the same name',async()=>{
 const t=registrationSetup(),site=join(t.f.root,'site'),other=join(t.f.root,'other')
 mkdirSync(site)
 mkdirSync(other)
 t.f.service.addProject({path:site,name:'Personal Website',providerId:'claude'})
 t.addPlace('site',other)
 for(const project of ['site','SITE','Personal Website',site,t.f.service.projects()[0]!.id]){
  const card=await t.card({...t.input,project})
  expect(card).toContain('工作区：Personal Website（'+site+'）')
  expect(card).not.toContain('还没登记')
 }
 expect(await t.call({...t.input,project:'site'})).toMatchObject({status:202,body:{task:{path:site}}})
 expect(t.addProject).toHaveBeenCalledTimes(1)
})

it.each(['different','same'])('offers usable private selectors for places with the same basename and %s parent names',async scenario=>{
 const t=registrationSetup(),parents=['Documents','Projects']
 const roots=parents.map(parent=>join(t.f.root,parent,...(scenario==='same'?['Web']:[]),'site'))
 for(const root of roots){
  mkdirSync(root,{recursive:true})
  t.addPlace('site',root)
 }
 const input={...t.input,project:'site'}
 const result=await t.call(input)
 expect(result).toMatchObject({status:409,body:{error:'matter_place_ambiguous',placeChoices:parents.map(parent=>({
  label:scenario==='same'?`site（在 Web 下，上层目录有 ${parent}）`:`site（在 ${parent} 下）`,
  selector:expect.stringMatching(/^place:[a-f0-9]+$/),
 }))}})
 const {placeChoices}=result.body as {placeChoices:Array<{label:string;selector:string}>}
 expect(new Set(placeChoices.map(choice=>choice.selector)).size).toBe(2)
 expect(JSON.stringify(result.body)).not.toContain(t.f.root)
 for(const [i,choice] of placeChoices.entries()){
  await expect(t.card(input)).rejects.toThrow(choice.selector)
  const selected={...input,project:choice.selector}
  expect(await t.card(selected)).toContain('工作区：site（'+roots[i]+'）')
  expect(t.addProject).not.toHaveBeenCalled()
 }
 const selected={...input,project:placeChoices[1]!.selector}
 t.approve(selected)
 expect(await t.call(selected)).toMatchObject({status:202,body:{task:{path:roots[1]}}})
 expect(t.addProject).toHaveBeenCalledExactlyOnceWith({path:roots[1],name:'site',providerId:'claude'})
})

it.each([
  {name:'two successes',failure:false,follow:false,ask:false},
  {name:'an open question leaves the other candidate running',failure:false,follow:false,ask:true},
  {name:'one failure',failure:true,follow:false,ask:false},
  {name:'owner chooses the second workspace and relay continues',failure:false,follow:true,ask:false},
])('parallel plan: $name',async({failure,follow,ask})=>{
  const context={scope:'parallel-test'},caller={chatId:'owner',provider:'codex'}
  const f=setup(false,true,{planConversation:()=>context})
  const git=(cwd:string,...args:string[])=>execFileSync('git',['-c','user.email=test@example.invalid','-c','user.name=Test',...args],{cwd,stdio:'pipe'})
  git(f.project,'init','-q','-b','main')
  writeFileSync(join(f.project,'README.md'),'baseline\n')
  git(f.project,'add','.');git(f.project,'commit','-qm','baseline')
  f.service.addProject({path:f.project,providerId:'codex'})
  const input={requestId:randomUUID(),project:f.service.projects()[0]!.id,title:'各做一版',legs:[
    {parallel:['codex','claude'],brief:'做候选版本'},
    ...(follow?[{executor:'openai',brief:'验证选中版本'}]:[]),
  ]}
  const tool='mcp__wechat__matter_plan'
  const preview=structuredClone(input)
  const card=await prepareChatApprovalPrompt('Codex',tool,preview,'parallel',{
    resolveMatterPlan:args=>f.service.matterPlanPreview(args as typeof input,caller),
  },'owner')
  expect(card.prompt).toContain('第 1 棒 · 并行 2 位 · codex、claude')
  await expect(f.service.matterPlan(preview,context)).rejects.toThrow('matter_parallel_requires_approval')
  f.service.noteMatterApproval(tool,input,caller)
  expect(f.service.matterApprovalStatus(tool,preview,caller)).toBe(true)
  const {receipt}=await f.service.matterPlan(preview,context),id=receipt.matterId
  expect((await f.service.matterPlan({...preview,requestId:randomUUID()},context)).receipt).toEqual(receipt)
  await expect.poll(()=>f.calls.length).toBe(2)
  const group=f.store.plans.candidates(id,1),claude=group.find(m=>m.executor==='claude')!,codex=group.find(m=>m.executor==='codex')!
  const left=f.store.get(codex.taskId!),right=f.store.get(claude.taskId!)
  expect(left.path).not.toEqual(right.path)
  expect(f.matters.list({kind:'task'}).map(m=>m.id)).toEqual([id])
  expect(f.service.list().tasks.map(t=>t.id)).toEqual([id])
  expect(f.store.worktrees.get(left.id)?.start?.sha).toBe(f.store.worktrees.get(right.id)?.start?.sha)
  expect(f.service.matterNote(`workbench/${left.id}`,'Codex 专属备注')).toEqual({ok:true})
  expect(f.service.matterNote(`workbench/${right.id}`,'Claude 专属备注')).toEqual({ok:true})
  const privateNotes=f.service.matterNotes(`workbench/${right.id}`,id)
  expect(privateNotes.notes).toEqual(expect.arrayContaining([
    expect.objectContaining({kind:'plan',text:expect.stringContaining('做候选版本')}),
    expect.objectContaining({author:'claude',text:'Claude 专属备注'}),
  ]))
  expect(privateNotes.notes).not.toEqual(expect.arrayContaining([expect.objectContaining({text:'Codex 专属备注'})]))
  expect(f.service.detail(id).notes).toEqual(expect.arrayContaining([expect.objectContaining({text:'Codex 专属备注'})]))
  expect(()=>f.service.matterNotes(`workbench/${right.id}`,'deadbeef')).toThrow('matter_scope_mismatch')
  const leftIndex=f.calls.findIndex(c=>c.executor==='codex'),rightIndex=f.calls.findIndex(c=>c.executor==='claude')
  writeFileSync(join(left.path,'codex.txt'),'left\n')
  git(left.path,'add','.');git(left.path,'commit','-qm','Codex candidate')
  const question=ask?f.calls[rightIndex]!.context.requestUserInput!({
    questions:[{id:'choice',header:'确认',question:'选哪个文件名？',options:[],allowOther:true}],
  }):undefined
  await f.finish(leftIndex,'实际完成的验证：测试通过\n状态：做完',failure)
  await expect.poll(()=>f.store.plans.candidates(id,1)[0]?.status).toBe(failure?'failed':'completed')
  expect(f.notices).toEqual([])
  await expect(f.service.worktreeAction(left.id,'merge')).rejects.toThrow('matter_parallel_not_ready')
  expect(f.service.detail(id).parallelGroups?.[0]?.members[1]?.status).toBe(ask?'waiting':'running')
  if(question){
    const request=f.service.detail(right.id).questions[0]!
    f.service.resolveAnswer(right.id,request.id,{choice:['claude.txt']})
    await expect(question).resolves.toEqual({choice:['claude.txt']})
  }
  expect(f.service.matterNotes(`workbench/${right.id}`,id).notes.some(n=>n.text.includes(left.path))).toBe(false)
  writeFileSync(join(right.path,'claude.txt'),'right\n')
  git(right.path,'add','.');git(right.path,'commit','-qm','Claude candidate')
  await f.finish(rightIndex,'实际完成的验证：2 项通过\n状态：做完')
  await expect.poll(()=>f.notices.length).toBe(1)
  for(const fragment of ['并行对照','codex.txt','claude.txt','+1 / −0 行','2 项通过','状态：做完',right.id]){
    expect(f.notices[0]).toContain(fragment)
  }
  expect(existsSync(join(f.project,'claude.txt'))).toBe(false)
  expect(f.calls).toHaveLength(2)
  if(failure){
    expect(await f.service.handleWechat('owner',`用 Codex 那版 任务 ${left.id}`)).toContain('已合进项目')
    expect(existsSync(join(f.project,'codex.txt'))).toBe(true)
    expect(existsSync(join(f.project,'claude.txt'))).toBe(false)
  }
  if(!follow)return
  await expect(f.service.handleWechat('visitor','用 Claude 那版')).resolves.toBeNull()
  const pending=join(right.path,'still-uncommitted.txt')
  writeFileSync(pending,'owner edit\n')
  expect(await f.service.handleWechat('owner',`用 Claude 那版 任务 ${right.id}`)).toContain('还有没提交的改动')
  expect(f.store.plans.candidates(id,1).some(member=>member.chosen)).toBe(false)
  expect(f.calls).toHaveLength(2)
  unlinkSync(pending)
  expect(await f.service.handleWechat('owner',`用 Claude 那版 任务 ${right.id}`)).toContain('已合进项目')
  expect(existsSync(join(f.project,'claude.txt'))).toBe(true)
  expect(existsSync(join(f.project,'codex.txt'))).toBe(false)
  expect(existsSync(join(left.path,'codex.txt'))).toBe(true)
  await expect.poll(()=>f.calls.length).toBe(3)
  expect(f.calls[2]!.executor).toBe('openai')
  expect(f.calls[2]!.context.workbenchTaskId).toBe(right.id)
  expect(f.calls[2]!.text).toContain('Claude 专属备注')
  expect(f.calls[2]!.text).toContain(right.path)
  expect(f.calls[2]!.text).not.toContain(left.path)
  await f.finish(2,'状态：做完')
  await expect.poll(()=>f.store.plans.get(id)?.state).toBe('done')
})

it('a parallel leg after a sequential leg forks its committed work from the same snapshot',async()=>{
  const context={scope:'parallel-after-single'},caller={chatId:'owner',provider:'codex'}
  const f=setup(false,true,{planConversation:()=>context})
  const git=(cwd:string,...args:string[])=>execFileSync('git',['-c','user.email=test@example.invalid','-c','user.name=Test',...args],{cwd,stdio:'pipe'})
  git(f.project,'init','-q','-b','main')
  git(f.project,'commit','--allow-empty','-qm','baseline')
  f.service.addProject({path:f.project,providerId:'codex'})
  const input={requestId:randomUUID(),project:f.service.projects()[0]!.id,title:'先准备，再并行',legs:[
    {executor:'openai',brief:'准备公共文件'},{parallel:['codex','claude'],brief:'各做一个版本'},
  ]}
  f.service.matterPlanPreview(input,caller)
  f.service.noteMatterApproval('mcp__wechat__matter_plan',input,caller)
  const id=(await f.service.matterPlan(input,context)).receipt.matterId
  await expect.poll(()=>f.calls.length).toBe(1)
  const cwd=f.store.get(id).path
  writeFileSync(join(cwd,'common.txt'),'public work\n')
  await f.finish(0,'状态：做完')
  await expect.poll(()=>f.store.plans.get(id)?.legs[1]?.stopReason).toBe('matter_blocked')
  expect(f.calls).toHaveLength(1)
  git(cwd,'add','.');git(cwd,'commit','-qm','public work')
  f.service.continueTask(id,'继续')
  await expect.poll(()=>f.calls.length).toBe(3)
  const members=f.store.plans.candidates(id,2)
  const inherited=git(cwd,'rev-parse','HEAD').toString().trim()
  for(const member of members){
    const task=f.store.get(member.taskId!)
    expect(task.path).not.toBe(cwd)
    expect(f.store.worktrees.get(task.id)?.start?.sha).toBe(inherited)
    expect(existsSync(join(task.path,'common.txt'))).toBe(true)
  }
  for(let i=1;i<3;i++)await f.finish(i,'状态：做完')
  await expect.poll(()=>f.notices.some(text=>text.includes('第 2 棒的并行对照'))).toBe(true)
})

const parallelGit=(cwd:string,...args:string[])=>execFileSync('git',['-c','user.email=test@example.invalid','-c','user.name=Test',...args],{cwd,stdio:'pipe'}).toString().trim()
const parallelCaller={chatId:'owner',provider:'codex'}
const parallelContext={scope:'parallel-regression'}
function parallelFixture(retained=false,extra:Partial<Parameters<typeof makeWorkbenchService>[0]>={}){
  const f=setup(retained?'all':false,true,{planConversation:()=>parallelContext,...extra})
  parallelGit(f.project,'init','-q','-b','main')
  writeFileSync(join(f.project,'README.md'),'baseline\n')
  parallelGit(f.project,'add','.');parallelGit(f.project,'commit','-qm','baseline')
  f.service.addProject({path:f.project,providerId:'codex'})
  return f
}
async function startParallel(f:ReturnType<typeof parallelFixture>,title:string,legs:typeof ParallelPlanLegs=ParallelPlanLegs,project=f.project){
  const input={requestId:randomUUID(),project:f.service.projects().find(p=>p.path===project)!.id,title,legs}
  f.service.noteMatterApproval('mcp__wechat__matter_plan',input,parallelCaller)
  const {receipt}=await f.service.matterPlan(input,parallelContext),id=receipt.matterId
  await expect.poll(()=>f.store.plans.candidates(id,1).every(m=>m.taskId&&f.calls.some(c=>c.context.workbenchTaskId===m.taskId))).toBe(true)
  const [left,right]=f.store.plans.candidates(id,1).map(m=>f.store.get(m.taskId!))
  return {id,left:left!,right:right!}
}
const ParallelPlanLegs:Array<{parallel:string[];brief:string}|{executor:string;brief:string}>=[{parallel:['codex','claude'],brief:'两位的共同要求'}]
const callFor=(f:ReturnType<typeof parallelFixture>,id:string)=>f.calls.findIndex(c=>c.context.workbenchTaskId===id)
const wechatIdentity=(focusTaskId?:string)=>({accountId:'test-account',userId:'owner',msgId:randomUUID(),createTimeMs:10,focusTaskId})

async function finishParallel(f:ReturnType<typeof parallelFixture>,title:string,legs?:typeof ParallelPlanLegs){
  const group=await startParallel(f,title,legs)
  await f.finish(callFor(f,group.left.id),'状态：做完')
  await f.finish(callFor(f,group.right.id),'状态：做完')
  await expect.poll(()=>f.store.plans.comparison(group.id,1)?.text).toContain('并行对照')
  return group
}

it('asks for a specific comparison and replays the original choice receipt after focus changes',async()=>{
  const f=parallelFixture()
  const a=await startParallel(f,'未出对照的甲')
  const command='用 Codex 那版',unknown=wechatIdentity(a.id)
  const clarification=await f.service.handleWechat('owner',command,unknown)
  expect(clarification).toContain('哪份对照')
  const b=await finishParallel(f,'已出对照的乙')
  // Inspect persisted state before checking wording: the wrong repository could
  // already have been adopted even when the returned message was misleading.
  expect(f.store.plans.candidates(b.id,1).some(m=>m.chosen)).toBe(false)
  const delivery=wechatIdentity(a.id)
  const reply=await f.service.handleWechat('owner',command,delivery)
  expect(reply).toContain(b.left.id)
  expect(f.store.plans.candidates(b.id,1)[0]?.chosen).toBe(true)
  const c=await startParallel(f,'后来才可选的丙')
  writeFileSync(join(c.left.path,'must-not-merge.txt'),'third matter\n')
  parallelGit(c.left.path,'add','.');parallelGit(c.left.path,'commit','-qm','third version')
  await f.finish(callFor(f,c.left.id),'状态：做完')
  await f.finish(callFor(f,c.right.id),'状态：做完')
  await expect.poll(()=>f.store.plans.comparison(c.id,1)?.text).toContain('must-not-merge.txt')
  await f.restart()
  expect(await f.service.handleWechat('owner',command,{...delivery,focusTaskId:c.id})).toBe(reply)
  expect(await f.service.handleWechat('owner',command,{...unknown,focusTaskId:c.id})).toBe(clarification)
  expect(f.store.plans.candidates(c.id,1).some(m=>m.chosen)).toBe(false)
  expect(existsSync(join(f.project,'must-not-merge.txt'))).toBe(false)
  expect(f.db.query<{task_id:string|null},[]>('SELECT task_id FROM matter_plan_choice_receipts ORDER BY rowid').all().map(row=>row.task_id)).toEqual([null,b.left.id])
})

it.each([false,true])('replays a Git merge with a rolled-back choice after focus changes (second comparison=%s)',async secondComparison=>{
  const f=parallelFixture()
  const a=await startParallel(f,'原来的项目')
  writeFileSync(join(a.left.path,'original.txt'),'original choice\n')
  parallelGit(a.left.path,'add','.');parallelGit(a.left.path,'commit','-qm','original choice')
  const sha=parallelGit(a.left.path,'rev-parse','HEAD')
  await f.finish(callFor(f,a.left.id),'状态：做完')
  await f.finish(callFor(f,a.right.id),'状态：做完')
  await expect.poll(()=>f.store.plans.comparison(a.id,1)?.text).toContain('original.txt')

  const command='用 Codex 那版',delivery=wechatIdentity(a.id)
  f.db.exec("CREATE TRIGGER crash_choice BEFORE INSERT ON matter_plan_choice_receipts BEGIN SELECT RAISE(ABORT,'crash after Git'); END")
  await expect(f.service.handleWechat('owner',command,delivery)).rejects.toThrow('crash after Git')
  expect(parallelGit(f.project,'rev-parse','HEAD')).toBe(sha)
  expect(f.store.plans.candidates(a.id,1)[0]?.chosen).toBe(false)
  expect(f.db.query('SELECT * FROM matter_plan_choice_receipts').all()).toEqual([])
  f.db.exec('DROP TRIGGER crash_choice')
  await f.restart()

  const other=join(f.root,'other');mkdirSync(other)
  parallelGit(other,'init','-q','-b','main')
  parallelGit(other,'commit','-qm','other baseline','--allow-empty')
  const otherHead=parallelGit(other,'rev-parse','HEAD')
  f.service.addProject({path:other,providerId:'codex'})
  const b=await startParallel(f,'新焦点的项目',ParallelPlanLegs,other)
  writeFileSync(join(b.left.path,'wrong.txt'),'wrong choice\n')
  parallelGit(b.left.path,'add','.');parallelGit(b.left.path,'commit','-qm','wrong choice')
  if(secondComparison){
    await f.finish(callFor(f,b.left.id),'状态：做完')
    await f.finish(callFor(f,b.right.id),'状态：做完')
    await expect.poll(()=>f.store.plans.comparison(b.id,1)?.text).toContain('wrong.txt')
  }
  const reply=await f.service.handleWechat('owner',command,{...delivery,focusTaskId:b.id})
  expect(parallelGit(other,'rev-parse','HEAD')).toBe(otherHead)
  expect(f.store.plans.candidates(b.id,1)[0]?.chosen).toBe(false)
  expect(f.store.plans.candidates(a.id,1)[0]?.chosen).toBe(!secondComparison)
  expect(reply).toContain(secondComparison?'请带上那一版的任务编号':'项目已包含这版的提交')
  expect(parallelGit(f.project,'rev-parse','HEAD')).toBe(sha)
})

it.each([0,1])('requires manual dispatch after the parallel group opens and %i members accept',async acceptedCount=>{
  const notices:string[]=[],logs:string[]=[]
  const f=parallelFixture(false,{log:(_tag,line)=>logs.push(line),reports:{enqueue(){},enqueueRelay(_id,text){
    if(acceptedCount===0&&text.includes('第 2 棒开始并行'))throw Error('crash after opening')
    notices.push(text)
  }}})
  const a=await startParallel(f,'并行下一棒开组中断',[...ParallelPlanLegs,...ParallelPlanLegs])
  writeFileSync(join(a.right.path,'selected.txt'),'chosen starting point\n')
  parallelGit(a.right.path,'add','.');parallelGit(a.right.path,'commit','-qm','chosen starting point')
  const selectedSha=parallelGit(a.right.path,'rev-parse','HEAD')
  await f.finish(callFor(f,a.left.id),'状态：做完')
  await f.finish(callFor(f,a.right.id),'状态：做完')
  await expect.poll(()=>f.store.plans.comparison(a.id,1)?.text).toContain('selected.txt')

  // Exit just after openGroup, or after one entry acceptance transaction and
  // before recording anything about the other member.
  if(acceptedCount===1)f.db.exec(`CREATE TRIGGER crash_parallel_accept BEFORE UPDATE OF task_id ON matter_plan_candidates
    WHEN NEW.position=2 AND NEW.ordinal=2 BEGIN SELECT RAISE(ABORT,'crash before member acceptance'); END;
    CREATE TRIGGER crash_parallel_attention BEFORE UPDATE OF stop_reason ON matter_plan_legs
    WHEN NEW.position=2 AND NEW.stop_reason='leg_interrupted' BEGIN SELECT RAISE(ABORT,'crash before attention'); END`)
  await f.service.worktreeAction(a.right.id,'merge')
  await expect.poll(()=>f.store.plans.get(a.id)?.legs[1]?.state).toBe('running')
  await expect.poll(()=>f.store.plans.candidates(a.id,2).filter(m=>m.taskId).length).toBe(acceptedCount)
  expect(f.store.plans.dispatchIntents('owner')).toEqual([{matterId:a.id}])
  if(acceptedCount===1){
    await expect.poll(()=>logs.join('\n')).toContain('crash before attention')
    f.db.exec('DROP TRIGGER crash_parallel_accept; DROP TRIGGER crash_parallel_attention')
  }
  const accepted=f.store.plans.candidates(a.id,2).filter(m=>m.taskId)
  expect(accepted).toHaveLength(acceptedCount)
  await f.restart()
  const missingNames=acceptedCount===0?'Codex、Claude':'Claude'
  const command=`任务 ${a.id} 继续`
  const message=`第 2 棒需要你看一眼。${missingNames} 还没开工。发送「${command}」让这几位开工。`
  await expect.poll(()=>notices).toContain(message)
  expect(f.store.plans.get(a.id)?.legs[1]).toMatchObject({state:'running',stopReason:'leg_interrupted'})
  expect(f.store.plans.candidates(a.id,2).filter(m=>m.taskId).map(m=>m.taskId)).toEqual(accepted.map(m=>m.taskId))
  expect(f.store.plans.comparison(a.id,2)).toBeNull()
  expect(f.store.plans.dispatchIntents('owner')).toEqual([{matterId:a.id}])

  // A manual retry uses the same start even if the selected branch has since moved.
  parallelGit(a.right.path,'commit','-qm','later change','--allow-empty')
  const delivery=wechatIdentity()
  expect(await f.service.handleWechat('owner',command,delivery)).toContain('继续')
  await expect.poll(()=>f.store.plans.dispatchIntents('owner')).toEqual([])
  const resumed=f.store.plans.candidates(a.id,2)
  expect(resumed.map(m=>f.store.worktrees.get(m.taskId!)?.start?.sha)).toEqual([selectedSha,selectedSha])
  expect(resumed.slice(0,acceptedCount).map(m=>m.taskId)).toEqual(accepted.map(m=>m.taskId))
  await f.service.handleWechat('owner',command,delivery)
  expect(f.store.plans.candidates(a.id,2).map(m=>m.taskId)).toEqual(resumed.map(m=>m.taskId))
  expect(f.store.plans.get(a.id)?.legs[1]?.stopReason).toBeNull()
})

it('projects ledger rows by baton for both the model opening and matter_notes',async()=>{
  const f=parallelFixture()
  const a=await startParallel(f,'成员记录投影',[...ParallelPlanLegs,{executor:'openai',brief:'接着做'}])
  const leftRun=f.store.plans.candidates(a.id,1)[0]!.runId!
  const leftBranch=f.store.worktrees.get(a.left.id)!.branch
  const leftSha=parallelGit(a.left.path,'rev-parse','HEAD')
  const peerNote=`PEER_BRANCH ${leftBranch} ${leftSha} relative/peer.txt`
  f.service.matterNote(`workbench/${a.right.id}`,'OWN_NOTE')
  writeFileSync(join(a.left.path,'peer.txt'),'peer\n')
  parallelGit(a.left.path,'add','.');parallelGit(a.left.path,'commit','-qm','peer')
  await f.finish(callFor(f,a.left.id),`${peerNote}\n状态：做完`)
  await expect.poll(()=>f.store.plans.candidates(a.id,1)[0]?.status).toBe('completed')
  const read=(q?:{runId?:string;limit?:number})=>f.service.matterNotes(`workbench/${a.right.id}`,a.id,q)
  expect(read().notes.map(n=>n.text).join('\n')).toContain('OWN_NOTE')
  expect(JSON.stringify(read())).not.toMatch(/PEER_BRANCH|peer\.txt|工作区/)
  expect(read({runId:leftRun,limit:1})).toMatchObject({notes:[],matchedTotal:0,nextBefore:null,truncated:false})
  expect(JSON.stringify(f.service.detail(a.id).notes)).toContain(peerNote)
  await f.finish(callFor(f,a.right.id),'状态：做完')
  await expect.poll(()=>f.store.plans.comparison(a.id,1)?.text).toBeTruthy()
  await f.service.worktreeAction(a.right.id,'merge')
  await expect.poll(()=>f.calls.at(-1)?.executor).toBe('openai')
  const next=f.calls.at(-1)!
  expect(next.text).toContain('OWN_NOTE')
  expect(next.text).toContain(a.right.path)
  expect(next.text).not.toMatch(/PEER_BRANCH|peer\.txt/)
  expect(JSON.stringify(f.service.matterNotes(`workbench/${a.right.id}`,a.id))).not.toContain('PEER_BRANCH')
  await f.finish(f.calls.length-1,'状态：做完')
})

it('shares parallel wrap-ups and output summaries with the existing scoped token and responder',async()=>{
  const f=parallelFixture()
  const a=await startParallel(f,'分享的版本')
  const {token}=f.service.shareCreate(a.id,'访客')
  let prompt=''
  f.service.shareResponder({async eval(input){prompt=input;return null},tellOwner(){}})
  writeFileSync(join(a.left.path,'share-left.txt'),'left\n')
  parallelGit(a.left.path,'add','.');parallelGit(a.left.path,'commit','-qm','left')
  const sha=parallelGit(a.left.path,'rev-parse','HEAD')
  await f.finish(callFor(f,a.left.id),'LEFT_SHARE_WRAPUP\n状态：做完')
  await f.finish(callFor(f,a.right.id),'RIGHT_SHARE_WRAPUP\n状态：做完')
  await expect.poll(()=>f.store.plans.comparison(a.id,1)?.text).toBeTruthy()
  const guest=f.service.shareView(token)
  expect(guest.ok).toBe(true)
  if(!guest.ok)throw Error('share unavailable')
  expect(guest.matter.notes).toEqual(expect.arrayContaining([
    expect.objectContaining({kind:'note',text:expect.stringContaining('LEFT_SHARE_WRAPUP')}),
    expect.objectContaining({kind:'note',text:expect.stringContaining('RIGHT_SHARE_WRAPUP')}),
    expect.objectContaining({kind:'artifact',text:'1 个文件 · share-left.txt'}),
  ]))
  expect(JSON.stringify(guest)).not.toContain(sha)
  expect(JSON.stringify(guest)).not.toContain(a.left.path)
  expect(JSON.stringify(guest)).not.toContain('RAW_TRANSCRIPT_CANARY')
  expect(f.service.shareSay(token,'有哪些版本？')).toEqual({ok:true})
  await expect.poll(()=>prompt).toContain('RIGHT_SHARE_WRAPUP')
  expect(prompt).toContain('share-left.txt')
  expect(prompt).not.toContain(sha)
  expect(prompt).not.toContain('RAW_TRANSCRIPT_CANARY')
})

it('reopens a quiet comparison when input queues and rejects a commit outside the published snapshot',async()=>{
  const f=parallelFixture(true)
  const a=await finishParallel(f,'安静的版本')
  const original=f.store.plans.comparison(a.id,1)!
  const left=f.calls[callFor(f,a.left.id)]!
  left.idle!('queue')
  const runId=f.service.detail(a.left.id).runId!,requestId=randomUUID()
  expect(await f.service.submitInput(a.left.id,{runId,requestId,text:'再跑一次测试'})).toMatchObject({status:'pending'})
  expect(f.store.plans.candidates(a.id,1)[0]).toMatchObject({status:'running',result:null})
  expect(f.store.plans.comparison(a.id,1)).toEqual({revision:original.revision+1,text:null})
  await expect(f.service.worktreeAction(a.right.id,'merge')).rejects.toThrow('matter_parallel_not_ready')
  // Another idle result must not turn a pending supplement into a completed version.
  left.queue.push({kind:'result',sessionId:f.store.get(a.left.id).sessionId!,numTurns:1,durationMs:1})
  await expect.poll(()=>f.service.detail(a.left.id).runtime?.foreground).toBe('idle')
  expect(f.store.plans.comparison(a.id,1)?.text).toBeNull()
  f.service.withdrawInput(a.left.id,requestId)
  await expect.poll(()=>f.store.plans.comparison(a.id,1)?.text).toContain('对照 2')
  writeFileSync(join(a.right.path,'new-candidate.txt'),'new snapshot\n')
  parallelGit(a.right.path,'add','.');parallelGit(a.right.path,'commit','-qm','owner amended candidate')
  await expect(f.service.worktreeAction(a.right.id,'merge')).rejects.toThrow('matter_parallel_snapshot_changed')
  expect(existsSync(join(f.project,'new-candidate.txt'))).toBe(false)
  await expect.poll(()=>f.store.plans.comparison(a.id,1)?.text).toContain('new-candidate.txt')
  expect(await f.service.handleWechat('owner',`用 Claude 那版 任务 ${a.right.id} 对照 2`,wechatIdentity())).toContain('请再选一次')
  await expect(f.service.worktreeAction(a.right.id,'merge')).resolves.toMatchObject({merged:true})
})

it('settles a parallel version when a native confirmation arrives after the result and quiet checks',async()=>{
  const f=parallelFixture(true)
  const a=await finishParallel(f,'迟到的补充确认')
  const left=f.calls[callFor(f,a.left.id)]!
  left.idle!('steer')
  const ack=Promise.withResolvers<AgentInputAcceptance>()
  f.holdNextInputAck(ack.promise)
  const runId=f.service.detail(a.left.id).runId!,requestId=randomUUID()
  const finished=vi.spyOn(f.store.ledger,'finish')
  expect(await f.service.submitInput(a.left.id,{runId,requestId,text:'再核一遍'})).toMatchObject({status:'sending'})
  f.calls.at(-1)!.idle!()
  left.queue.push({kind:'text',itemId:'late-ack-result',text:'状态：做完\n验证情况：第二轮通过'})
  left.queue.push({kind:'result',sessionId:f.store.get(a.left.id).sessionId!,numTurns:2,durationMs:1})
  await expect.poll(()=>finished.mock.calls.some(args=>args[3].includes('第二轮通过'))).toBe(true)
  expect(f.store.liveInputs.get(requestId)?.status).toBe('sending')
  expect(f.store.plans.candidates(a.id,1)[0]?.status).toBe('running')
  expect(f.store.plans.comparison(a.id,1)?.text).toBeNull()

  ack.resolve({mode:'steer'})
  await expect.poll(()=>f.store.plans.comparison(a.id,1)?.text).toContain('第二轮通过')
  expect(f.store.plans.candidates(a.id,1)[0]?.status).toBe('completed')
  expect(f.store.liveInputs.get(requestId)?.status).toBe('delivered')
  const deliveryOrder=f.store.events(a.left.id).filter(e=>
    (e.kind==='text'&&e.text?.includes('第二轮通过'))||(e.kind==='user'&&e.text==='再核一遍'))
  expect(deliveryOrder.map(e=>e.kind)).toEqual(['text','user'])
})

it('blocks a quiet member with an already pending supplement before any comparison is published',async()=>{
  const f=parallelFixture(true)
  const a=await startParallel(f,'未投递的补充')
  const left=f.calls[callFor(f,a.left.id)]!
  left.idle!('queue')
  const runId=f.service.detail(a.left.id).runId!,requestId=randomUUID()
  expect(await f.service.submitInput(a.left.id,{runId,requestId,text:'先别结束'})).toMatchObject({status:'pending'})
  await f.finish(callFor(f,a.left.id),'状态：做完')
  await f.finish(callFor(f,a.right.id),'状态：做完')
  await expect.poll(()=>f.store.plans.candidates(a.id,1)[1]?.status).toBe('completed')
  expect(f.store.plans.candidates(a.id,1)[0]?.status).toBe('running')
  expect(f.store.plans.comparison(a.id,1)).toBeNull()
  await expect(f.service.worktreeAction(a.right.id,'merge')).rejects.toThrow('matter_parallel_not_ready')
  await f.service.cancel(a.left.id,runId)
  await expect.poll(()=>f.store.plans.candidates(a.id,1)[0]?.status).toBe('cancelled')
  expect(f.store.liveInputs.get(requestId)?.status).toBe('held')
  await expect.poll(()=>f.store.plans.comparison(a.id,1)?.text).toContain('已停')
})

it.each(['resume accepted','resume unavailable'] as const)('settles or continues a closed candidate when a queued supplement is %s',async path=>{
  const f=parallelFixture()
  const a=await startParallel(f,'关会话的补充')
  const requestId=randomUUID(),rightIndex=callFor(f,a.right.id)
  const runId=f.service.detail(a.right.id).runId!
  expect(await f.service.submitInput(a.right.id,{runId,requestId,text:'把临时文件删掉'})).toMatchObject({status:'pending'})
  // First turn's addition will be undone by a successful second turn.
  const change=join(a.right.path,'undone.txt')
  writeFileSync(change,'temporary\n')
  parallelGit(a.right.path,'add','.');parallelGit(a.right.path,'commit','-qm','add file')
  if(path==='resume unavailable')f.registry.get('claude')!.opts.canResume=()=>false
  await f.finish(callFor(f,a.left.id),'状态：做完')
  await f.finish(rightIndex,'状态：做完')
  if(path==='resume accepted'){
    await expect.poll(()=>f.calls.length).toBe(3)
    expect(f.calls[2]!.context.workbenchTaskId).toBe(a.right.id)
    expect(f.calls[2]!.context.resumeSessionId).toBe(`session-${rightIndex}`)
    expect(f.store.plans.candidates(a.id,1)[1]?.status).toBe('running')
    expect(f.store.plans.comparison(a.id,1)).toBeNull()
    unlinkSync(change)
    parallelGit(a.right.path,'add','.');parallelGit(a.right.path,'commit','-qm','undo file')
    await f.finish(2,'状态：做完')
    await expect.poll(()=>f.store.plans.comparison(a.id,1)?.text).toContain('0 个文件，+0 / −0 行')
    expect(f.store.plans.comparison(a.id,1)?.text).not.toContain('undone.txt')
    expect(f.store.liveInputs.get(requestId)?.status).toBe('delivered')
  }else{
    await expect.poll(()=>f.store.liveInputs.get(requestId)?.status).toBe('held')
    await expect.poll(()=>f.store.plans.candidates(a.id,1)[1]?.status).toBe('failed')
    expect(f.calls).toHaveLength(2)
    expect(f.store.plans.comparison(a.id,1)?.text).toContain('没做成')
  }
})

it('marks a comparison partial when the candidate has work outside its committed snapshot',async()=>{
  const f=parallelFixture()
  const a=await startParallel(f,'有未提交内容')
  writeFileSync(join(a.left.path,'untracked.txt'),'untracked\n')
  await f.finish(callFor(f,a.left.id),'状态：做完')
  await f.finish(callFor(f,a.right.id),'状态：做完')
  await expect.poll(()=>f.store.plans.comparison(a.id,1)?.text).toContain('部分统计')
  await expect(f.service.worktreeAction(a.left.id,'merge')).rejects.toThrow('worktree_uncommitted')
})

it('reconciles a lost comparison enqueue on restart and keeps the comparison alongside relay progress',async()=>{
  const f=parallelFixture(false,{reports:{enqueue(){},async enqueueComparison(){throw Error('synthetic before outbox insert')}}})
  const a=await finishParallel(f,'重启补发对照')
  const outbox=makeReportOutboxStore(f.db)
  const reports=makeReportSink({matters:f.matters,outbox,taskTitle:id=>f.store.get(id).title,artifactCount:()=>0,notificationsEnabled:()=>true})
  expect(await outbox.listDue(Date.now())).toEqual([])
  expect(f.store.plans.comparisonIntents('owner')).toEqual([expect.objectContaining({matterId:a.id,position:1})])
  await f.restart({reports})
  await expect.poll(()=>f.store.plans.comparisonIntents('owner')).toEqual([])
  reports.enqueueRelay!(a.id,'后面接力的进展')
  const read=async()=>(await outbox.listDue(Date.now())).filter(row=>row.matterId===a.id)
  expect(await read()).toEqual([
    expect.objectContaining({text:expect.stringContaining('并行对照')}),
    expect.objectContaining({text:'后面接力的进展'}),
  ])
  const before=await read()
  // Also crash after outbox insert but before acknowledging the intent.
  f.db.query('UPDATE matter_plan_comparisons SET enqueued=0 WHERE matter_id=? AND position=1').run(a.id)
  await f.restart({reports})
  await expect.poll(()=>f.store.plans.comparisonIntents('owner')).toEqual([])
  expect(await read()).toEqual(before)
})

it('recovers a selected baton pending admission, then continues the failed next baton from either WeChat task code',async()=>{
  let occupied=false
  const f=parallelFixture(false,{executionConflict:(_path,executor)=>executor==='codex'&&occupied})
  const a=await finishParallel(f,'重启补派与微信续跑',[...ParallelPlanLegs,{executor:'codex',brief:'接力任务'}])
  occupied=true
  const delivery=wechatIdentity(),choice=`用 Claude 那版 任务 ${a.right.id}`
  const reply=await f.service.handleWechat('owner',choice,delivery)
  expect(reply).toContain(a.right.id)
  await expect.poll(()=>f.store.plans.get(a.id)?.legs[1]?.stopReason).toBe('matter_blocked')
  expect(f.store.plans.dispatchIntents('owner')).toEqual([{matterId:a.id}])
  expect(f.calls).toHaveLength(2)
  const reads=vi.spyOn(f.store.plans,'dispatchIntents')
  vi.useFakeTimers({toFake:['setInterval','clearInterval']})
  let timer:ReturnType<typeof setInterval>|undefined
  try{
    await f.restart()
    timer=setInterval(f.service.retryPendingChoices,60_000)
    expect(f.calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.calls).toHaveLength(2)
    occupied=false
    await vi.advanceTimersByTimeAsync(59_999)
    expect(f.calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    await expect.poll(()=>f.calls.length).toBe(3)
    reads.mockClear()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(reads).not.toHaveBeenCalled()
  }finally{clearInterval(timer);vi.useRealTimers();reads.mockRestore()}
  expect(f.calls[2]?.context.workbenchTaskId).toBe(a.right.id)
  expect(f.store.plans.dispatchIntents('owner')).toEqual([])
  expect(await f.service.handleWechat('owner',choice,delivery)).toBe(reply)
  expect(f.calls).toHaveLength(3)
  await f.finish(2,'失败一次',true)
  await expect.poll(()=>f.store.plans.get(a.id)?.legs[1]?.state).toBe('stopped')
  const resume=wechatIdentity(),command=`任务 ${a.id} 继续`
  expect(await f.service.handleWechat('owner',command,resume)).toContain(a.right.id)
  await expect.poll(()=>f.calls.length).toBe(4)
  expect(f.calls[3]?.context.workbenchTaskId).toBe(a.right.id)
  expect(f.calls[3]?.context.resumeSessionId).toBe('session-2')
  expect(await f.service.handleWechat('owner',command,resume)).toContain(a.right.id)
  expect(f.calls).toHaveLength(4)
  await f.finish(3,'又失败一次',true)
  await expect.poll(()=>f.store.plans.get(a.id)?.legs[1]?.state).toBe('stopped')
  expect(await f.service.handleWechat('owner',`任务 ${a.right.id} 继续`,wechatIdentity())).toContain(a.right.id)
  await expect.poll(()=>f.calls.length).toBe(5)
  await f.finish(4,'状态：做完')
  await expect.poll(()=>f.store.plans.get(a.id)?.state).toBe('done')
})

it('keeps an older task code bound to its own parallel baton in the same matter',async()=>{
  const f=parallelFixture()
  const a=await finishParallel(f,'同一件事两次并行',[...ParallelPlanLegs,...ParallelPlanLegs])
  await f.service.worktreeAction(a.right.id,'merge')
  await expect.poll(()=>f.calls.length).toBe(4)
  await f.finish(2,'状态：做完')
  await f.finish(3,'状态：做完')
  await expect.poll(()=>f.store.plans.comparison(a.id,2)?.text).toContain('第 2 棒')
  expect(await f.service.handleWechat('owner',`用 Codex 那版 任务 ${a.left.id}`,wechatIdentity())).toContain('等并行组结束')
  expect(f.store.plans.candidates(a.id,2).some(m=>m.chosen)).toBe(false)
  const candidate=f.store.plans.candidates(a.id,2).find(member=>member.executor==='codex')!
  expect(await f.service.handleWechat('owner',`用 Codex 那版 任务 ${candidate.taskId}`,wechatIdentity())).toContain(candidate.taskId!)
  expect(f.store.plans.get(a.id)?.state).toBe('done')
})
