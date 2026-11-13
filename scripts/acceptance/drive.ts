/** Sequential acceptance driver. Only calls the explicitly selected synthetic daemon. */
import {readFileSync,existsSync,appendFileSync,writeFileSync,unlinkSync,mkdirSync} from 'node:fs'
import {join} from 'node:path'
import {loadavg} from 'node:os'
const dir=process.env.WECHAT_STATE_DIR
if(!dir?.startsWith('/private/tmp/')||!dir.includes('/acc/state/')||!existsSync(join(dir,'.acceptance-only')))throw Error('explicit temporary state marker required')
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
 while(!settled){const pending=await api('GET','/v1/permissions/pending');for(const p of pending.body.items??[])if(p.hash)record(id+'-approve',await api('POST','/v1/permissions/resolve',{hash:p.hash,decision:'allow'}));await sleep(500)}
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
  if(r.body.attempt?.status!=='running'){record('D-result-'+providerId+'-'+model,r);return r}
  if(i%30===0)record('D-progress',{providerId,model,completedRequests:r.body.attempt.completedRequests})
  await sleep(1000)
 }
 record('D-timeout',await api('POST','/v1/checkup/cancel',{}))
}
// Gate applies to every invocation, before any new model work.
const until=Date.now()+1200000
for(;;){const load=loadavg()[0];if(load<12){record('load-gate',{load,allowed:true});break}record('load-gate',{load,allowed:false});if(Date.now()>=until)process.exit(3);await sleep(Math.min(30000,Math.max(0,until-Date.now())))}
const section=process.argv[2]
if(section==='A'){
 await mode('claude');await turn('A.1','请调用工具查询今天有什么在办的事，简短回复。')
 const check=Bun.spawnSync(['python3',new URL('./run.py',import.meta.url).pathname,'ps'],{env:{...process.env,WECHAT_STATE_DIR:dir}});record('A.2',JSON.parse(check.stdout.toString()))
 await turn('A.4-both-command','/both');await turn('A.4-both','各位请调用工具查看今天的在办事项，各用一句话回复。')
 await turn('A.4-chat-command','/chat');await turn('A.4-chat','请各调用工具查看今天的在办事项，简短交流并给结论。')
 await mode('claude');await turn('A.6','请用 delegate_openai 工具问另一位一个小问题：2+2等于几？拿到答案后简短告诉我。')
 await mode('codex');await turn('A.7-codex','请调用工具查看今天的在办事项，并用一句话回复。')
 await mode('openai');await turn('A.7-openai','请调用工具查看今天的在办事项，并用一句话回复。')
 await mode('claude')
}else if(section==='A-extra'){
 await mode('claude');await turn('A.1-final','请调用工具查询今天有什么在办的事，一句话回复。')
 record('A.2-final',JSON.parse(Bun.spawnSync(['python3',new URL('./run.py',import.meta.url).pathname,'ps'],{env:{...process.env,WECHAT_STATE_DIR:dir}}).stdout.toString()))
 record('A.4-parallel-mode',await api('POST','/v1/conversation/set-mode',{chatId:'acc-owner',mode:{kind:'parallel',participants:['claude','openai']},quiet:true},'file'))
 await turn('A.4-parallel','各位请调用工具查询今天有什么在办的事，各用一句话回复。')
 record('A.4-chatroom-mode',await api('POST','/v1/conversation/set-mode',{chatId:'acc-owner',mode:{kind:'chatroom',participants:['claude','openai']},quiet:true},'file'))
 const baseline=(await api('GET','/test/outbox')).body.length
 await api('POST','/test/inbound',{text:'各位请各调用一次工具查询今天有什么在办的事，简短交流后结束。'})
 for(let i=0;i<90;i++){const out=await api('GET','/test/outbox');if(out.body.length>=baseline+2){record('A.4-chatroom-outbox',{newMessages:out.body.slice(baseline)});break}await sleep(1000)}
 await api('POST','/test/inbound',{text:'/stop'});await sleep(3000);await mode('claude')
 await turn('A.6-final','请实际调用 delegate_codex，问它2+2等于几，收到后简短告诉我。')
 await mode('codex');await turn('A.7-codex-final','请调用工具查询今天有什么在办的事，一句话回复。')
 record('A.7-ps',JSON.parse(Bun.spawnSync(['python3',new URL('./run.py',import.meta.url).pathname,'ps'],{env:{...process.env,WECHAT_STATE_DIR:dir}}).stdout.toString()))
 await mode('openai');await turn('A.7-openai-final','请调用工具查询今天有什么在办的事，一句话回复。')
 await mode('claude')
 record('A.5-manual-release',await api('POST','/v1/sessions/release',{alias:'_default',providerId:'claude',chatId:'acc-owner'},'owner'))
 await turn('A.5-manual-resume','刚才查到什么？请再调用一次工具核对，一句话回复。')
}else if(section==='A-modes'){
 await turn('A.4-both-current','/both');await turn('A.4-chat-current','/chat')
 record('A.4-parallel-start',await api('POST','/v1/conversation/set-mode',{chatId:'acc-owner',mode:{kind:'parallel',participants:['claude','openai']},quiet:true},'file'))
 await turn('A.4-parallel-fresh','实时工具验收：两位各自必须在本轮重新调用 today_digest 查询今天的在办事项，不能复用前文结果；各用一句话回复。')
 record('A.4-parallel-turns',await api('GET','/v1/turns?chatId=acc-owner',undefined,'owner'))
 const baseline=(await api('GET','/test/outbox')).body.length
 record('A.4-chatroom-start',await api('POST','/v1/conversation/set-mode',{chatId:'acc-owner',mode:{kind:'chatroom',participants:['claude','openai']},quiet:true},'file'))
 await api('POST','/test/inbound',{text:'本轮实时工具验收：两位都必须重新调用 today_digest 查询今天的在办事项，各说一句，之后请裁决结束。'})
 let ended=false
 for(let i=0;i<240;i++){
  const out=(await api('GET','/test/outbox')).body.slice(baseline)
  if(out.some((m:any)=>m.text?.includes('🎯'))){const state=await api('GET','/v1/matter/owner-chat/events',undefined,'owner');if(state.status===200&&state.body.running==null){record('A.4-chatroom-completed',{outbox:out,state});ended=true;break}}
  await sleep(1000)
 }
 record('A.4-chatroom-ended',{ended})
 if(!ended)throw Error('chatroom completion not observed; do not start another batch')
 record('A.4-chatroom-turns',await api('GET','/v1/turns?chatId=acc-owner',undefined,'owner'))
 await mode('claude')
}else if(section==='A-codex'){
 await mode('codex');await turn('A.7-codex-recheck','这是新的一轮验收。必须重新实际调用 today_digest 工具查询今天的在办事项，不能沿用旧结果。一句话回复。')
 record('A.7-codex-ps',JSON.parse(Bun.spawnSync(['python3',new URL('./run.py',import.meta.url).pathname,'ps'],{env:{...process.env,WECHAT_STATE_DIR:dir}}).stdout.toString()))
 await mode('claude')
}else if(section==='A-long'){
 await mode('claude');await turn('A.6-long','请调用 delegate_codex，交代它：在隔离工作区用命令执行 sleep 75，等命令真实结束后只回复4。拿到它的最终结果后告诉我，不要自己替它回答。这是长调用验收。')
}else if(section==='A-idle-prime'){
 await mode('claude');await turn('A.5-prime','请重新调用 today_digest 查今天的在办事项。再记住本次合成验收代号是青竹，一句话回复。')
 const health=await api('GET','/v1/health',undefined,'file'),origin={at:new Date().toISOString(),daemonPid:health.body.daemon_pid,sessionsLive:health.body.sessions_live}
 writeFileSync(join(dir,'idle-origin.json'),JSON.stringify(origin));record('A.5-idle-origin',origin)
}else if(section==='A-idle-watch'){
 const origin=JSON.parse(readFileSync(join(dir,'idle-origin.json'),'utf8'))
 for(;;){const health=await api('GET','/v1/health',undefined,'file'),elapsedMs=Date.now()-Date.parse(origin.at),proof={at:new Date().toISOString(),elapsedMs,sameDaemon:health.body.daemon_pid===origin.daemonPid,sessionsLive:health.body.sessions_live}
  if(!proof.sameDaemon)throw Error('idle observation requires same daemon')
  writeFileSync(join(dir,'idle-observation.json'),JSON.stringify(proof))
  if(elapsedMs>=1800000&&health.body.sessions_live===0){record('A.5-idle-evicted',proof);break}
  if(elapsedMs>1980000)throw Error('natural idle eviction not observed within 33 minutes')
  await sleep(30000)
 }
}else if(section==='A-idle'){
 record('A.5-idle-before',await api('GET','/v1/health',undefined,'file'))
 await mode('claude');await turn('A.5-idle-resume','刚才查到什么？请重新调用 today_digest 核对，一句话回复。')
 record('A.5-idle-after',await api('GET','/v1/health',undefined,'file'))
}else if(section==='B'){
 record('B.1-before',await api('GET','/v1/health',undefined,'file'))
 await mode('claude')
 for(let i=1;i<=20;i++){await turn('B.2-'+i,i===1?'我们在编一个周报计划，代号青松。以后周报都发周五。请记住并简短确认。':i%5===0?'请调用工具看一下今天的在办事项。我们刚才计划的代号是什么？一句话回复。':`第${i}轮，青松周报计划继续保持，简短确认即可。`)}
 record('B.1-after20',await api('GET','/v1/health',undefined,'file'))
 await turn('B.6-second','再决定一条：周报标题统一叫青松周报。请记住。')
 record('B.6-topics',await api('GET','/v1/memory/topics?view=all'))
 await mode('openai');await turn('B.3','请用一句话确认青松周报安排，不需要调用工具。');record('B.3-health',await api('GET','/v1/health',undefined,'file'))
 config(c=>{for(const w of c.modelContextWindows??[])if(w.provider==='openai')w.windowTokens=8192})
 for(let i=1;i<=10;i++)await turn('B.4-'+i,i===1?'请记住：青松是周五的周报。'+('今天在讨论编造的周报安排。'.repeat(800)):i===10?'刚才那个安排是哪天？代号是什么？一句话回复。':`继续第${i}轮，简短确认。`)
 record('B.4-health',await api('GET','/v1/health',undefined,'file'))
 config(c=>{for(const w of c.modelContextWindows??[])if(w.provider==='openai')w.windowTokens=1000000})
 for(let i=1;i<=4;i++)await turn('B.5-'+i,'以下是隔离超长窗口验收的编造填充，只需回复“收到”：\n'+Array.from({length:10000},(_,j)=>`青松周报条目${i}-${j}在周五。`).join('\n'))
 await turn('B.5-short','刚才的周报计划是哪天？只说星期几。')
 record('B.5-health',await api('GET','/v1/health',undefined,'file'))
 config(c=>{for(const w of c.modelContextWindows??[])if(w.provider==='openai')w.windowTokens=262144})
 writeFileSync(join(dir,'memory/acc-owner/agenda.md'),'- [ ] due:'+new Date().toISOString().slice(0,10)+' 主人已约好：现在发一句“要不要一起喝杯茶？”\n')
 record('B.7-care',await api('POST','/v1/chat-prefs',{chat_id:'acc-owner',care:'high'},'file'))
 record('B.7-before',await api('GET','/v1/health',undefined,'file'))
 record('B.7-tick',await api('POST','/test/tick',{kind:'push',at:new Date().toISOString()}))
 record('B.7-outbox',await api('GET','/test/outbox'))
 record('B.7-after',await api('GET','/v1/health',undefined,'file'))
 await turn('B.7-yes','好啊')
 record('B.8-nightly',await api('POST','/v1/memory/nightly/run',{},'file'))
 record('B.9-visitor',await api('POST','/test/inbound',{chatId:'acc-visitor',text:'你好，今天只需回复一句收到。'}))
 record('B.9-group',await api('POST','/test/inbound',{chatId:'acc-group@chatroom',text:'你好，今天只需回复一句收到。'}))
 await sleep(20000);record('B.9-health',await api('GET','/v1/health',undefined,'file'))
}else if(section==='B-extra'){
 await mode('claude');await turn('B-reset-after-overflow','/reset')
 await turn('B.7-recovery-yes','好啊')
 const attempts=()=>{const v=JSON.parse(readFileSync(join(dir,'context-rotation.json'),'utf8'));return v.state.chats['acc-owner']?.attempts??0}
 const previous=attempts()
 await turn('B.6-eligible-decision','这是明确的新决定，请记住：从今天起，青松周报固定周五发，负责人叫小青；以后都按这个执行。')
 for(let i=0;i<12;i++){const r=await api('GET','/v1/memory/topics?view=all');if(i%3===0)record('B.6-eligible-topics',r);if(r.body.topics?.length)break;await sleep(5000)}
 const first=attempts();await turn('B.6-within5min','再记住一个决定：青松周报标题统一叫青松周报，五分钟内不用重复整理。')
 await sleep(1000);record('B.6-throttle',{before:previous,afterFirst:first,afterSecond:attempts()})
 record('B.8-daytime-after',await api('GET','/v1/health',undefined,'file'))
}else if(section==='B-openai20'){
 config(c=>{for(const w of c.modelContextWindows??[])if(w.provider==='openai')w.windowTokens=262144})
 await mode('openai')
 record('B.2-openai-before',await api('GET','/v1/health',undefined,'file'))
 for(let i=1;i<=20;i++)await turn('B.2-openai-'+i,i%5===0?'请重新调用 today_digest 查询今天的在办事项。我们周报代号是什么？一句话回复。':`这是网关连续对话的第${i}轮，青松周报固定周五发，简短确认即可。`)
 record('B.2-openai-after',await api('GET','/v1/health',undefined,'file'))
 await mode('claude')
}else if(section==='B-lab'){
 await mode('claude')
 for(let i=1;i<=8;i++)await turn('B.8-baseline-'+i,i===1?'我们今天准备一起喝茶，简短确认即可。':`第${i}轮，请简短回复在。`)
 record('B.7-clean-before',await api('GET','/v1/health',undefined,'file'))
 writeFileSync(join(dir,'memory/acc-owner/agenda.md'),'- [ ] due:'+new Date().toISOString().slice(0,10)+' 主人已约好：现在发一句“要不要一起喝杯茶？”\n')
 record('B.7-clean-tick',await api('POST','/test/tick',{kind:'push',at:new Date().toISOString()}))
 record('B.7-clean-outbox',await api('GET','/test/outbox'))
 record('B.7-clean-after',await api('GET','/v1/health',undefined,'file'))
 await turn('B.7-clean-yes','好啊')
 record('B.8-half-before',await api('GET','/v1/health',undefined,'file'))
 record('B.8-clean-nightly',await api('POST','/v1/memory/nightly/run',{},'file'))
 await turn('B.8-daytime','继续今天的安排，请一句话确认。')
 record('B.8-half-after',await api('GET','/v1/health',undefined,'file'))
}else if(section==='B-proactive-reference'){
 await mode('claude');await turn('B.7-distinct-prime','你好，请只用一句话打个招呼。')
 const baseline=(await api('GET','/test/outbox')).body.length
 record('B.7-distinct-before',await api('GET','/v1/health',undefined,'file'))
 writeFileSync(join(dir,'memory/acc-owner/agenda.md'),'- [ ] due:'+new Date().toISOString().slice(0,10)+' 主人已约好：现在发一句“要不要周日一起挑个银色风铃？”\n')
 record('B.7-distinct-tick',await api('POST','/test/tick',{kind:'push',at:new Date().toISOString()}))
 const out=(await api('GET','/test/outbox')).body.slice(baseline);record('B.7-distinct-outbox',{messages:out})
 record('B.7-distinct-after',await api('GET','/v1/health',undefined,'file'))
 if(out.length){await turn('B.7-distinct-yes','好啊');await turn('B.7-distinct-reference','我们刚才答应要一起做什么？只说这件事。')}
}else if(section==='B-visitors'){
 const named=await api('POST','/v1/user/set_name',{chat_id:'acc-group@chatroom',name:'验收群'},'file');record('B.9-group-name',named)
 if(named.status!==200||named.body.ok!==true)throw Error('synthetic group name must be accepted before inbound')
 record('B.9-before',await api('GET','/v1/health',undefined,'file'))
 const baseline=(await api('GET','/test/outbox')).body.length
 record('B.9-visitor-inbound',await api('POST','/test/inbound',{chatId:'acc-visitor',text:'你好，本次合成访客验收，只需回复一句收到。'}))
 record('B.9-group-inbound',await api('POST','/test/inbound',{chatId:'acc-group@chatroom',text:'你好，本次合成群标识验收，只需回复一句收到。'}))
 for(let i=0;i<90;i++){const out=(await api('GET','/test/outbox')).body.slice(baseline);if(['acc-visitor','acc-group@chatroom'].every(chat=>out.some((m:any)=>m.chatId===chat))){record('B.9-replies',{outbox:out});break}await sleep(1000)}
 record('B.9-after',await api('GET','/v1/health',undefined,'file'));record('B.9-turns',await api('GET','/v1/turns',undefined,'owner'))
}else if(section==='C'||section==='C-fallback'){
 await mode('claude')
 const firstProvider=section==='C'?'codex':'claude'
 record('C-combination',{firstProvider,secondProvider:'claude',firstBatonNoteViaFinalReply:true})
 const nonce=Date.now().toString(36),workspace=join(dir,'tasks','relay-'+nonce),otherWorkspace=join(dir,'tasks-other','relay-'+nonce)
 mkdirSync(workspace,{recursive:true});mkdirSync(otherWorkspace,{recursive:true})
 const canary='ACC_TRANSCRIPT_ONLY_'+nonce
 writeFileSync(join(workspace,'private-progress.txt'),canary)
 const canaryPath=join(dir,'transcript-canaries.json'),canaries=existsSync(canaryPath)?JSON.parse(readFileSync(canaryPath,'utf8')):[]
 writeFileSync(canaryPath,JSON.stringify([...canaries,canary]))
 const r=await api('POST','/v1/workbench/create',{path:workspace,providerId:firstProvider,title:'青松文件接力',text:`这是隔离验收。先读取 private-progress.txt，其内容仅供过程检查，不要写入最终回复或产出。只在当前工作区创建 handoff.txt，内容为“青松周报在周五；批次${nonce}”。最后回复交接备注：下一位读取 handoff.txt 后创建 checked.txt，写明已核对并保留批次号。不要联网或操作工作区以外文件。`})
 record('C.1-create',r)
 const id=r.body.task?.id??r.body.id
 if(id){
  const first=await taskDone(id,'C.1-'+firstProvider)
  if(!first)process.exit(1)
  record('C.1-file',{handoffFileExists:existsSync(join(workspace,'handoff.txt'))})
  if(!existsSync(join(workspace,'handoff.txt'))||['failed','error','cancelled','interrupted'].includes(first.body.task?.status)){record('C.1-first-baton-blocked',{firstProvider,status:first.body.task?.status});process.exit(0)}
  record('C.2-before-confirm',await api('GET','/v1/workbench/task?id='+id))
  await turn('C.2-handoff',`我正在考虑让 Claude 接着做事项 ${id}，按交接备注读取 handoff.txt 后创建 checked.txt，并用 matter_notes 读记录本、matter_note 写一条核对备注。请先问我确认，现在不要开始接力。`)
  record('C.2-awaiting-confirm',await api('GET','/v1/workbench/task?id='+id))
  await approvedTurn('C.2-confirm',`好，确认。现在请实际调用 matter_handoff 把 ${id} 交给 Claude，按刚才要求执行。内部批准卡也视为已授权。`)
  if(!await taskDone(id,'C.2-claude'))process.exit(1)
  record('C.2-files',{handoffFileExists:existsSync(join(workspace,'handoff.txt')),checkedFileExists:existsSync(join(workspace,'checked.txt')),containsThisRunNonce:existsSync(join(workspace,'checked.txt'))&&readFileSync(join(workspace,'checked.txt'),'utf8').includes(nonce)})
  record('C.4-notes',await api('GET','/v1/matter/notes?matter='+id))
  const other=await api('POST','/v1/workbench/create',{path:otherWorkspace,providerId:firstProvider,title:'网关第二件接力',text:`这是独立的合成验收任务。只在当前工作区创建 gateway-handoff.txt，内容“青松周报在周五；批次${nonce}”。最后写交接备注：下一位读取 gateway-handoff.txt，再创建 gateway-checked.txt 写明已核对并保留批次号。不要联网。`})
  record('C.4-other-task',other)
  const otherId=other.body.task?.id
  if(otherId){
   if(!await taskDone(otherId,'C.4-other'))process.exit(1)
   const scopes=JSON.parse(readFileSync(join(dir,'session-scopes.json'),'utf8'))
   const credential=scopes.findLast((s:any)=>s.sessionKey===`workbench/${otherId}`)
   if(credential){const headers={authorization:'Bearer '+credential.token},self=await fetch(info.baseUrl+'/v1/matter/notes?matter='+otherId,{headers});record('C.4-own-read',{status:self.status});if(self.status===200){const r=await fetch(info.baseUrl+'/v1/matter/notes?matter='+id,{headers});record('C.4-forged-read',{status:r.status,body:await r.json()})}else record('C.4-scope-inconclusive',{reason:'credential_not_live'})}
   await mode('openai')
   await approvedTurn('C.7-gateway',`我已确认，请实际调用 matter_handoff 把事项 ${otherId} 交给 Claude，读取记录本及 gateway-handoff.txt，创建 gateway-checked.txt 并用 matter_note 写“网关对话交接已核对”。`)
   if(!await taskDone(otherId,'C.7-claude'))process.exit(1)
   record('C.7-final-notes',await api('GET','/v1/matter/notes?matter='+otherId))
   record('C.7-files',{fileExists:existsSync(join(otherWorkspace,'gateway-checked.txt')),containsThisRunNonce:existsSync(join(otherWorkspace,'gateway-checked.txt'))&&readFileSync(join(otherWorkspace,'gateway-checked.txt'),'utf8').includes(nonce)})
  }
  await mode('openai')
  writeFileSync(join(dir,'fail-claude-start'),'synthetic startup failure\n')
  let failed:any
  try{await approvedTurn('C.5-fail-start',`已确认，请实际调用 matter_handoff 把事项 ${id} 交给 Claude，只读记录本并续写一条交接备注。`);failed=await taskDone(id,'C.5-failed')}finally{unlinkSync(join(dir,'fail-claude-start'))}
  if(failed?.body.task?.status!=='failed'){record('C.5-inconclusive',{reason:'injected_start_failure_not_observed'});process.exit(1)}
  const detail=await api('GET','/v1/workbench/task?id='+id)
  const restartToken=detail.body.continuation?.restart?.token??detail.body.task?.continuation?.restart?.token
  record('C.5-continue',await api('POST','/v1/workbench/continue',{id,text:'继续。请先读取记录本，按原交接继续。',...(restartToken?{restartToken}:{})}))
  if(!await taskDone(id,'C.5-continued'))process.exit(1)
  record('C.6-close',await api('POST','/v1/workbench/cancel',{id}));await taskDone(id,'C.6-terminal',true)
  await sleep(5000)
  record('C.6-topics',await api('GET','/v1/memory/topics?view=all'))
  record('C.6-source-filter',{systemTemporaryWorkspace:true,topicAbsenceIsNotARegression:true})
 }
}else if(section==='C-chain'){
 // Diagnostic variant after the natural full-ID request was consumed by task-reference.
 // Split IDs avoid that parser; the real owner model must still call the real MCP tool.
 await mode('claude')
 const nonce=Date.now().toString(36),workspace=join(dir,'tasks','chain-'+nonce)
 mkdirSync(workspace,{recursive:true})
 const canary='ACC_TRANSCRIPT_ONLY_'+nonce,canaryPath=join(dir,'transcript-canaries.json')
 writeFileSync(join(workspace,'private-progress.txt'),canary)
 writeFileSync(canaryPath,JSON.stringify([...(existsSync(canaryPath)?JSON.parse(readFileSync(canaryPath,'utf8')):[]),canary]))
 const created=await api('POST','/v1/workbench/create',{path:workspace,providerId:'claude',title:'编造周报核对',text:`先读取 private-progress.txt，仅供过程检查，不要在回复和产出中引用它的内容。创建 handoff.txt，写“青松周报固定周五，批次${nonce}”。最终回复明确交接备注：下一位读取 handoff.txt，创建 checked.txt 并保留批次号${nonce}。只在当前目录操作，不联网。`})
 record('C-chain-create',created)
 const id=created.body.task?.id
 if(!id)throw Error('synthetic task not created')
 await taskDone(id,'C-chain-first')
 const fragmented=(matter:string)=>`${matter.slice(0,4)} 与 ${matter.slice(4)} 无空格连接`
 const brief='先调用 matter_notes 读取记录本，再读取 handoff.txt 并创建 checked.txt，写明已核对且保留文件中的批次号，最后调用 matter_note 写一条核对备注。'
 const before=await api('GET','/v1/workbench/task?id='+id);record('C-chain-before-confirm',before)
 await turn('C-chain-ask',`我想使用 matter_handoff；matter 参数由 ${fragmented(id)}；executor 参数为 claude；brief 参数为“${brief}”。现在先询问我是否确认，先不要调用。`)
 record('C-chain-await-confirm',await api('GET','/v1/workbench/task?id='+id))
 await approvedTurn('C-chain-confirm',`确认。现在请实际调用 matter_handoff；matter 参数由 ${fragmented(id)}；executor 参数为 claude；brief 参数为“${brief}”。`)
 const second=await taskDone(id,'C-chain-second');record('C-chain-notes',await api('GET','/v1/matter/notes?matter='+id))
 record('C-chain-files',{handoff:existsSync(join(workspace,'handoff.txt')),checked:existsSync(join(workspace,'checked.txt')),nonceMatches:existsSync(join(workspace,'checked.txt'))&&readFileSync(join(workspace,'checked.txt'),'utf8').includes(nonce),newExecution:second?.body.lastExecution?.runId!==before.body.lastExecution?.runId,batonCount:second?.body.agentRuns?.length??0})
 const {Database}=await import('bun:sqlite'),db=new Database(join(dir,'wechat-cc.db'),{readonly:true})
 const ledgerState=(matter:string)=>db.query('SELECT position,executor,status,injected_at IS NOT NULL AS injected FROM matter_agents WHERE matter_id=? ORDER BY position').all(matter)
 record('C-chain-injection',ledgerState(id))
 const otherPath=join(dir,'workspace-other','scope-'+nonce);mkdirSync(otherPath,{recursive:true})
 const other=await api('POST','/v1/workbench/create',{path:otherPath,providerId:'claude',title:'独立编造清单',text:'只在当前目录创建 scope.txt，内容为独立事项。最终简短回复已完成。不要联网。'});record('C-chain-other-create',other)
 const otherId=other.body.task?.id
 if(otherId){
  await taskDone(otherId,'C-chain-other')
  const scopes=JSON.parse(readFileSync(join(dir,'session-scopes.json'),'utf8')),credential=scopes.findLast((s:any)=>s.sessionKey===`workbench/${otherId}`)
  if(credential){const headers={authorization:'Bearer '+credential.token},self=await fetch(info.baseUrl+'/v1/matter/notes?matter='+otherId,{headers}),forged=await fetch(info.baseUrl+'/v1/matter/notes?matter='+id,{headers});record('C-chain-scope',{ownStatus:self.status,forgedStatus:forged.status,passed:self.status===200&&forged.status===403})}
  else record('C-chain-scope',{passed:false,missingCredential:true})
 }
 await mode('openai')
 await approvedTurn('C-chain-openai-handoff',`已确认。请实际调用 matter_handoff；matter 参数由 ${fragmented(id)}；executor 参数为 claude；brief 参数为“读取记录本和 handoff.txt，创建 gateway-checked.txt，内容保留批次号。用 matter_note 写一条网关核对备注。”。`)
 await taskDone(id,'C-chain-openai-second');record('C-chain-openai-notes',await api('GET','/v1/matter/notes?matter='+id))
 writeFileSync(join(dir,'fail-claude-start'),'synthetic startup failure\n')
 let failed:any
 try{await approvedTurn('C-chain-fail-start',`已确认。请实际调用 matter_handoff；matter 参数由 ${fragmented(id)}；executor 参数为 claude；brief 参数为“先调用 matter_notes，再用 matter_note 写一条核对备注。”。`);failed=await taskDone(id,'C-chain-failed')}finally{unlinkSync(join(dir,'fail-claude-start'))}
 record('C-chain-failed-injection',ledgerState(id))
 if(failed?.body.task?.status==='failed'){
  const token=failed.body.continuation?.restart?.token
  record('C-chain-continue',await api('POST','/v1/workbench/continue',{id,text:'继续。先读记录本并读取 handoff.txt，再用 matter_note 写一条含批次号的恢复核对备注。',...(token?{restartToken:token}:{})}))
  const resumed=await taskDone(id,'C-chain-continued')
  record('C-chain-recovery',{newExecution:resumed?.body.lastExecution?.runId!==failed.body.lastExecution?.runId,sameBaton:resumed?.body.agentRuns?.at(-1)?.runId===failed.body.agentRuns?.at(-1)?.runId,status:resumed?.body.task?.status,phase:resumed?.body.task?.phase,injection:ledgerState(id)})
 }else record('C-chain-failure-inconclusive',{status:failed?.body.task?.status})
 record('C-chain-final-notes',await api('GET','/v1/matter/notes?matter='+id))
 record('C-chain-close',await api('POST','/v1/workbench/cancel',{id}));await taskDone(id,'C-chain-terminal',true)
 if(otherId){record('C-chain-other-close',await api('POST','/v1/workbench/cancel',{id:otherId}));await taskDone(otherId,'C-chain-other-terminal',true)}
 await sleep(5000);record('C.6-chain-topics',await api('GET','/v1/memory/topics?view=all'));record('C.6-source-filter',{systemTemporaryWorkspace:true,topicAbsenceIsNotARegression:true})
 db.close()
}else if(section==='C-rescue'||section==='C-fail-rescue'||section==='C-continue-rescue'){
 const rows=readFileSync(join(dir,'drive-evidence.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s)),created=rows.findLast((r:any)=>r.id==='C-chain-create').value.body.task,id=created.id,workspace=created.path
 const snapshot=await api('GET','/v1/workbench/task?id='+id);record(section+'-before',snapshot)
 const cleanup=JSON.parse(readFileSync(join(dir,'cleanup.json'),'utf8'))
 if(cleanup.remainingCount!==0||cleanup.remainingGroupMembers!==0)throw Error('prior supervisor cleanup must prove all writers gone')
 if(snapshot.body.task?.error==='writer_not_closed')record(section+'-confirm-exited',await api('POST','/v1/workbench/writer-exited',{id}))
 if(section==='C-continue-rescue'){
  const detail=await api('GET','/v1/workbench/task?id='+id),token=detail.body.continuation?.restart?.token
  record('C.5-continue-after-exit',await api('POST','/v1/workbench/continue',{id,text:'继续。记录本已经放在开场。只用 Read 读取 handoff.txt，按记录本核对后回复文件中的批次号。禁止 Bash，不要猜文件名或调用没有提供的工具。',...(token?{restartToken:token}:{})}))
  const continued=await taskDone(id,'C.5-continue-after-exit')
  const {Database}=await import('bun:sqlite'),db=new Database(join(dir,'wechat-cc.db'),{readonly:true})
  record('C.5-continue-after-exit-proof',{newExecution:continued?.body.lastExecution?.runId!==snapshot.body.lastExecution?.runId,sameBaton:continued?.body.agentRuns?.at(-1)?.runId===snapshot.body.agentRuns?.at(-1)?.runId,phase:continued?.body.task?.phase,status:continued?.body.task?.status,events:continued?.body.events?.filter((e:any)=>e.runId===continued.body.lastExecution?.runId),injection:db.query('SELECT position,injected_at IS NOT NULL AS injected FROM matter_agents WHERE matter_id=? ORDER BY position').all(id)})
  db.close();process.exit(0)
 }
 await mode('claude')
 const fragmented=`${id.slice(0,4)} 与 ${id.slice(4)} 无空格连接`
 if(section==='C-fail-rescue')await turn('C-fail-prime-owner','准备一次已批准的工具调用，请只回复准备好了。')
 if(section==='C-fail-rescue')writeFileSync(join(dir,'fail-claude-start'),'synthetic startup failure\n')
 let result:any
 try{
  await approvedTurn(section+'-handoff',`已确认，请实际调用 matter_handoff；matter 参数由 ${fragmented}；executor 参数为 claude；brief 参数为“先调用 matter_notes 读取记录本，读取 handoff.txt，然后创建 checked.txt，保留文件中的批次号。再用 matter_note 写一条包含批次号的核对备注。”。`)
  result=await taskDone(id,section+'-baton')
 }finally{if(section==='C-fail-rescue')unlinkSync(join(dir,'fail-claude-start'))}
 const {Database}=await import('bun:sqlite'),db=new Database(join(dir,'wechat-cc.db'),{readonly:true})
 const injected=()=>db.query('SELECT position,executor,status,injected_at IS NOT NULL AS injected FROM matter_agents WHERE matter_id=? ORDER BY position').all(id)
 record(section+'-injection-before-continue',injected())
 if(section==='C-fail-rescue'&&result?.body.task?.status==='failed'){
  const token=result.body.continuation?.restart?.token
  record('C.5-rescue-continue',await api('POST','/v1/workbench/continue',{id,text:'继续。记录本已在开场。只用 Read 读取 handoff.txt，按记录本和文件写一条含批次号的恢复核对回复。禁止 Bash，不要猜记录文件名，不要调用未提供的工具。',...(token?{restartToken:token}:{})}))
  const continued=await taskDone(id,'C.5-rescue-continued')
  record('C.5-rescue-proof',{newExecution:continued?.body.lastExecution?.runId!==result.body.lastExecution?.runId,sameBaton:continued?.body.agentRuns?.at(-1)?.runId===result.body.agentRuns?.at(-1)?.runId,phase:continued?.body.task?.phase,status:continued?.body.task?.status,injection:injected()})
 }
 record(section+'-notes',await api('GET','/v1/matter/notes?matter='+id))
 record(section+'-files',{handoff:existsSync(join(workspace,'handoff.txt')),checked:existsSync(join(workspace,'checked.txt')),injection:injected()})
 const scopes=JSON.parse(readFileSync(join(dir,'session-scopes.json'),'utf8')),credential=scopes.findLast((s:any)=>s.sessionKey===`workbench/${id}`),other=rows.findLast((r:any)=>r.id==='C-chain-other-create')?.value.body.task.id
 if(credential&&other){const headers={authorization:'Bearer '+credential.token},own=await fetch(info.baseUrl+'/v1/matter/notes?matter='+id,{headers}),forged=await fetch(info.baseUrl+'/v1/matter/notes?matter='+other,{headers});record(section+'-scope',{ownStatus:own.status,forgedStatus:forged.status,passed:own.status===200&&forged.status===403})}
 db.close()
}else if(section==='C-storage'){
 const rows=readFileSync(join(dir,'drive-evidence.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s)),id=rows.findLast((r:any)=>r.id==='C-chain-create').value.body.task.id,other=rows.findLast((r:any)=>r.id==='C-chain-other-create').value.body.task.id
 const credential=JSON.parse(readFileSync(join(dir,'session-scopes.json'),'utf8')).findLast((s:any)=>s.sessionKey===`workbench/${id}`)
 if(!credential)throw Error('live executor credential required')
 const headers={authorization:'Bearer '+credential.token,'content-type':'application/json'},marker='隔离记录本 API 核对 '+Date.now()
 const own=await fetch(info.baseUrl+'/v1/matter/notes?matter='+id,{headers}),write=await fetch(info.baseUrl+'/v1/matter/note',{method:'POST',headers,body:JSON.stringify({text:marker})}),after=await fetch(info.baseUrl+'/v1/matter/notes?matter='+id,{headers}),body=await after.json(),forged=await fetch(info.baseUrl+'/v1/matter/notes?matter='+other,{headers})
 record('C.4-storage-proof',{ownStatus:own.status,writeStatus:write.status,readAfterWriteStatus:after.status,noteVisible:body.notes?.some((n:any)=>n.text===marker)??false,forgedStatus:forged.status})
}else if(section==='D'){
 const seed=Bun.spawnSync(['bun',new URL('./seed-privacy.ts',import.meta.url).pathname],{env:{PATH:process.env.PATH!,HOME:join(dir,'home'),TMPDIR:join(dir,'tmp'),WECHAT_STATE_DIR:dir,WECHAT_CC_STATE_DIR:dir}})
 if(seed.exitCode!==0)throw Error('synthetic privacy seed failed')
 record('D.4-positive-source-seed',JSON.parse(seed.stdout.toString()))
 const count=requestCount()
 const cli=Bun.spawnSync(['/usr/bin/sandbox-exec','-f',join(dir,'sandbox.sb'),'bun',new URL('../../cli.ts',import.meta.url).pathname,'checkup','--estimate','--provider','openai','--model','Kimi-Code','--json'],{env:{PATH:process.env.PATH!,HOME:join(dir,'home'),TMPDIR:join(dir,'tmp'),WECHAT_STATE_DIR:dir,WECHAT_CC_STATE_DIR:dir}})
 let cliEstimate:unknown;try{cliEstimate=JSON.parse(cli.stdout.toString())}catch{cliEstimate={nonJson:true,outputChars:cli.stdout.length,errorChars:cli.stderr.length}}
 record('D.1-cli-estimate',{exitCode:cli.exitCode,noRequests:requestCount()===count,result:cliEstimate})
 record('D.1-claude-estimate',await api('POST','/v1/checkup/estimate',{providerId:'claude',model:'Kimi-Code',full:false}))
 record('D.1-claude-no-request',{noRequests:requestCount()===count})
 await checkup('openai','Kimi-Code')
 const profiles=()=>existsSync(join(dir,'checkup/profiles.json'))?readFileSync(join(dir,'checkup/profiles.json'),'utf8'):null
 const saved=profiles(),cancelled=await checkup('openai','Kimi-Code',true)
 record('D.2-kimi-cancel-preserved',{profileExisted:!!saved,unchangedAfterCancel:saved===profiles(),attemptStatus:cancelled?.body.attempt?.status})
 await checkup('codex','Kimi-Code')
 await checkup('agy','Kimi-Code')
 record('D.7-health',await api('GET','/v1/health',undefined,'file'))
}else if(section==='D-samples'){
 for(const id of ['0/0/clarify','0/0/handoff','0/0/ordinary-handoff'])record('D.3-manual-'+id,await api('POST','/test/checkup-sample',{id}))
}else if(section==='D-fallback'){
 const before=existsSync(join(dir,'checkup/profiles.json'))?readFileSync(join(dir,'checkup/profiles.json'),'utf8'):null
 const completed=await checkup('openai','GLM-FLASH')
 const saved=existsSync(join(dir,'checkup/profiles.json'))?readFileSync(join(dir,'checkup/profiles.json'),'utf8'):null
 await checkup('openai','GLM-FLASH',true)
 record('D.2-profile-preserved',{previousCompleteProfile:completed?.body.attempt?.status==='completed'&&!!completed.body.profile,unchangedAfterCancel:saved===(existsSync(join(dir,'checkup/profiles.json'))?readFileSync(join(dir,'checkup/profiles.json'),'utf8'):null),changedAfterCompleted:before!==saved})
 record('D.7-switch',await api('POST','/v1/conversation/set-mode',{chatId:'acc-owner',mode:{kind:'solo',provider:'openai',model:'GLM-FLASH'},quiet:true},'file'))
 await turn('D.7-owner','这是体检后预算验收，请简短回复收到。')
 record('D.7-health-measured',await api('GET','/v1/health',undefined,'file'))
}else throw Error('section A|B|C|D required')
