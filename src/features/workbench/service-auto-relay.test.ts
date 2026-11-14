import {afterEach,expect,it,vi} from 'vitest'
import {mkdtempSync,mkdirSync,realpathSync,renameSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {openTestDb} from '../../lib/db'
import {removeTempDir} from '../../lib/test-temp'
import {makeWorkbenchStore} from '../../adapters/store/workbench/store'
import {makeMatterStore} from '../../adapters/store/matters-store'
import {createProviderRegistry} from '../../app/provider-registry'
import {MANAGED_NATIVE_CAPABILITIES,MANAGED_API_CAPABILITIES,UNATTENDED_CAPABILITIES} from '../../domain/workbench/executor-capabilities'
import type {UsageSnapshot} from '../../domain/subscription-usage'
import type {AgentEvent,AgentRuntimeSnapshot,SpawnContext} from '../../ports/agent-provider'
import {AsyncQueue} from '../../lib/async-queue'
import {makeWorkbenchService,type WorkbenchService} from './service'
import {ledgerRoutes} from './ledger-routes'
import {createOpenAiAgentProvider} from '../../adapters/executors/openai/openai-agent-provider'
import {scriptedOpenAiModel,scriptedMcpTools} from '../../test-support/executors/openai-scripted'
import {collectTurn} from '../../ports/agent-provider'
import {TIER_PROFILES} from '../../domain/user-tier'

vi.setConfig({testTimeout:30_000})
const cleanups:Array<()=>Promise<void>>=[]
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup()})
function setup(retainedFirst:boolean|'all'=false,signals=true){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cc-auto-relay-'))),project=join(root,'project'),stateDir=join(root,'state');mkdirSync(project);mkdirSync(stateDir)
  const db=openTestDb(),store=makeWorkbenchStore(db),matters=makeMatterStore(db),registry=createProviderRegistry()
  const calls:Array<{executor:string;context:SpawnContext;text:string;queue:AsyncQueue<AgentEvent>;idle?:()=>void}>=[],notices:string[]=[],ordinaryReports:string[]=[],order:string[]=[]
  let nextBlock:null|'quota'|'refused'|'ack'=null
  for(const executor of ['codex','claude','openai'])registry.register(executor,{async spawn(_p,context){
    const queue=new AsyncQueue<AgentEvent>()
    order.push(`spawn:${executor}`)
    if(retainedFirst&&executor==='codex'&&(retainedFirst==='all'||!calls.length)){
      let snapshot:AgentRuntimeSnapshot={retained:true,foreground:'running',backgroundCount:0,input:'send'}
      return {workbenchRuntime:{events:queue.iterable(),snapshot:()=>snapshot,start(text){calls.push({executor,context,text,queue,idle:()=>{snapshot={...snapshot,foreground:'idle'}}})},async submit(_id,text){snapshot={...snapshot,foreground:'running'};calls.push({executor,context,text,queue,idle:()=>{snapshot={...snapshot,foreground:'idle'}}})}},async *dispatch(){},async close(){order.push(`close:${executor}`);queue.end()}}
    }
    return {dispatch(text){calls.push({executor,context,text,queue});return queue.iterable()},async close(){order.push(`close:${executor}`);queue.end()}}
  }},{displayName:executor,canResume:()=>executor!=='openai',workbench:executor==='openai'?MANAGED_API_CAPABILITIES:MANAGED_NATIVE_CAPABILITIES})
  const opts={store,registry,stateDir,managedWorkspaceRoot:join(root,'Tasks'),ownerChatId:()=>'owner',matters,
    usage:(id:string):UsageSnapshot|null=>id==='claude'&&nextBlock==='quota'?{providerId:'claude',plan:null,fetchedAt:Date.now(),exhausted:true,windows:[{name:'5h',usedPercent:100,resetsAt:Date.now()+3600_000,durationMins:300}]}:null,
    ...(signals?{refusal:(id:string)=>id==='claude'&&nextBlock==='refused'?{code:'refused',since:'2026-11-14T00:00:00Z'}:null}:{}),executionConflict:()=>false,reports:{enqueue(id:string){ordinaryReports.push(id)},enqueueRelay(_id:string,text:string){notices.push(text)}}}
  let service=makeWorkbenchService(opts)
  cleanups.push(async()=>{await service.shutdown();db.close();removeTempDir(root)})
  const request=()=>({requestId:randomUUID(),target:{kind:'managed' as const},title:'三棒接力',legs:[{executor:'codex',brief:'出三张图'},{executor:'claude',brief:'接入插图'},{executor:'openai',brief:'跑测试'}]})
  const create=async()=>{const result=await service.matterPlan(request());await expect.poll(()=>calls.length).toBe(1);return result.task.id}
  const finish=async(index:number,text='已完成。',error=false)=>{const call=calls[index]!;call.idle?.();call.queue.push({kind:'init',sessionId:call.context.resumeSessionId??`session-${index}`});call.queue.push({kind:'text',itemId:'private',text:'RAW_TRANSCRIPT_CANARY'});call.queue.push({kind:'text',itemId:'final',text});if(error)call.queue.push({kind:'error',message:'synthetic_failure'});else call.queue.push({kind:'result',sessionId:call.context.resumeSessionId??`session-${index}`,numTurns:1,durationMs:1});if(!call.idle)call.queue.end()}
  return {root,project,db,store,matters,registry,calls,notices,ordinaryReports,order,request,create,finish,blockNext(mode:typeof nextBlock){nextBlock=mode;if(mode==='ack')registry.get('claude')!.opts.workbench=UNATTENDED_CAPABILITIES},get service(){return service},async restart(){await service.shutdown();service=makeWorkbenchService(opts)}}
}

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
  f.service.continueTask(id,'继续')
  await expect.poll(()=>f.calls.length).toBe(3)
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
  const f=setup(),id=await f.create();await f.finish(0,'请确认。')
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
