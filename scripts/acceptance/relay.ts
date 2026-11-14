/** Natural owner requests, real temporary daemon, no fabricated tool calls. */
import {readFileSync,writeFileSync,appendFileSync,existsSync,mkdirSync,readdirSync,renameSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {loadavg} from 'node:os'
import {Database} from 'bun:sqlite'

const stateDir=process.env.WECHAT_STATE_DIR
if(!stateDir?.startsWith('/private/tmp/')||!stateDir.includes('/acc/state/'))throw Error('explicit temporary state required')
const dir=stateDir
const command=process.argv[2],sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms))
if(command==='prepare'){
 if(existsSync(dir))throw Error('new state required')
 mkdirSync(dir,{recursive:true,mode:0o700});writeFileSync(join(dir,'.relay-acceptance'),'synthetic relay acceptance\n')
 const project=resolve(process.argv[3]??join(dir,'../../projects',dir.split('/').at(-1)!))
 if(project!==resolve(dir,'../../projects',dir.split('/').at(-1)!))throw Error('project must be this run\'s external temporary repository')
 if(existsSync(project))throw Error('new empty project directory required')
 mkdirSync(project,{recursive:true,mode:0o700})
 const init=Bun.spawnSync(['git','init','--quiet',project]);if(init.exitCode)throw Error('git init failed')
 writeFileSync(join(dir,'projects.json'),JSON.stringify({projects:{'relay-lab':{path:project,last_active:new Date().toISOString()}},current:null}))
 writeFileSync(join(dir,'current-cwd'),process.argv[4]==='same-cwd'?project:join(dir,'workspace'))
 writeFileSync(join(dir,'relay-config.json'),JSON.stringify({project,fault:process.argv[4]==='missing-project'?'missing-project':null}))
 console.log(JSON.stringify({prepared:true,projectInsideState:project.startsWith(dir+'/')}));process.exit(0)
}
if(!existsSync(join(dir,'.acceptance-only'))||!existsSync(join(dir,'.relay-acceptance')))throw Error('relay acceptance marker required')
const info=JSON.parse(readFileSync(join(dir,'internal-api-info.json'),'utf8')),ready=JSON.parse(readFileSync(join(dir,'ready.json'),'utf8'))
if([info.baseUrl,ready.controlUrl].some(u=>new URL(u).hostname!=='127.0.0.1'))throw Error('loopback required')
const op=readFileSync(join(dir,'internal-operator-token'),'utf8').trim(),file=readFileSync(join(dir,'internal-token'),'utf8').trim()
const config=JSON.parse(readFileSync(join(dir,'relay-config.json'),'utf8'))
const rows=(name:string):any[]=>existsSync(join(dir,name))?readFileSync(join(dir,name),'utf8').split('\n').filter(Boolean).map(s=>JSON.parse(s)):[]
const safe=(x:unknown)=>JSON.parse(JSON.stringify(x).replace(/\b[a-f0-9]{64}\b/g,'[HEX64]').replace(/Bearer\s+[A-Za-z0-9._-]+/gi,'Bearer [REDACTED]'))
function record(kind:string,value:unknown){appendFileSync(join(dir,'relay-evidence.jsonl'),JSON.stringify({at:new Date().toISOString(),scenario:command,kind,value:safe(value)})+'\n');console.log(JSON.stringify({scenario:command,kind,...(kind==='result'?{value}: {})}))}
async function api(method:string,path:string,body?:unknown,auth:'operator'|'file'='operator'){
 const test=path.startsWith('/test/'),r=await fetch((test?ready.controlUrl:info.baseUrl)+(test?path.slice(5):path),{method,headers:{'content-type':'application/json',...(!test?{authorization:'Bearer '+(auth==='file'?file:op)}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(660000)})
 const value=await r.json();return {status:r.status,body:value}
}
function plan(id:string){const db=new Database(join(dir,'wechat-cc.db'),{readonly:true});try{const p:any=db.query('SELECT * FROM matter_plans WHERE matter_id=?').get(id);return p?{...p,legs:db.query('SELECT * FROM matter_plan_legs WHERE matter_id=? ORDER BY position').all(id)}:null}finally{db.close()}}
function ids(){const db=new Database(join(dir,'wechat-cc.db'),{readonly:true});try{return db.query<{id:string},[]>('SELECT id FROM matters WHERE kind=\'task\' ORDER BY created_at').all().map(x=>x.id)}finally{db.close()}}
function approvedCreationFailed(){
 const db=new Database(join(dir,'wechat-cc.db'),{readonly:true})
 try{for(const row of db.query<{messages_json:string},[]>('SELECT messages_json FROM openai_chat_sessions').all()){
  for(const message of JSON.parse(row.messages_json))if(message.role==='tool'&&Array.isArray(message.content))for(const item of message.content){
   if(item.toolName!=='matter_plan'||item.output?.type!=='text')continue
   try{const failure=JSON.parse(item.output.value);if(typeof failure.error==='string'&&failure.approved===true)return failure}catch{/* Non-JSON denial text is not an approved backend failure. */}
  }
 }return null}finally{db.close()}
}
function projectOutputs(){
 const files:Record<string,string>={}
 function visit(relative:string){for(const entry of readdirSync(join(config.project,relative),{withFileTypes:true})){
  if(entry.name==='.git')continue
  const path=join(relative,entry.name)
  if(entry.isDirectory())visit(path)
  else if(entry.isFile()&&/^(notes|summary|check|todo)\.md$/.test(entry.name))files[path]=readFileSync(join(config.project,path),'utf8')
 }}
 visit('');return files
}
async function snapshot(id:string,label:string){const detail=await api('GET','/v1/workbench/task?id='+id);record(label,{id,plan:plan(id),detail});return detail.body}
async function gate(){const end=Date.now()+1200000;for(;;){const load=loadavg()[0]!;record('load-gate',{load,allowed:load<12});if(load<12)return;if(Date.now()>=end)throw Error('load gate timeout');await sleep(30000)}}
let s4QuotaInjected=false
async function injectQuota(){
 if(command!=='S4'||s4QuotaInjected)return
 const active=ids().map(id=>({id,plan:plan(id)})).find(p=>p.plan?.state==='approved'&&p.plan.legs[0]?.state==='running'&&p.plan.legs[1]?.state==='pending')
 if(active){record('quota-before-injection',active);record('quota-injected',await api('POST','/test/relay-quota',{provider:active.plan.legs[1].executor,blocked:true}));s4QuotaInjected=true}
}
async function owner(label:string,text:string,approval=false){
 record(label+'-input',{text});let settled=false
 const pending=new Set<string>(),work=api('POST','/v1/companion/converse',{text});void work.then(()=>settled=true,()=>settled=true)
 let movedProject=false
 try{
 while(!settled){
  const r=await api('GET','/v1/permissions/pending')
  for(const card of r.body.items??[]){if(pending.has(card.hash))continue;pending.add(card.hash);record(label+'-approval-card',card)
   // Only the owner's initial scheduling or explicit takeover is authorized.
   // A second card is retained as a finding instead of silently approving it.
   const expected=label==='manual-takeover'?'matter_handoff':'matter_plan'
   if(approval&&pending.size===1&&String(card.prompt).includes(expected)){
    if(command==='S7'&&config.fault==='missing-project'){
     renameSync(config.project,config.project+'.moved');movedProject=true
     record('project-moved-before-approval',{project:config.project,temporary:config.project+'.moved'})
    }
    record(label+'-approval-result',await api('POST','/v1/permissions/resolve',{hash:card.hash,decision:'allow'}))
   }
   else record(label+'-unexpected-card-denied',await api('POST','/v1/permissions/resolve',{hash:card.hash,decision:'deny'}))
  }
  await injectQuota()
  await sleep(250)
 }
 const result=await work.catch(error=>({status:0,body:{error:error?.name==='TimeoutError'?'acceptance_turn_timeout':'acceptance_request_failed'}}));record(label+'-reply',result);return result
 }finally{if(movedProject){
  if(existsSync(config.project)){renameSync(config.project,config.project+'.recreated');record('project-recreated-during-failure',{savedAs:config.project+'.recreated'})}
  renameSync(config.project+'.moved',config.project);record('project-restored',{project:config.project})
 }}
}
async function wait(id:string,label:string,until:'stop'|'done'|'second'='done',timeout=180000,since=0){
 const end=Date.now()+timeout;let last:any
 const denied=new Set<string>()
 while(Date.now()<end){
  await injectQuota()
  const permissions=await api('GET','/v1/permissions/pending')
  for(const card of permissions.body.items??[]){if(card.taskId!==id||denied.has(card.hash))continue;denied.add(card.hash);record(label+'-extra-task-approval-card',card);record(label+'-extra-task-approval-denied',await api('POST','/v1/permissions/resolve',{hash:card.hash,decision:'deny'}))}
  last=await api('GET','/v1/workbench/task?id='+id);const p=plan(id),t=last.body.task??{}
  const quiet=t.phase==='replied'||['completed','done','failed','error','interrupted','cancelled'].includes(t.status)
  const changed=!since||(last.body.events??[]).some((e:any)=>e.kind==='text'&&Number(e.createdAt??e.at??e.ts??0)>=since)
  const stopped=p?.legs.some((l:any)=>l.state==='stopped'||l.stop_reason)
  const failed=['failed','error','interrupted','cancelled'].includes(t.status)
  const reached=until==='second'?p?.legs[1]?.state==='running'||stopped||failed:until==='stop'?p?.state==='done'||p?.state==='cancelled'||stopped||failed||(!p&&quiet):p?.state==='done'||((p?.state==='cancelled'||stopped||!p)&&quiet&&changed)
  if(reached){await sleep(1000);return snapshot(id,label)}
  await sleep(300)
 }
 record(label+'-timeout',{id,last});return snapshot(id,label)
}
async function settleReports(){
 const deadline=Date.now()+130000
 let pending=0
 do{
  const db=new Database(join(dir,'wechat-cc.db'),{readonly:true})
  try{pending=(db.query<{n:number},[]>("SELECT COUNT(*) AS n FROM matter_report_outbox WHERE status='pending'").get()?.n??0)}finally{db.close()}
  if(!pending)break
  await sleep(1000)
 }while(Date.now()<deadline)
 record('report-queue-settled',{pending})
}
async function finish(id:string){await snapshot(id,'final');await settleReports();record('outbox',await api('GET','/test/outbox'));record('files',Object.fromEntries(['notes.md','summary.md','check.md','todo.md'].map(name=>[name,existsSync(join(config.project,name))?readFileSync(join(config.project,name),'utf8'):null])))}
if(command==='setup'){
 await gate();record('mode',await api('POST','/v1/conversation/set-mode',{chatId:'acc-owner',mode:{kind:'solo',provider:'openai'},quiet:true},'file'))
 record('project',await api('POST','/v1/workbench/project',{path:config.project,name:'relay-lab',providerId:'claude'}))
 const listed=await api('GET','/v1/projects/list',undefined,'file');record('project-alias-check',listed)
 if(listed.status!==200||!listed.body.some((p:any)=>p.alias==='relay-lab'&&p.path===config.project))throw Error('owner project fixture missing')
 const options=await api('GET','/v1/workbench/entry-options');record('entry-options',options)
 config.projectId=options.body.projects?.find((p:any)=>p.path===config.project)?.id
 if(!/^p-[a-f0-9]{20}$/.test(config.projectId??''))throw Error('valid project identity required')
 writeFileSync(join(dir,'relay-config.json'),JSON.stringify(config))
 record('providers',await api('GET','/v1/workbench'));process.exit(0)
}
if(command==='inspect'){for(const id of ids())await snapshot(id,'inspect');record('project-outputs',projectOutputs());record('providers',await api('GET','/v1/workbench'));record('outbox',await api('GET','/test/outbox'));process.exit(0)}
if(command==='probe'){
 await gate()
 for(const providerId of ['openai','claude']){
  const result=await api('POST','/v1/workbench/create',{path:config.project,providerId,title:'隔离执行者预检-'+providerId,text:'在当前项目根目录创建 probe-'+providerId+'.md，写一句“隔离网关执行者预检完成”，回读确认后简短报告。只操作本地文件，不联网。'})
  record('probe-create-'+providerId,result)
  if(result.body.task?.id){await wait(result.body.task.id,'probe-'+providerId);await snapshot(result.body.task.id,'probe-final-'+providerId)}
 }
 record('outbox',await api('GET','/test/outbox'));process.exit(0)
}
if(command==='say'){
 await gate();await owner('followup',process.argv[3]!,true);for(const id of ids())await wait(id,'after-followup');process.exit(0)
}
if(!/^S[1-7]$/.test(command??''))throw Error('prepare|setup|inspect|probe|say|S1..S7 required')
await gate()
const beforeIds=new Set(ids()),started=Date.now(),before=rows('gateway.jsonl').length
const first=process.argv[3]??'claude',second=process.argv[4]??'openai'
const projectName='“relay-lab”'
const common=`在${projectName}这个项目里，只处理当前工作区的文件，不联网。`
const parts={
 S1:`让 ${first} 先建 notes.md 写三条整理书桌的要点，然后让 ${second} 读 notes.md 把三条要点扩成 summary.md，最后再让 ${first} 检查这两个文件并把检查结论写进 check.md。`,
 S2:`先让 ${first} 在 notes.md 写三条旅行准备要点；然后让 ${second} 读它，必须先问我 summary.md 用“简洁版”还是“详细版”，等我二选一后才能写，不能替我决定；最后让 ${first} 检查 notes.md 和 summary.md，写 check.md。`,
 S3:`先让 ${first} 写 notes.md，列三条整理资料的要点；然后让 ${second} 读取 missing-source.md，只能基于这个源文件写 summary.md，找不到就如实停下，不要编造；最后让 ${first} 检查 notes.md 和 summary.md，写 check.md。`,
 S4:`先让 ${first} 建 notes.md 写三条整理桌面的要点，然后让 ${second} 读它扩写 summary.md，最后让 ${first} 核对两个文件并写 check.md。`,
 S5:`只让 ${first} 建 todo.md，写三条待办，完成后告诉我。`,
 S6:`先让 ${first} 写 notes.md，列三条旅行准备要点；然后让 ${second} 读它，必须先问我 summary.md 用“简洁版”还是“详细版”，等我选择才能写；最后让 ${first} 检查两个文件并写 check.md。`,
 S7:`只让 ${first} 建 todo.md，写三条待办，完成后告诉我。`,
}
const prompts=[common+parts[command as keyof typeof parts],`帮我在${projectName}项目安排这件事：${parts[command as keyof typeof parts]}只操作这个项目，不联网。`]
if(command==='S7'&&config.fault==='missing-project')prompts.splice(0,1)
let id:string|undefined
for(let attempt=0;attempt<prompts.length;attempt++){
 const count=rows('relay-tool-calls.jsonl').length
 await owner('attempt-'+(attempt+1),prompts[attempt]!,true)
 id=ids().find(x=>!beforeIds.has(x))
 record('attempt-'+(attempt+1)+'-routing',{id:id??null,toolCalls:rows('relay-tool-calls.jsonl').slice(count)})
 const failure=command==='S7'&&!id?approvedCreationFailed():null
 if(failure){record('approved-creation-failed',failure);break}
 if(id){
  const singleCall=rows('relay-tool-calls.jsonl').slice(count).some(c=>{try{const a=JSON.parse(c.arguments);return /(?:^|__)matter_plan$/.test(c.name)&&a.legs?.length===1&&a.legs[0].executor===first}catch{return false}})
  const p=plan(id),correct=['S5','S7'].includes(command??'')?!p&&singleCall:p?.legs.length===3&&p.legs[0].executor===first&&p.legs[1].executor===second&&p.legs[2].executor===first
  if(correct)break
  record('incorrect-routing',{id,plan:p});record('cancel-incorrect-routing',await api('POST','/v1/workbench/cancel',{id}));beforeIds.add(id);id=undefined
 }
}
if(id){
 let d=await wait(id,'initial',command==='S6'?'second':'stop')
 if(command==='S2'&&plan(id)?.legs[1]?.state==='stopped'){
  record('before-answer-third-untouched',{plan:plan(id)});const resumedAt=Date.now();await owner('answer',`这件 ${id}，选简洁版。`);d=await wait(id,'after-answer','done',180000,resumedAt)
 }else if(command==='S3'&&plan(id)?.legs[1]?.state==='stopped'){
  record('before-continue-third-untouched',{plan:plan(id)});const resumedAt=Date.now();await owner('continue',`继续，${id} 这件缺的源文件不用了，改读 notes.md 并据此写 summary.md。`);d=await wait(id,'after-continue','done',180000,resumedAt)
 }else if(command==='S4'&&plan(id)?.legs[0]?.state==='completed'&&plan(id)?.legs[1]?.stop_reason==='next_unavailable'){
  record('before-quota-recovery',{plan:plan(id)});record('quota-restored',await api('POST','/test/relay-quota',{provider:second,blocked:false}));const resumedAt=Date.now();await owner('continue',`继续，${id} 这件按原拆法接着做。`);d=await wait(id,'after-continue','done',180000,resumedAt)
 }else if(command==='S6'&&['running','stopped'].includes(plan(id)?.legs[1]?.state)){
  // Give the second executor time to ask; the takeover is still a natural CC request.
  d=await wait(id,'second-paused','stop');const resumedAt=Date.now();await owner('manual-takeover',`让 ${first} 接着做事项 ${id} 的后半段，采用简洁版写 summary.md，先不用写 check.md。`,true);d=await wait(id,'after-takeover','done',180000,resumedAt)
 }
 await finish(id)
}
if(!id){await sleep(65000);record('outbox',await api('GET','/test/outbox'));record('files-without-task',Object.fromEntries(['notes.md','summary.md','check.md','todo.md'].map(name=>[name,existsSync(join(config.project,name))?readFileSync(join(config.project,name),'utf8'):null])))}
record('result',{id:id??null,elapsedMs:Date.now()-started,requestStart:before,requestEnd:rows('gateway.jsonl').length,plan:id?plan(id):null})
