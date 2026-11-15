import {makeMatterStore} from '../../adapters/store/matters-store'
import {randomUUID} from 'node:crypto'
import {beforeLedgerInstructions} from '../../test-support/fixtures/workbench-before-ledger'
import type {makeWorkbenchStore as MakeStore} from '../../adapters/store/workbench/store'
import {ledgerRoutes} from './ledger-routes'
import {afterEach,beforeEach,expect,it} from 'vitest'
import {mkdirSync,mkdtempSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openDb,type Db} from '../../lib/db'
import {removeTempDir} from '../../lib/test-temp'
import {createProviderRegistry} from '../../app/provider-registry'
import {makeWorkbenchStore} from '../../adapters/store/workbench/store'
import {makeWorkbenchService,type WorkbenchService} from './service'
import {MANAGED_NATIVE_CAPABILITIES} from '../../domain/workbench/executor-capabilities'

// 话题 T3:起执行者时话题简报接在指令里;一轮真的完成了 ⇒ onTaskTurnCompleted(task.id);简报拿不到 / 抛错 ⇒ 照常起。
let area:string,project:string,db:Db,service:WorkbenchService,seen:string[],asked:Array<{matterId:string;title:string;text:string}>,done:string[]
let store:ReturnType<typeof MakeStore>
let brief:(t:{matterId:string;title:string;text:string})=>Promise<string|null>
beforeEach(()=>{area=realpathSync(mkdtempSync(join(tmpdir(),'cc-topics-')));project=join(area,'project');mkdirSync(project);db=openDb({path:join(area,'state.db')});seen=[];asked=[];done=[]
  const registry=createProviderRegistry()
  registry.register('codex',{async spawn(_p,ctx){seen.push(ctx.appendInstructions??'');return{async *dispatch(){yield{kind:'result' as const,sessionId:'s',numTurns:1,durationMs:1}},async close(){}}}},{displayName:'Codex',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  store=makeWorkbenchStore(db)
  service=makeWorkbenchService({store,registry,stateDir:area,ownerChatId:()=>'owner',matters:makeMatterStore(db),
    topicBrief:async(t)=>{asked.push({matterId:t.matterId,title:t.title,text:t.text});return brief(t)},
    onTaskTurnCompleted:(id)=>{done.push(id)}})})
afterEach(async()=>{await service.shutdown();db.close();removeTempDir(area)})

it('简报接在执行者指令里;做完一轮报 task.id',async()=>{
  brief=async()=>'CC 记得的相关背景:\n话题「bx」\n- [决定] UDP 走 hysteria2'
  const t=service.create({path:project,providerId:'codex',text:'修一下 bx 的 UDP'})
  await expect.poll(()=>seen.length).toBe(1)
  expect(seen[0]).toContain('- [决定] UDP 走 hysteria2')
  expect(seen[0]).toBe(beforeLedgerInstructions(t,{path:project},join(project,'.cc-workbench',t.id))+'\n'+await brief({matterId:t.id,title:t.title,text:'修一下 bx 的 UDP'}))
  expect(asked[0]!.text).toBe('修一下 bx 的 UDP')
  await expect.poll(()=>done).toEqual([t.id])
})

it('没有简报 / 抛错 ⇒ 指令里没有这一段,照常起',async()=>{
  brief=async()=>null
  service.create({path:project,providerId:'codex',text:'x'})
  await expect.poll(()=>seen.length).toBe(1)
  expect(seen[0]).not.toContain('CC 记得的相关背景')
  brief=async()=>{throw new Error('boom')}
  service.create({path:project,providerId:'codex',text:'y'})
  await expect.poll(()=>seen.length).toBe(2)
  expect(seen[1]).not.toContain('CC 记得的相关背景')
})

it('记录本第一棒和接力棒不推话题，也不调用简报依赖',async()=>{
  brief=async()=>'TOPIC_PRIVATE_CANARY'
  store.addProject({path:project,providerId:'codex'})
  const result=await service.matterPlan({requestId:randomUUID(),project, title:'接力',legs:[{executor:'codex',brief:'第一棒'},{executor:'codex',brief:'第二棒'}]})
  await expect.poll(()=>seen.length).toBeGreaterThanOrEqual(1)
  await expect.poll(()=>service.detail(result.task.id).task.status).toBe('completed')
  await service.matterHandoff(result.task.id,'codex','第二棒')
  await expect.poll(()=>seen.length).toBeGreaterThanOrEqual(2)
  for(const prompt of seen){
    expect(prompt).not.toContain('TOPIC_PRIVATE_CANARY')
    expect(prompt).toContain('需要了解主人之前怎么聊过这件事时，用 matter_context 查；不需要就别查。')
  }
  expect(asked).toEqual([])
})

it('context 路由只取令牌绑定的事；没令牌拒绝；超时返回空',async()=>{
  const a=store.create({title:'A',providerId:'codex',path:project,ownerChatId:'owner'}),b=store.create({title:'B',providerId:'codex',path:project,ownerChatId:'owner'})
  store.ledger.start(a.id,'a','codex','A');store.ledger.start(b.id,'b','codex','B')
  store.ledger.start(a.id,'a2','codex','A2');store.ledger.start(b.id,'b2','codex','B2')
  store.addEvent(a.id,'user','原始任务')
  brief=async(t)=>'context-'+t.matterId
  const routes=ledgerRoutes({workbench:service}),route=routes['GET /v1/matter/context']!,caller={tier:'trusted',origin:'session',sessionKey:`workbench/${a.id}`} as const
  expect(await route(new URLSearchParams(),null,caller)).toEqual({status:200,body:{context:'context-'+a.id}})
  expect(asked).toEqual([{matterId:a.id,title:'A',text:'原始任务'}])
  expect((await route(new URLSearchParams('matter='+b.id),null,caller)).status).toBe(403)
  expect(asked).toHaveLength(1)
  expect((await route(new URLSearchParams(),null)).status).toBe((await routes['GET /v1/matter/notes']!(new URLSearchParams(),null)).status)
  brief=()=>new Promise(()=>{})
  expect(await route(new URLSearchParams(),null,caller)).toEqual({status:200,body:{context:'',message:'没有相关话题'}})
})
