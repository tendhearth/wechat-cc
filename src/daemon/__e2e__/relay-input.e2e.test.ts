import {expect,it} from 'vitest'
import {mkdtempSync,mkdirSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js'
import {createWechatMcpServer} from '../../mcp-servers/wechat/server'
import {createInternalApiClient} from '../../mcp-servers/wechat/client'
import {createInternalApi} from '../internal-api'
import {ledgerRoutes} from '../../features/workbench/ledger-routes'
import {makeWorkbenchService} from '../../features/workbench/service'
import {openTestDb} from '../../lib/db'
import {removeTempDir} from '../../lib/test-temp'
import {makeWorkbenchStore} from '../../adapters/store/workbench/store'
import {makeMatterStore} from '../../adapters/store/matters-store'
import {createProviderRegistry} from '../../app/provider-registry'
import {SessionManager} from '../../app/session-manager'
import {MANAGED_NATIVE_CAPABILITIES} from '../../domain/workbench/executor-capabilities'
import {TIER_PROFILES} from '../../domain/user-tier'
import {createOpenAiAgentProvider} from '../../adapters/executors/openai/openai-agent-provider'
import {scriptedOpenAiModel,scriptedMcpTools} from '../../test-support/executors/openai-scripted'
import {collectTurn} from '../../ports/agent-provider'
import {makeReportSink} from '../../features/reports/report-sink'
import {makeReportOutboxStore} from '../../features/reports/outbox'

// Real session scope → shared approval → MCP → authenticated HTTP → relay/entry → store.
// Only the model and executor processes are scripted system boundaries.
it('weak-model project input and tool retry reach one matter through the actual authenticated pipeline',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'cc-relay-input-e2e-'))),project=join(root,'project'),chat=join(root,'chat')
 mkdirSync(project);mkdirSync(chat)
 const db=openTestDb(),store=makeWorkbenchStore(db),workers=createProviderRegistry(),chats=createProviderRegistry(),cards:string[]=[]
 let token='',starts=0,manager:SessionManager
 workers.register('claude',{async spawn(){starts++;return {async *dispatch(){yield {kind:'text' as const,text:'已完成。'};yield {kind:'result' as const,sessionId:'offline-worker',numTurns:1,durationMs:1}},async close(){}}}},{displayName:'Claude',canResume:()=>false,workbench:MANAGED_NATIVE_CAPABILITIES})
 const service=makeWorkbenchService({store,registry:workers,stateDir:root,matters:makeMatterStore(db),ownerChatId:()=>'owner',registeredProjects:()=>[{alias:'relay-lab',path:project}],planConversation:caller=>manager.activeConversation(caller),executionConflict:path=>manager.hasProjectConflict(path)})
 const api=createInternalApi({stateDir:root,daemonPid:1})
 api.mount('workbench',ledgerRoutes({workbench:service,resolveAdminChatId:()=>'owner',planConversation:caller=>manager.activeConversation(caller)}))
 const local=await api.start(),baseUrl=`http://127.0.0.1:${local.port}`
 const server=await createWechatMcpServer({request:(method,path,body)=>createInternalApiClient({baseUrl,tokenFilePath:'unused',sessionToken:token}).request(method,path,body)},{tier:'admin'})
 const client=new Client({name:'relay-e2e',version:'0'}),[a,b]=InMemoryTransport.createLinkedPair()
 await Promise.all([server.connect(a),client.connect(b)])
 const args={project:'RELAY-LAB',title:'整理',legs:[{executor:'claude',brief:'先写'},{executor:'claude',brief:'再读'}]}
 const model=scriptedOpenAiModel([{calls:[{name:'matter_plan',input:structuredClone(args)}]},{calls:[{name:'matter_plan',input:{...structuredClone(args),title:'  整理  '}}]},{text:'已建成。'}])
 const bridge=scriptedMcpTools({tools:[{name:'matter_plan',server:'wechat'}],call:async(name,input)=>{const result=await client.callTool({name,arguments:input as Record<string,unknown>});return JSON.stringify(result)}})
 chats.register('openai',createOpenAiAgentProvider({makeChatModel:()=>model.model,makeMcpBridge:async()=>bridge.bridge,approval:{adminFor:()=>'owner',askUser:async(_chat,prompt)=>{cards.push(prompt);return 'allow'},resolveMatterPlan:(input,chatId,provider)=>service.matterPlanPreview(input as never,{chatId,provider}),noteMatterApproval:(tool,input,chatId,provider)=>service.noteMatterApproval(tool,input,{chatId,provider})}}),{displayName:'gateway',canResume:()=>false})
 manager=new SessionManager({registry:chats,maxConcurrent:6,idleEvictMs:60_000,mintSessionToken:(tier,key)=>{token=api.mintSessionToken(tier,key);return token},invalidateSessionToken:key=>api.invalidateSession(key)})
 try{
  const h=await manager.acquire({alias:'chat',path:chat,providerId:'openai',chatId:'owner',tierProfile:TIER_PROFILES.admin,permissionMode:'strict'})
  await collectTurn(h.dispatch('安排两棒',{source:'inbound'} as never))
  expect(store.list()).toHaveLength(1)
  expect(store.list()[0]!.path).toBe(project)
  expect(store.plans.get(store.list()[0]!.id)?.legs).toHaveLength(2)
  expect(cards).toHaveLength(2)
  expect(cards[0]).toContain('relay-lab')
  expect(cards[0]).toContain(project)
  expect(bridge.calls).toHaveLength(2)
  const results=JSON.stringify(model.seen)
  expect(results).not.toContain('matter_conversation_unavailable')
  expect(results).not.toContain('invalid_request_id')
  await expect.poll(()=>starts).toBe(1)
 }finally{await manager.shutdown();await service.shutdown();await client.close();await server.close();await api.stop();db.close();removeTempDir(root)}
})

it.each(['allow','deny'] as const)('one executor uses the shared approval and ordinary reporting through MCP/HTTP: %s',async answer=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'cc-single-entry-e2e-'))),project=join(root,'project'),chat=join(root,'chat')
 mkdirSync(project);mkdirSync(chat)
 const db=openTestDb(),store=makeWorkbenchStore(db),matters=makeMatterStore(db),outbox=makeReportOutboxStore(db),workers=createProviderRegistry(),chats=createProviderRegistry(),cards:string[]=[]
 let token='',starts=0,manager:SessionManager
 workers.register('claude',{async spawn(){starts++;return {async *dispatch(){yield {kind:'text' as const,text:'插图已整理好。'};yield {kind:'result' as const,sessionId:'offline-single-worker',numTurns:1,durationMs:1}},async close(){}}}},{displayName:'Claude',canResume:()=>false,workbench:MANAGED_NATIVE_CAPABILITIES})
 const reports=makeReportSink({matters,outbox,taskTitle:id=>store.get(id).title,artifactCount:()=>0,notificationsEnabled:()=>true})
 const service=makeWorkbenchService({store,registry:workers,stateDir:root,matters,reports,ownerChatId:()=>'owner',registeredProjects:()=>[{alias:'relay-lab',path:project}],planConversation:caller=>manager.activeConversation(caller),executionConflict:path=>manager.hasProjectConflict(path)})
 const api=createInternalApi({stateDir:root,daemonPid:1})
 api.mount('workbench',ledgerRoutes({workbench:service,resolveAdminChatId:()=>'owner',planConversation:caller=>manager.activeConversation(caller)}))
 const local=await api.start(),baseUrl=`http://127.0.0.1:${local.port}`
 const server=await createWechatMcpServer({request:(method,path,body)=>createInternalApiClient({baseUrl,tokenFilePath:'unused',sessionToken:token}).request(method,path,body)},{tier:'admin'})
 const client=new Client({name:'single-entry-e2e',version:'0'}),[a,b]=InMemoryTransport.createLinkedPair()
 await Promise.all([server.connect(a),client.connect(b)])
 // Resolve a registered name without a model-supplied requestId, then retry normalized content.
 const args={project:'RELAY-LAB',title:'整理插图',legs:[{executor:'claude',brief:'整理插图文件'}]}
 const model=scriptedOpenAiModel([{calls:[{name:'matter_plan',input:structuredClone(args)}]},{calls:[{name:'matter_plan',input:{...structuredClone(args),title:'  整理插图  '}}]},{text:answer==='allow'?'已交办。':'未交办。'}])
 const bridge=scriptedMcpTools({tools:[{name:'matter_plan',server:'wechat'}],call:async(name,input)=>JSON.stringify(await client.callTool({name,arguments:input as Record<string,unknown>}))})
 chats.register('openai',createOpenAiAgentProvider({makeChatModel:()=>model.model,makeMcpBridge:async()=>bridge.bridge,approval:{adminFor:()=>'owner',askUser:async(_chat,prompt)=>{cards.push(prompt);return answer},resolveMatterPlan:(input,chatId,provider)=>service.matterPlanPreview(input as never,{chatId,provider}),noteMatterApproval:(tool,input,chatId,provider)=>service.noteMatterApproval(tool,input,{chatId,provider})}}),{displayName:'gateway',canResume:()=>false})
 manager=new SessionManager({registry:chats,maxConcurrent:6,idleEvictMs:60_000,mintSessionToken:(tier,key)=>{token=api.mintSessionToken(tier,key);return token},invalidateSessionToken:key=>api.invalidateSession(key)})
 try{
  const h=await manager.acquire({alias:'chat',path:chat,providerId:'openai',chatId:'owner',tierProfile:TIER_PROFILES.admin,permissionMode:'strict'})
  await collectTurn(h.dispatch('让 Claude 整理插图',{source:'inbound'} as never))
  expect(cards).toHaveLength(answer==='allow'?2:1)
  expect(cards[0]).toContain('第 1 棒 · claude：整理插图文件')
  expect(cards[0]).not.toContain('第 2 棒')
  expect(cards[0]).toContain('relay-lab')
  expect(cards[0]).toContain(project)
  expect(db.query('SELECT * FROM matter_plans').all()).toEqual([])
  expect(db.query('SELECT * FROM matter_plan_legs').all()).toEqual([])
  if(answer==='allow'){
   expect(store.list()).toHaveLength(1)
   const task=store.list()[0]!
   expect(task.path).toBe(project)
   await expect.poll(()=>starts).toBe(1)
   await expect.poll(async()=>(await outbox.listDue(Date.now())).length).toBe(1)
   const due=await outbox.listDue(Date.now())
   expect(due[0]).toMatchObject({matterId:task.id,originMatterId:matters.get(task.id)!.originMatterId})
   expect(due[0]!.text).toContain('整理插图 · 已答复（第 1 轮）')
   expect(due[0]!.text).toContain('插图已整理好。')
   expect(due[0]!.text).not.toContain('棒')
   expect(bridge.calls).toHaveLength(2)
  }else{
   expect(store.list()).toEqual([])
   expect(starts).toBe(0)
   expect(bridge.calls).toEqual([])
   expect(await outbox.listDue(Date.now())).toEqual([])
  }
  for(const length of [0,7]){
   const result=await client.callTool({name:'matter_plan',arguments:{...args,legs:Array.from({length},()=>args.legs[0]!)}})
   const failure=JSON.parse((result.content as Array<{text:string}>)[0]!.text)
   expect(failure).toMatchObject({error:'invalid_matter_plan',approved:false,message:expect.stringContaining('1–6')})
   expect(failure.message).toContain('没建成')
  }
  expect(store.list()).toHaveLength(answer==='allow'?1:0)
 }finally{await manager.shutdown();await service.shutdown();await client.close();await server.close();await api.stop();db.close();removeTempDir(root)}
})
