import {createInternalApi} from '../../daemon/internal-api'
import {makeWorkbenchStore} from '../../adapters/store/workbench/store'
import {afterEach,expect,it} from 'vitest'
import {hostname,tmpdir} from 'node:os'
import {mkdtempSync,mkdirSync,symlinkSync,realpathSync} from 'node:fs'
import {join} from 'node:path'
import {removeTempDir} from '../../lib/test-temp'
import {openTestDb,type Db} from '../../lib/db'
import {makeMatterStore} from '../../adapters/store/matters-store'
import {makeCliSessionStore} from '../../adapters/store/cli-session-store'
import {makeTerminalParticipations,terminalParticipationKey} from '../../adapters/store/terminal-participations'
import {makeMatterLedger} from '../../adapters/store/matter-ledger'
import {makeLedgerDomain} from '../workbench/service/ledger'
import type {ServiceCtx} from '../workbench/service/ctx'
import {ledgerRoutes} from '../workbench/ledger-routes'
import type {WorkbenchService} from '../workbench/service'
import {participationRoutes} from './participation-routes'
import {matterApprovals} from '../workbench/service/matter-approvals'
import {makeTokenRegistry} from '../../daemon/internal-api/token-registry'

const dbs:Db[]=[]
afterEach(()=>{for(const db of dbs.splice(0))db.close()})
function setup(){
  const db=openTestDb();dbs.push(db)
  const now=Date.now(),matters=makeMatterStore(db),sessions=makeCliSessionStore(db),p=makeTerminalParticipations(db),ledger=makeMatterLedger(db)
  const source=matters.create({kind:'terminal',title:'source',ownerChatId:'owner'})
  const target=matters.create({kind:'task',title:'target',ownerChatId:'owner'}),other=matters.create({kind:'task',title:'other',ownerChatId:'owner'})
  const sid='abcdef12-1234-5678-9000'
  sessions.touch({session_id:sid,source:'claude',cwd:'/tmp/fixture',machine:hostname()},now);matters.bind(source.id,'cli',sid)
  const domain=makeLedgerDomain({store:{ledger,atomic:(fn:()=>void)=>fn(),bump:()=>{}},state:{runsByTask:new Map()},deps:{}} as unknown as ServiceCtx,{} as Parameters<typeof makeLedgerDomain>[1])
  const routes=ledgerRoutes({workbench:domain as unknown as WorkbenchService})
  const caller=(key:string)=>({tier:'trusted' as const,origin:'session' as const,sessionKey:key})
  return {db,matters,sessions,p,ledger,source,target,other,sid,domain,routes,caller}
}
it('精确身份、唯一活跃参与、单参与者启用记录本，不写计划或改 CLI binding',()=>{
  const f=setup()
  expect(()=>f.p.attach(f.sid.slice(0,6),f.target.id,'owner')).toThrow('terminal_session_unavailable')
  f.sessions.touch({session_id:'abcdef12-another-session',source:'codex',cwd:'/tmp',machine:hostname()},Date.now())
  expect(()=>f.p.attach('abcdef12',f.target.id,'owner')).toThrow('terminal_session_unavailable')
  expect(()=>f.p.attach(f.sid,f.target.id,'stranger')).toThrow('terminal_target_unavailable')
  const p=f.p.attach(f.sid,f.target.id,'owner')
  expect(f.ledger.enabled(f.target.id)).toBe(true)
  expect(()=>f.p.attach(f.sid,f.target.id,'owner')).toThrow('terminal_already_attached')
  expect(()=>f.p.attach(f.sid,f.other.id,'owner')).toThrow('terminal_already_attached')
  expect(f.db.query('SELECT 1 FROM matter_plans').all()).toHaveLength(0)
  expect(f.matters.findBySurface('cli',f.sid)?.id).toBe(f.source.id)
  expect(p.runId.length>0).toBe(true)
})
it('A 的参与身份不能读 B；作者/run 由服务端决定，拒绝伪造字段和 context',async()=>{
  const f=setup(),p=f.p.attach(f.sid,f.target.id,'owner'),c=f.caller(terminalParticipationKey(p))
  expect((await f.routes['GET /v1/matter/notes']!(new URLSearchParams({matter:f.other.id}),null,c)).status).toBe(403)
  expect((await f.routes['POST /v1/matter/note']!(new URLSearchParams(),{text:'forged',author:'cc',runId:'fake'},c)).status).toBe(400)
  expect((await f.routes['POST /v1/matter/note']!(new URLSearchParams(),{text:'cross matter',matter:f.other.id},c)).status).toBe(400)
  expect((await f.routes['GET /v1/matter/context']!(new URLSearchParams(),null,c)).status).toBe(403)
  expect((await f.routes['POST /v1/matter/note']!(new URLSearchParams(),{text:'progress'},c)).status).toBe(200)
  expect(f.ledger.notes(f.target.id)).toMatchObject([{author:p.author,runId:p.runId,text:'progress'}])
  expect((await f.routes['GET /v1/matter/notes']!(new URLSearchParams(),null,c)).status).toBe(200)
  for(let i=1;i<50;i++)f.domain.matterNote(c.sessionKey,'note')
  expect(()=>f.domain.matterNote(c.sessionKey,'overflow')).toThrow('matter_note_limit')
  expect(f.ledger.notes(f.other.id)).toHaveLength(0)
})
it.each(['detach','end','archive','prune','binding','restart'] as const)('%s 后旧身份读写都拒绝；历史保留',async(reason)=>{
  const f=setup(),p=f.p.attach(f.sid,f.target.id,'owner'),key=terminalParticipationKey(p),c=f.caller(key)
  f.domain.matterNote(key,'kept')
  if(reason==='detach')f.p.detach(p.id)
  if(reason==='end')f.matters.setLifecycle(f.source.id,'done')
  if(reason==='archive')f.matters.setLifecycle(f.target.id,'archived')
  if(reason==='prune')f.db.query('DELETE FROM cli_sessions WHERE session_id=?').run(f.sid)
  if(reason==='binding')f.db.query("DELETE FROM matter_bindings WHERE surface='cli' AND surface_key=?").run(f.sid)
  if(reason==='restart')makeTerminalParticipations(f.db).restart()
  expect((await f.routes['GET /v1/matter/notes']!(new URLSearchParams(),null,c)).status).toBe(403)
  expect((await f.routes['POST /v1/matter/note']!(new URLSearchParams(),{text:'late'},c)).status).toBe(403)
  expect(f.ledger.notes(f.target.id)).toHaveLength(1)
  expect(f.p.list(f.target.id)[0]?.detachedAt!==null).toBe(true)
  if(reason==='detach'||reason==='restart'){
    const next=f.p.attach(f.sid,f.target.id,'owner')
    expect(next.generation).toBe(p.generation+1)
    expect(()=>f.p.bound(key)).toThrow()
  }
})
it('远端、结束、stale、归档目标、自动接力都拒绝',()=>{
  for(const kind of ['remote','ended','stale','archive','relay']){
    const f=setup()
    if(kind==='remote')f.db.query("UPDATE cli_sessions SET origin_agent='remote' WHERE session_id=?").run(f.sid)
    if(kind==='ended')f.matters.setLifecycle(f.source.id,'done')
    if(kind==='stale')f.db.query('UPDATE cli_sessions SET last_event_at=? WHERE session_id=?').run(Date.now()-31*60_000,f.sid)
    if(kind==='archive')f.matters.setLifecycle(f.target.id,'archived')
    if(kind==='relay')f.db.query("INSERT INTO matter_plans(matter_id,state,approved_at,created_at) VALUES(?,'approved',?,?)").run(f.target.id,Date.now(),Date.now())
    expect(()=>f.p.attach(f.sid,f.target.id,'owner')).toThrow()
  }
})
it('挂摘只许 operator 或主人对话中一次性批准；其他 admin 拒绝',async()=>{
  const f=setup(),approvals=matterApprovals(),body={sessionId:f.sid,matter:f.target.id}
  const r=participationRoutes({owner:()=>'owner',approved:(t,b)=>approvals.get('turn',t,b)?.approved===true,consume:(t,b)=>approvals.consume('turn',t,b),attach:(sid,id,owner)=>({participation:f.p.attach(sid,id,owner),token:'fixture-unused'}),detach:id=>f.p.detach(id)})
  const invoke=(caller:Parameters<NonNullable<typeof r[string]>>[2],b:unknown=body)=>r['POST /v1/cli/attach']!(new URLSearchParams(),b,caller)
  expect((await invoke({tier:'admin',origin:'session',chatId:'stranger'})).status).toBe(403)
  expect((await invoke({tier:'admin',origin:'device'})).status).toBe(403)
  const owner={tier:'admin' as const,origin:'session' as const,chatId:'owner'}
  expect((await invoke(owner)).status).toBe(403)
  approvals.approve('turn','mcp__wechat__terminal_attach',body)
  expect((await invoke(owner)).status).toBe(200)
  expect((await invoke(owner)).status).toBe(403)
  const p=f.p.list(f.target.id)[0]!
  expect((await r['POST /v1/cli/detach']!(new URLSearchParams(),{participationId:p.id},{tier:'admin',origin:'operator'})).status).toBe(200)
  expect((await invoke({tier:'admin',origin:'operator'})).status).toBe(200)
})

it('凭据只允许记录本两条路由，摘下撤销及新 registry 重启均拒绝原凭据',()=>{
  const f=setup(),p=f.p.attach(f.sid,f.target.id,'owner'),key=terminalParticipationKey(p),registry=makeTokenRegistry()
  const token=registry.mint('trusted',key,{routeAllow:new Set(['GET /v1/matter/notes','POST /v1/matter/note'])})
  // Only booleans/route names reach assertions; never print the credential.
  expect(registry.resolve(token)?.routeAllow?.has('GET /v1/matter/notes')).toBe(true)
  expect(registry.resolve(token)?.routeAllow?.has('GET /v1/matter/context')).toBe(false)
  expect(makeTokenRegistry().resolve(token)===null).toBe(true)
  registry.invalidateSession(key)
  expect(registry.resolve(token)===null).toBe(true)
})

it('真实 bind 新来源立即撤销旧授权；不能从多来源任取一条重新授权',()=>{
  const f=setup(),p=f.p.attach(f.sid,f.target.id,'owner'),key=terminalParticipationKey(p)
  const next=f.matters.create({kind:'terminal',title:'new source',ownerChatId:'owner'})
  f.matters.bind(next.id,'cli',f.sid)
  expect(()=>f.p.bound(key)).toThrow()
  expect(f.p.list(f.target.id)[0]?.detachReason).toBe('binding_changed')
  expect(()=>f.p.attach(f.sid,f.target.id,'owner')).toThrow('terminal_session_unavailable')
})
it('终端从符号链接路径挂入后，工作台真实路径也被占用',()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cc-participation-path-')))
  try{
    const actual=join(root,'project'),alias=join(root,'alias');mkdirSync(actual);symlinkSync(actual,alias,'dir')
    const f=setup();f.db.query('UPDATE cli_sessions SET cwd=? WHERE session_id=?').run(alias,f.sid)
    const p=f.p.attach(f.sid,f.target.id,'owner')
    expect(f.p.conflicts(actual)).toBe(true)
    f.p.detach(p.id)
    expect(f.p.conflicts(actual)).toBe(false)
  }finally{removeTempDir(root)}
})

it('目标仍有工作台写入者或未关闭的写入者时拒绝挂入',()=>{
  const f=setup(),store=makeWorkbenchStore(f.db),task=store.create({title:'writer',path:'/tmp/fixture',providerId:'codex',ownerChatId:'owner'})
  expect(()=>f.p.attach(f.sid,task.id,'owner')).toThrow('workbench_busy')
  store.update(task.id,'interrupted','writer_not_closed')
  expect(()=>f.p.attach(f.sid,task.id,'owner')).toThrow('workbench_busy')
  store.update(task.id,'completed')
  const p=f.p.attach(f.sid,task.id,'owner')
  expect(p.matterId).toBe(task.id)
  expect(f.matters.terminalLedger?.(task.id)?.terminalParticipants).toHaveLength(1)
})

it('隔离回环 API 以真实参与令牌只读写 A；跨事、context、摘下和撤销后拒绝',async()=>{
  const stateDir=mkdtempSync(join(tmpdir(),'cc-participation-api-')),f=setup()
  const api=createInternalApi({stateDir,daemonPid:1,tokenRegistry:makeTokenRegistry()})
  api.mount('workbench',f.routes)
  const p=f.p.attach(f.sid,f.target.id,'owner'),key=terminalParticipationKey(p)
  const token=api.mintSessionToken('trusted',key,{routeAllow:new Set(['GET /v1/matter/notes','POST /v1/matter/note'])})
  try{
    await api.start()
    const call=(path:string,text?:object)=>fetch(`http://127.0.0.1:${api.port()}${path}`,{method:text?'POST':'GET',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(text?{body:JSON.stringify(text)}:{})})
    expect((await call('/v1/matter/notes')).status).toBe(200)
    expect((await call('/v1/matter/note',{text:'API progress'})).status).toBe(200)
    expect((await call(`/v1/matter/notes?matter=${f.other.id}`)).status).toBe(403)
    expect((await call('/v1/matter/note',{text:'forged',matter:f.other.id})).status).toBe(400)
    expect((await call('/v1/matter/context')).status).toBe(403)
    f.p.detach(p.id)
    expect((await call('/v1/matter/notes')).status).toBe(403)
    expect((await call('/v1/matter/note',{text:'late'})).status).toBe(403)
    api.invalidateSession(key)
    expect((await call('/v1/matter/notes')).status).toBe(401)
  }finally{await api.stop();removeTempDir(stateDir)}
})

it.each(['same','parent','child','symlink'] as const)('挂入事务拒绝已有终端的 %s 路径占用，摘下后可挂入',kind=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cc-attach-conflict-')))
  try{
    const project=join(root,'project'),child=join(project,'child'),alias=join(root,'alias')
    mkdirSync(child,{recursive:true});symlinkSync(project,alias,'dir')
    const f=setup(),second='second-terminal-session',source=f.matters.create({kind:'terminal',title:'second',ownerChatId:'owner'})
    const firstPath=kind==='parent'?child:project,secondPath=kind==='child'?child:kind==='symlink'?alias:project
    f.db.query('UPDATE cli_sessions SET cwd=? WHERE session_id=?').run(firstPath,f.sid)
    f.sessions.touch({session_id:second,source:'codex',cwd:secondPath,machine:hostname()},Date.now());f.matters.bind(source.id,'cli',second)
    const first=f.p.attach(f.sid,f.target.id,'owner')
    expect(()=>f.p.attach(second,f.other.id,'owner')).toThrow('terminal_path_busy')
    expect(f.p.list(f.other.id)).toHaveLength(0)
    f.p.detach(first.id)
    expect(f.p.attach(second,f.other.id,'owner').matterId).toBe(f.other.id)
  }finally{removeTempDir(root)}
})
