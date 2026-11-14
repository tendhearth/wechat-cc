/** Sequential acceptance driver. Only calls the explicitly selected synthetic daemon. */
import {readFileSync,existsSync,appendFileSync,writeFileSync,mkdirSync,statSync} from 'node:fs'
import {join} from 'node:path'
import {loadavg} from 'node:os'
const stateDir=process.env.WECHAT_STATE_DIR
if(!stateDir?.startsWith('/private/tmp/')||!stateDir.includes('/acc/state/')||!existsSync(join(stateDir,'.acceptance-only')))throw Error('explicit temporary state marker required')
const dir=stateDir
const info=JSON.parse(readFileSync(join(dir,'internal-api-info.json'),'utf8'))
const ready=JSON.parse(readFileSync(join(dir,'ready.json'),'utf8'))
for(const u of [info.baseUrl,ready.controlUrl])if(new URL(u).hostname!=='127.0.0.1')throw Error('loopback required')
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms))
const clean=(v:unknown):any=>v&&typeof v==='object'?Array.isArray(v)?v.map(clean):Object.fromEntries(Object.entries(v).map(([k,x])=>[k,typeof x==='string'&&/token|authorization|secret|credential/i.test(k)?'[REDACTED]':clean(x)])):v
const record=(id:string,value:unknown)=>{value=clean(value);appendFileSync(join(dir,'drive-evidence.jsonl'),JSON.stringify({at:new Date().toISOString(),id,value})+'\n');console.log(JSON.stringify({id,...(value&&typeof value==='object'?value:{}),...(typeof value==='string'?{detail:value}:{})}).slice(0,1600))}
const op=readFileSync(join(dir,'internal-operator-token'),'utf8').trim(),file=readFileSync(join(dir,'internal-token'),'utf8').trim()
async function api(method:string,path:string,body?:unknown,auth:'operator'|'file'|'owner'='operator'){
 let token=auth==='file'?file:op
 if(auth==='owner'){
  const scopes=existsSync(join(dir,'session-scopes.json'))?JSON.parse(readFileSync(join(dir,'session-scopes.json'),'utf8')):JSON.parse(readFileSync(join(dir,'session-bearers.json'),'utf8')).map((token:string)=>({token,tier:'admin',sessionKey:'acc-owner'}))
  let owner:any
  for(const candidate of scopes.filter((s:any)=>s.tier==='admin'&&s.sessionKey.includes('acc-owner')).reverse()){
   const probe=await fetch(info.baseUrl+'/v1/health',{headers:{authorization:'Bearer '+candidate.token}})
   if(probe.status===200){owner=candidate;break}
  }
  if(!owner)throw Error('live owner session not observed');token=owner.token
 }
 const test=path.startsWith('/test/'),started=performance.now()
 const r=await fetch((test?ready.controlUrl:info.baseUrl)+(test?path.replace('/test',''):path),{method,headers:{'content-type':'application/json',...(!test?{authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(660000)})
 const value=await r.json();return{status:r.status,ms:Math.round(performance.now()-started),body:value}
}
async function turn(id:string,text:string){const r=await api('POST','/v1/companion/converse',{text});appendFileSync(join(dir,'turn-evidence.jsonl'),JSON.stringify({id,...r})+'\n');record(id,{status:r.status,ms:r.ms,replyChars:r.body.reply?.length??0,reply:r.body.reply?.slice(0,500),error:r.body.error});return r}
async function mode(provider:string){record('mode-'+provider,await api('POST','/v1/conversation/set-mode',{chatId:'acc-owner',mode:{kind:'solo',provider},quiet:true},'file'))}
async function approvedTurn(id:string,text:string){
 let settled=false
 const work=turn(id,text);void work.finally(()=>settled=true).catch(()=>{})
 while(!settled){const pending=await api('GET','/v1/permissions/pending');for(const p of pending.body.items??[])if(p.hash&&p.chatId==='acc-owner'&&(!id.startsWith('C-r3-')||p.prompt?.includes('matter_handoff'))){record(id+'-pending',p);const matter=text.match(/[a-f0-9]{8}/)?.[0];if(matter)record(id+'-before-approval',await api('GET','/v1/workbench/task?id='+matter));record(id+'-approve',await api('POST','/v1/permissions/resolve',{hash:p.hash,decision:'allow'}))};await sleep(500)}
 return await work
}
async function taskDone(id:string,label:string,terminalOnly=false){
 let task:any
 for(let i=0;i<180;i++){
  task=await api('GET','/v1/workbench/task?id='+id);const t=task.body.task??task.body,status=t.status
  if(i%15===0)record(label,task)
  if(['done','completed','failed','error','cancelled','interrupted'].includes(status)||(!terminalOnly&&t.phase==='replied'&&!t.waitingFor&&!t.pendingPermissionCount&&!t.pendingQuestionCount)){record(label+'-final',task);return task}
  const pending=await api('GET','/v1/permissions/pending');for(const p of pending.body.items??[])if(p.hash)record(label+'-approve',await api('POST','/v1/permissions/resolve',{hash:p.hash,decision:'allow'}));await sleep(1000)
 }
 record(label+'-timeout',{last:task,cancel:await api('POST','/v1/workbench/cancel',{id})});return null
}
function config(change:(c:any)=>void){const p=join(dir,'agent-config.json'),c=JSON.parse(readFileSync(p,'utf8'));change(c);writeFileSync(p,JSON.stringify(c))}
const requestCount=()=>existsSync(join(dir,'gateway.jsonl'))?readFileSync(join(dir,'gateway.jsonl'),'utf8').trim().split('\n').filter(Boolean).length:0
async function ledgerProof(id:string){
 const {Database}=await import('bun:sqlite'),db=new Database(join(dir,'wechat-cc.db'),{readonly:true})
 try{return db.query('SELECT position,run_id AS runId,executor,status,injected_at IS NOT NULL AS injected FROM matter_agents WHERE matter_id=? ORDER BY position').all(id)}finally{db.close()}
}
async function checkup(providerId:string,model:string,cancel=false){
 const before=requestCount(),quote=await api('POST','/v1/checkup/estimate',{providerId,model,full:false})
 record('D.1-estimate-'+providerId+'-'+model,{...quote,noRequests:requestCount()===before})
 if(quote.status!==200)return
 const run=await api('POST','/v1/checkup/run',{providerId,model,full:false,expectedTargetKey:quote.body.targetKey});record('D-start-'+providerId+'-'+model,run)
 if(run.status!==202){record('D-run-rejected',{providerId,model,status:run.status});return run}
 if(cancel){await sleep(800);record('D-cancel',await api('POST','/v1/checkup/cancel',{}))}
 for(let i=0;i<1800;i++){
  const r=await api('GET','/v1/checkup?run='+quote.body.targetKey)
  if(r.status!==200){record('D-query-error',{providerId,model,...r});return r}
  if(r.body.attempt?.status!=='running'){record('D-result-'+providerId+'-'+model,r);record('D-request-span',{providerId,model,cancel,before,after:requestCount()});return r}
  if(i%30===0)record('D-progress',{providerId,model,completedRequests:r.body.attempt.completedRequests})
  await sleep(1000)
 }
 record('D-timeout',await api('POST','/v1/checkup/cancel',{}))
}
// Every model batch has its own bounded gate. Never inspect games or user apps.
const until=Date.now()+1200000
for(;;){const load=loadavg()[0];if(load===undefined)throw Error('load average unavailable');record('load-gate',{load,allowed:load<12});if(load<12)break;if(Date.now()>=until)process.exit(3);await sleep(30000)}
const section=process.argv[2]
if(!section)throw Error('round4 section required')
async function boundary(label:string){
 const {Database}=await import('bun:sqlite'),db=new Database(join(dir,'wechat-cc.db'),{readonly:true})
 try{
  const watermark=db.query('SELECT entries_to_ts FROM thread_extract_state WHERE chat_id=?').get('acc-owner')
  const messages=db.query('SELECT ts,direction,length(text) AS chars,substr(text,1,90) AS head FROM messages WHERE chat_id=? ORDER BY ts DESC,rowid DESC LIMIT 6').all('acc-owner')
  const topics=await api('GET','/v1/memory/topics?view=all')
  const health=await api('GET','/v1/health',undefined,'file')
  record(label,{watermark,messages,topics,context:health.body.owner_context})
 }finally{db.close()}
}
if(section.startsWith('B-')){
 const provider=section==='B-claude'?'claude':'openai',long=section==='B-long'
 config(c=>{for(const w of c.modelContextWindows??[])if(w.provider===provider)w.windowTokens=8192})
 await mode(provider)
 let initial='请记住这个编造决定：金桂周报固定周二发，负责人小金。简短确认。'
 if(long){const prefix='这是一条恰好三万字的合成长消息。只需记住中间明确的决定，其余都是无关填充。',fact='以后银杏周报固定周四发，负责人小杏。请记住这个编造决定。',tail='填充结束，请只用一句话确认银杏周报安排。';initial=prefix+'闲聊填充。'.repeat(4000);initial=initial.slice(0,15000)+fact+'闲聊填充。'.repeat(4000);initial=initial.slice(0,30000-tail.length)+tail;record('B-long-input',{characters:initial.length,containsMiddleFact:initial.includes(fact)})}
 const logStart=readFileSync(join(dir,'daemon.log'),'utf8').length
 await turn(section+'-1',initial);await boundary(section+'-after-1')
 if(provider==='claude'){
  // SDK announces the gateway model as 1M. A lab-only pre-existing capacity file
  // is a test knob: cap this observed identity without changing provider code.
  const cap=join(dir,'checkup/context-upper-bounds.json')
  record('B-claude-window-before-cap',await api('GET','/v1/health',undefined,'file'))
  const windows=join(dir,'checkup/context-windows.json')
  if(existsSync(windows)){const data=JSON.parse(readFileSync(windows,'utf8'));writeFileSync(cap,JSON.stringify(Object.fromEntries(Object.keys(data).map(k=>[k,8192]))));record('B-claude-lab-cap',{syntheticCapacityCap:true,windowTokens:8192,keysCapped:Object.keys(data).length})}
 }
 for(let i=2;i<=18;i++){
  await boundary(section+'-before-'+i)
  const filler=i===2&&!long?'这是无关的编造填充，只需回复收到。'+'日常闲聊填充。'.repeat(1400):'继续刚才那个编造安排，请简短确认。'
  await turn(section+'-'+i,filler);await boundary(section+'-after-'+i)
  const logs=readFileSync(join(dir,'daemon.log'),'utf8').slice(logStart)
  if(logs.includes('[CONTEXT_ROTATE] reason=budget provider='+provider)){record(section+'-rotation-log',{lines:logs.split('\n').filter(l=>l.includes('CONTEXT_ROTATE'))});break}
  // Allow asynchronous catchup to complete; wait is outside the reply path.
  await sleep(i>=8?12000:300)
 }
 await turn(section+'-reference','刚才那个安排哪天发，谁负责？只回答这两点。')
 await boundary(section+'-final')
 if(section==='B-openai'){
  await mode('claude');await turn('A.1-r4','请重新实际调用 today_digest 查询今天有什么在办的事，一句话回复。')
  record('A.2-r4',JSON.parse(Bun.spawnSync(['python3',new URL('./run.py',import.meta.url).pathname,'ps'],{env:{...process.env,WECHAT_STATE_DIR:dir}}).stdout.toString()))
  const rows=readFileSync(join(dir,'gateway.jsonl'),'utf8').trim().split('\n').map(x=>JSON.parse(x)),r=rows.findLast(r=>r.path==='/v1/messages'&&r.toolNames?.some((n:string)=>n.includes('today_digest')))
  record('A.3-r4',{requestId:r?.id,totalTools:r?.toolCount,wechatTools:r?.toolNames?.filter((n:string)=>n.startsWith('mcp__wechat__')).length,hasToolSearch:r?.toolNames?.some((n:string)=>/toolsearch/i.test(n)),toolNames:r?.toolNames})
 }
}else if(section==='C-start'){
 const nonce=Date.now().toString(36),items=[]
 await mode('claude');await turn('C-owner-prime','准备隔离记录本验收，只回复准备好了。')
 for(const second of ['claude','openai']){
  const path=join(dir,'..','..','workspaces',dir.split('/').at(-1)!,'r4-'+second);mkdirSync(path,{recursive:true})
  const r=await api('POST','/v1/workbench/create',{path,providerId:'claude',title:'记录本第四轮-'+second,text:`只用 Write 在当前目录生成 handoff.txt，内容“合成批次${nonce}，金桂周报固定周二”。最终写交接备注：下一位先调用 matter_notes 读记录本，再调用 matter_note 写一条核对备注。不要联网，不用Bash。`});record('C-start-'+second,r)
  if(!r.body.task?.id)throw Error('missing task')
  items.push({id:r.body.task.id,path,nonce,second});writeFileSync(join(dir,'c-round4.json'),JSON.stringify(items));await taskDone(r.body.task.id,'C-first-'+second)
 }
}else if(section==='C-start-openai-external'){
 const items=JSON.parse(readFileSync(join(dir,'c-round4.json'),'utf8')),old=items.find((i:any)=>i.second==='openai'),path=join(dir,'..','..','workspaces',dir.split('/').at(-1)!,'r4-openai');mkdirSync(path,{recursive:true})
 const r=await api('POST','/v1/workbench/create',{path,providerId:'claude',title:'记录本第四轮-openai独立目录',text:`只用 Write 在当前目录生成 handoff.txt，内容“合成批次${old.nonce}，金桂周报固定周二”。最终写交接备注：下一位先调用 matter_notes 读记录本，再调用 matter_note 写一条核对备注。不要联网，不用Bash。`});record('C-start-openai-external',r)
 if(!r.body.task?.id)throw Error('missing task');old.id=r.body.task.id;old.path=path;writeFileSync(join(dir,'c-round4.json'),JSON.stringify(items));await taskDone(old.id,'C-first-openai-external')
}else if(section==='C-exited'){
 const cleanup=JSON.parse(readFileSync(join(dir,'cleanup.json'),'utf8'))
 if(cleanup.remainingCount!==0||cleanup.remainingGroupMembers!==0)throw Error('external cleanup required')
 for(const item of JSON.parse(readFileSync(join(dir,'c-round4.json'),'utf8'))){
  const t=await api('GET','/v1/workbench/task?id='+item.id);record('C-exited-before-'+item.second,t)
  if(t.body.lastExecution?.createdAt&&statSync(join(dir,'cleanup.json')).mtimeMs<t.body.lastExecution.createdAt)throw Error('cleanup predates writer')
  if(t.body.task?.error==='writer_not_closed')record('C-exited-'+item.second,await api('POST','/v1/workbench/writer-exited',{id:item.id}))
 }
}else if(section==='C-handoff-claude'||section==='C-handoff-openai'){
 const second=section.endsWith('openai')?'openai':'claude',items=JSON.parse(readFileSync(join(dir,'c-round4.json'),'utf8')),item=items.find((i:any)=>i.second===second),{id,nonce}=item
 await mode('claude')
 const before=requestCount()
 await approvedTurn(section,`已确认接力。请你现在实际调用 matter_handoff，参数 matter=${id}，executor=${second}，brief=“由第二棒先实际调用 matter_notes 读取记录本，然后实际调用 matter_note 写精确备注：第四轮${second}执行者已读记录本，批次${nonce}。只做这两项，不用文件工具、不用Bash、不联网。”。记录本读写是交给第二棒的任务，完整放入 brief。`)
 let detail:any;for(let i=0;i<60;i++){detail=await api('GET','/v1/workbench/task?id='+id);if(detail.body.agentRuns?.length>=2)break;await sleep(500)};if(detail.body.agentRuns?.length<2){record(section+'-not-started',{batons:detail.body.agentRuns?.length??0});process.exit(1)};detail=await taskDone(id,section+'-second');record(section+'-detail',detail)
 record(section+'-notes',await api('GET','/v1/matter/notes?matter='+id));record(section+'-ledger',await ledgerProof(id));record(section+'-span',{before,after:requestCount()});const {Database}=await import('bun:sqlite'),db=new Database(join(dir,'wechat-cc.db'),{readonly:true});try{record(section+'-note-origin',db.query('SELECT entry_key,run_id,author,text FROM matter_notes WHERE matter_id=?').all(id))}finally{db.close()}
 const credential=JSON.parse(readFileSync(join(dir,'session-scopes.json'),'utf8')).findLast((s:any)=>s.sessionKey===`workbench/${id}`),other=items.find((i:any)=>i.id!==id)
 if(credential&&other){const headers={authorization:'Bearer '+credential.token},own=await fetch(info.baseUrl+'/v1/matter/notes?matter='+id,{headers}),forged=await fetch(info.baseUrl+'/v1/matter/notes?matter='+other.id,{headers});record(section+'-scope',{own:own.status,forgedRead:forged.status})}
}else if(section==='C-scope-openai'){
 const items=JSON.parse(readFileSync(join(dir,'c-round4.json'),'utf8')),item=items.find((i:any)=>i.second==='openai'),other=items.find((i:any)=>i.id!==item.id)
 const before=await api('GET','/v1/workbench/task?id='+item.id)
 record('C-openai-scope-continue',await api('POST','/v1/workbench/continue',{id:item.id,text:'请实际调用 matter_notes 再读一次记录本，然后简短确认，不用其他工具，不联网。'}))
 let proven=false
 for(let i=0;i<400;i++){
  const credential=JSON.parse(readFileSync(join(dir,'session-scopes.json'),'utf8')).findLast((s:any)=>s.sessionKey===`workbench/${item.id}`)
  if(credential){const headers={authorization:'Bearer '+credential.token},own=await fetch(info.baseUrl+'/v1/matter/notes?matter='+item.id,{headers});if(own.status===200){const forged=await fetch(info.baseUrl+'/v1/matter/notes?matter='+other.id,{headers});record('C-openai-live-scope',{own:own.status,forgedRead:forged.status});proven=forged.status===403;break}}
  await sleep(25)
 }
 const after=await taskDone(item.id,'C-openai-scope-completed');record('C-openai-live-scope-proof',{proven,sameBaton:before.body.agentRuns?.at(-1)?.runId===after?.body.agentRuns?.at(-1)?.runId})
 if(!proven)throw Error('live openai scope not proved')
}else if(section==='D'){
 const done=await checkup('openai','Kimi-Code')
 record('D-round4-completeness',{status:done?.body.attempt?.status,completed:done?.body.attempt?.completedRequests,total:done?.body.attempt?.totalRequests,version:done?.body.profile?.interview?.version})
 if(done?.body.attempt?.status!=='completed'||done?.body.attempt?.completedRequests!==24||done?.body.profile?.interview?.version!=='interview-v2')throw Error('complete 24-question v2 required; inspect evidence, do not claim success')
 writeFileSync(join(dir,'D-round4-result.json'),JSON.stringify(clean(done),null,2))
 await mode('openai');await turn('D-budget-r4','体检已结束，请简短回复收到。');record('D-budget-r4-health',await api('GET','/v1/health',undefined,'file'))
}else throw Error('unknown round4 section')
