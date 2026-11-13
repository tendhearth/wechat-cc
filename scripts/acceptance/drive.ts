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
  const owner=scopes.findLast((s:any)=>s.tier==='admin'&&s.sessionKey.includes('acc-owner'))
  if(!owner)throw Error('owner session not observed');token=owner.token
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
 if(cancel){await sleep(800);record('D-cancel',await api('POST','/v1/checkup/cancel',{}))}
 for(let i=0;i<1800;i++){
  const r=await api('GET','/v1/checkup?run='+quote.body.targetKey)
  if(r.body.attempt?.status!=='running'){record('D-result-'+providerId+'-'+model,r);return r}
  if(i%30===0)record('D-progress',{providerId,model,completedRequests:r.body.attempt.completedRequests})
  await sleep(1000)
 }
 record('D-timeout',await api('POST','/v1/checkup/cancel',{}))
}
// Gate applies to every invocation, before any new model work.
const until=Date.now()+1800000
for(;;){const load=loadavg()[0],rows=Bun.spawnSync(['ps','-axo','comm=']).stdout.toString();const game=rows.split('\n').some(s=>s.toLowerCase().includes('civilizationvii'));if(load<8&&!game){record('load-gate',{load,game,allowed:true});break}record('load-gate',{load,game,allowed:false});if(Date.now()>=until)process.exit(3);await sleep(Math.min(30000,Math.max(0,until-Date.now())))}
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
}else if(section==='A-codex'){
 await mode('codex');await turn('A.7-codex-recheck','这是新的一轮验收。必须重新实际调用 today_digest 工具查询今天的在办事项，不能沿用旧结果。一句话回复。')
 record('A.7-codex-ps',JSON.parse(Bun.spawnSync(['python3',new URL('./run.py',import.meta.url).pathname,'ps'],{env:{...process.env,WECHAT_STATE_DIR:dir}}).stdout.toString()))
 await mode('claude')
}else if(section==='A-long'){
 await mode('claude');await turn('A.6-long','请调用 delegate_codex，交代它：在隔离工作区用命令执行 sleep 75，等命令真实结束后只回复4。拿到它的最终结果后告诉我，不要自己替它回答。这是长调用验收。')
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
}else if(section==='C'){
 await mode('claude')
 const nonce=Date.now().toString(36),workspace=join(dir,'workspace','relay-'+nonce),otherWorkspace=join(dir,'workspace-other','relay-'+nonce)
 mkdirSync(workspace,{recursive:true});mkdirSync(otherWorkspace,{recursive:true})
 const r=await api('POST','/v1/workbench/create',{path:workspace,providerId:'codex',title:'青松文件接力',text:`这是隔离验收。只在当前工作区创建 handoff.txt，内容为“青松周报在周五；批次${nonce}”。最后回复交接备注：下一位读取 handoff.txt 后创建 checked.txt，写明已核对并保留批次号。不要联网或操作工作区以外文件。`})
 record('C.1-create',r)
 const id=r.body.task?.id??r.body.id
 if(id){
  if(!await taskDone(id,'C.1-codex'))process.exit(1)
  record('C.1-file',{handoffFileExists:existsSync(join(workspace,'handoff.txt'))})
  await approvedTurn('C.2-handoff',`请调用 matter_handoff 让 Claude 接着做事项 ${id}，按交接备注读取 handoff.txt 后创建 checked.txt，并用 matter_notes 读记录本、matter_note 写一条核对备注。请先向我确认。`)
  await approvedTurn('C.2-confirm',`好，确认。现在请实际调用 matter_handoff 把 ${id} 交给 Claude，按刚才要求执行。内部批准卡也视为已授权。`)
  if(!await taskDone(id,'C.2-claude'))process.exit(1)
  record('C.2-files',{handoffFileExists:existsSync(join(workspace,'handoff.txt')),checkedFileExists:existsSync(join(workspace,'checked.txt')),containsThisRunNonce:existsSync(join(workspace,'checked.txt'))&&readFileSync(join(workspace,'checked.txt'),'utf8').includes(nonce)})
  record('C.4-notes',await api('GET','/v1/matter/notes?matter='+id))
  const other=await api('POST','/v1/workbench/create',{path:otherWorkspace,providerId:'codex',title:'网关第二件接力',text:`这是独立的合成验收任务。只在当前工作区创建 gateway-handoff.txt，内容“青松周报在周五；批次${nonce}”。最后写交接备注：下一位读取 gateway-handoff.txt，再创建 gateway-checked.txt 写明已核对并保留批次号。不要联网。`})
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
}else if(section==='D'){
 const seed=Bun.spawnSync(['bun',new URL('./seed-privacy.ts',import.meta.url).pathname],{env:{PATH:process.env.PATH!,HOME:join(dir,'home'),TMPDIR:join(dir,'tmp'),WECHAT_STATE_DIR:dir,WECHAT_CC_STATE_DIR:dir}})
 if(seed.exitCode!==0)throw Error('synthetic privacy seed failed')
 record('D.4-positive-source-seed',JSON.parse(seed.stdout.toString()))
 const count=requestCount()
 record('D.1-claude-estimate',await api('POST','/v1/checkup/estimate',{providerId:'claude',model:'Kimi-Code',full:false}))
 record('D.1-claude-no-request',{noRequests:requestCount()===count})
 await checkup('openai','Kimi-Code')
 await checkup('openai','Kimi-Code',true)
 await checkup('codex','Kimi-Code')
 await checkup('agy','Kimi-Code')
 record('D.7-health',await api('GET','/v1/health',undefined,'file'))
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
