/** Full production boot with existing scheduler/desktop test hooks only. */
import { existsSync,mkdirSync,writeFileSync,readFileSync,appendFileSync } from 'node:fs'
import { join } from 'node:path'
const dir=process.env.WECHAT_STATE_DIR
if(!dir?.startsWith('/private/tmp/')||!dir.includes('/acc/state/')||!existsSync(join(dir,'.acceptance-only')))throw Error('explicit temporary state marker required')
const {startFakeIlink}=await import('../../src/daemon/__e2e__/fake-ilink-server')
const ilink=await startFakeIlink()
const put=(name:string,value:unknown)=>{const p=join(dir,name);mkdirSync(join(p,'..'),{recursive:true});if(!existsSync(p))writeFileSync(p,typeof value==='string'?value:JSON.stringify(value))}
const proxy=JSON.parse(readFileSync(join(dir,'gateway.json'),'utf8')).baseUrl
put('access.json',{allowFrom:['acc-owner','acc-visitor','acc-group@chatroom'],admins:['acc-owner'],trusted:['acc-visitor']})
put('accounts/acc-bot/account.json',{botId:'acc-bot',userId:'acc-owner',baseUrl:ilink.baseUrl})
// Fake account URL has an ephemeral port and must follow every restart.
writeFileSync(join(dir,'accounts/acc-bot/account.json'),JSON.stringify({botId:'acc-bot',userId:'acc-owner',baseUrl:ilink.baseUrl}))
put('accounts/acc-bot/token','synthetic-offline-token')
put('user_names.json',{'acc-owner':'验收主人','acc-visitor':'验收访客'})
put('user_account_ids.json',{'acc-owner':'acc-bot','acc-visitor':'acc-bot','acc-group@chatroom':'acc-bot'})
put('context_tokens.json',{'acc-owner':'synthetic-context','acc-visitor':'synthetic-context','acc-group@chatroom':'synthetic-context'})
put('companion/config.json',{enabled:false,default_chat_id:'acc-owner',timezone:'UTC',snooze_until:null,last_introspect_at:new Date().toISOString(),import_local_history:false,memory_nightly_enabled:false,ingest_enabled:false,letters_enabled:false,hearth_enabled:false,atelier_mode:'off'})
put('agent-config.json',{provider:'claude',model:'Kimi-Code',openaiBaseUrl:proxy+'/v1',openaiModel:'Kimi-Code',openaiEvalModel:'GLM-FLASH',cheapEvalProvider:'openai',turnJudgeProvider:'openai',bot_name:'验收CC',dangerouslySkipPermissions:false,autoStart:false,closeStopsDaemon:false,remote_tunnel:false,cli_auto_upgrade:{enabled:false},modelContextWindows:[{provider:'claude',address:proxy,model:'Kimi-Code',windowTokens:262144},{provider:'openai',address:proxy+'/v1',model:'Kimi-Code',windowTokens:262144}]})
put('projects.json',{acceptance:join(dir,'workspace')})
put('chat_prefs.json',{'acc-owner':JSON.stringify({care:'high',hunt:false,visit:false})})
put('current-cwd',join(dir,'workspace'))
put('memory/acc-owner/memory.md','# 合成验收记忆\nACC_PRIVATE_MEMORY_CANARY\n')
put('memory/acc-owner/persona.md','名字：验收CC\n称呼用户：验收主人\n自称：验收CC\n口吻：简短平实\n记忆：ACC_PRIVATE_MEMORY_CANARY\n')
// Same observer seam as test-support/session-auth-recorder, without fake SDKs.
// Real registry mints are preserved; bearers stay in this process's memory.
const sessionTokens:string[]=[]
const auth=await import('../../src/daemon/internal-api/token-registry')
const make=auth.makeTokenRegistry
const {mock}=await import('bun:test')
mock.module('../../src/daemon/internal-api/token-registry',()=>({...auth,makeTokenRegistry:(...args:Parameters<typeof make>)=>{
 const registry=make(...args),mint=registry.mint.bind(registry)
 const scopes:Array<{token:string;tier:string;sessionKey:string}>=[]
 registry.mint=(...values:Parameters<typeof mint>)=>{const token=mint(...values);sessionTokens.push(token);scopes.push({token,tier:values[0],sessionKey:values[1]});writeFileSync(join(dir,'session-bearers.json'),JSON.stringify(sessionTokens),{mode:0o600});writeFileSync(join(dir,'session-scopes.json'),JSON.stringify(scopes),{mode:0o600});return token}
 return registry
}}))
// Observe the real isolated runner and real scoring, without changing either.
const runner=await import('../../src/features/checkup/runner')
const makeTurn=runner.makeCheckupTurn
const {scoreInterview,buildInterviewPlan}=await import('../../src/domain/checkup-interview')
let isolatedTurn:ReturnType<typeof makeTurn>|undefined
mock.module('../../src/features/checkup/runner',()=>({...runner,makeCheckupTurn:(...args:Parameters<typeof runner.makeCheckupTurn>)=>{
 const real=makeTurn(...args)
 isolatedTurn=real
 return async(...values:Parameters<typeof real>)=>{
  const result=await real(...values),sample=values[0]
  if(sample.kind==='interview'){
   const score=scoreInterview(sample,result,sample.persona)
   // Tool records contain only this test's fictional story. No request body.
   appendFileSync(join(dir,'checkup-observations.jsonl'),JSON.stringify({at:new Date().toISOString(),id:sample.id,provider:values[1].provider,model:values[1].model,score,toolCalls:result.toolCalls,toolError:result.toolError??false,durationMs:result.durationMs})+'\n')
  }
  return result
 }
}}))
const {bootDaemon}=await import('../../src/daemon/main')
let handle:Awaited<ReturnType<typeof bootDaemon>>|undefined
const control=Bun.serve({hostname:'127.0.0.1',port:0,idleTimeout:255,async fetch(req){
 const u=new URL(req.url)
 if(u.pathname==='/ps'){
  return Response.json({sessionTokensObserved:sessionTokens.length,inspectWith:'run.py ps'})
 }
 if(u.pathname==='/outbox')return Response.json(ilink.outbox().map(m=>({endpoint:m.endpoint,chatId:m.chatId,text:m.text})))
 if(req.method==='POST'&&u.pathname==='/checkup-sample'){
  const b=await req.json() as any
  if(!['0/0/clarify','0/0/handoff','0/0/ordinary-handoff'].includes(b.id)||!isolatedTurn)return new Response('sample unavailable',{status:400})
  const persona={name:'验收CC',userTitle:'验收主人',selfTitle:'验收CC'},sample=buildInterviewPlan({windowTokens:8192,full:false,persona,executors:[]}).samples.find(s=>s.id===b.id)!
  const target={provider:'openai',model:'GLM-FLASH',address:proxy+'/v1',windowTokens:8192,windowKnown:false}
  try{const result=await isolatedTurn(sample,target,AbortSignal.timeout(90_000)),score=scoreInterview(sample,result,persona),row={at:new Date().toISOString(),manual:true,id:sample.id,provider:target.provider,model:target.model,score,toolCalls:result.toolCalls,toolError:result.toolError??false,durationMs:result.durationMs};appendFileSync(join(dir,'checkup-observations.jsonl'),JSON.stringify(row)+'\n');return Response.json({completed:true,...row})}
  catch(error){return Response.json({completed:false,id:sample.id,errorCode:(error as any)?.code??'provider_error'})}
 }
 if(req.method==='POST'&&u.pathname==='/tick'){const b=await req.json() as any;await handle?.fireTick(b.kind,new Date(b.at??Date.now()));return Response.json({ok:true})}
 if(req.method==='POST'&&u.pathname==='/inbound'){const b=await req.json() as any;ilink.enqueueInbound({message_id:Date.now(),from_user_id:b.chatId??'acc-owner',to_user_id:'acc-bot',create_time_ms:Date.now(),message_type:1,message_state:2,item_list:[{type:1,msg_id:String(Date.now()),text_item:{text:b.text}}],context_token:'synthetic-context'});return Response.json({ok:true})}
 return new Response('not found',{status:404})
}})
handle=await bootDaemon({stateDir:dir,dangerously:false,schedulerIntervalMs:1_000_000_000,speechFlushIntervalMs:1_000_000_000,scheduledJobsIntervalMs:1_000_000_000,reminderIntervalMs:1_000_000_000,machineIdle:async()=>null,desktopNotify:async()=>true})
writeFileSync(join(dir,'ready.json'),JSON.stringify({controlUrl:`http://127.0.0.1:${control.port}`,pid:process.pid}))
let stopping=false
async function stop(){if(stopping)return;stopping=true;control.stop(true);await handle?.shutdown();await ilink.stop();process.exit(0)}
process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop())
