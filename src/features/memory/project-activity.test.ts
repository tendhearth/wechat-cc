import { makeTerminalSteps } from '../terminal/terminal-steps'
import { makeTerminalStepStore } from '../../adapters/store/terminal-steps'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openTestDb, type Db } from '../../lib/db'
import { makeThreadsStore } from '../../lib/threads-store'
import { makeMatterStore } from '../../adapters/store/matters-store'
import { makeMatterLog } from '../../adapters/store/matter-log'
import { makeTerminalTurnLog } from '../../adapters/store/terminal-turns'
import { makeCliSessionStore } from '../../adapters/store/cli-session-store'
import { makeMatterSeen } from '../../adapters/store/matter-seen'
import { makeDesktopSurface } from '../../daemon/desktop-surface'
import { CLI_SESSION_STALE_MS } from '../../domain/cli-session-view'
import { projectActivities } from './project-activity'
import { topicsProjection, topicDetailPage } from './topic-projection'
import { makeTopicBubbles } from '../../lib/topic-bubbles'
import { makeProjectTopicResolver } from '../terminal/project-memory'
import { resolveTopicRecall } from '../../daemon/threads/recall'
import { makePhoneEventsWiring } from '../phone/phone-topic-sources'
import { matterFeed } from '../../adapters/store/matter-feed'
import { hintWrite, onWriteHint } from '../../lib/write-hints'

const dbs: Db[] = []
afterEach(() => { vi.restoreAllMocks(); for (const db of dbs.splice(0)) db.close() })
const root = '/projects/bx', worktree = '/worktrees/bx'
const identity = { key: `${root}/.git`, roots: [root,worktree], names: ['bx'] }
async function fixture() {
  const db = openTestDb(); dbs.push(db)
  let at = Date.now()
  const now = () => at, threads = makeThreadsStore(db), matters = makeMatterStore(db,now), log = makeMatterLog(db,now)
  const id = await threads.create({ chatId:'owner', title:'bx', summary:'', facets:[], tags:[], private:false, episodes:[] })
  const turns = makeTerminalTurnLog({ db,log,matters }), cli = makeCliSessionStore(db,now)
  const terminal = (sid:string,age=0) => { cli.touch({session_id:sid,source:'claude',cwd:root},at-age); turns.event({session_id:sid,source:'claude',cwd:root,kind:'prompt'},at-age); return matters.findBySurface('cli',sid)! }
  const identify = vi.fn(async (_path:string) => identity)
  return { db,threads,matters,log,id,turns,cli,terminal,identify,now,tick:() => {at++} }
}
describe('project activity from existing session and task facts', () => {
  it('six ranu-shaped terminal replies never claim owner attention or unread results, including weeks-old stops', async () => {
    const f=await fixture()
    await f.threads.update(f.id,{title:'ranu'})
    f.identify.mockResolvedValue({...identity,names:['ranu']})
    for(let n=0;n<6;n++){
      const sid=`ranu-${n}`,at=f.now()-n*7*24*60*60_000
      f.terminal(sid,f.now()-at)
      f.turns.event({session_id:sid,source:'claude',cwd:root,kind:'stop',text:'已答复，等你看'},at)
    }
    const value=(await projectActivities(f.db,'owner',()=>null,f.identify)).get(f.id)!
    expect(value.activity).toMatchObject({waiting:0,running:0,unread:0})
    expect(value.sessions).toHaveLength(6)
    expect(value.sessions.every(s=>s.activity==='idle'&&s.latestStep==='答完了')).toBe(true)
    const recall=await resolveTopicRecall('ranu 那边怎么样了',[{id:f.id,title:'ranu',aliases:[],tags:[],summary:'',lastActive:'',entries:[]}],{activity:new Map([[f.id,value]]),bodies:false})
    expect(recall!.block).not.toMatch(/[1-9] 个等你|[1-9] 个做完未看|已答复，等你看/)
    expect(recall!.block).toContain('答完了')
  })
  it('a previous terminal reply cannot hide failure in the latest interrupted round',async()=>{
    const f=await fixture(),m=f.terminal('reused')
    f.turns.event({session_id:'reused',source:'claude',cwd:root,kind:'stop',text:'上一轮已答复'},f.now())
    f.tick();f.turns.event({session_id:'reused',source:'claude',cwd:root,kind:'prompt'},f.now())
    f.log.writeItem({matterId:m.id,kind:'error',status:'failed',payload:{text:'原会话中的错误正文'}})
    f.tick();f.turns.event({session_id:'reused',source:'claude',cwd:root,kind:'session_end'},f.now())
    const value=(await projectActivities(f.db,'owner',()=>null,f.identify)).get(f.id)!
    expect(value.activity).toMatchObject({waiting:0,running:0,unread:0})
    expect(value.sessions[0]).toMatchObject({activity:'idle',latestStep:'步骤失败'})
  })
  it('only actual pending permissions and questions wait, regardless of seen or terminal/task origin', async () => {
    const f=await fixture(),m=f.terminal('requests'),seen=()=> 'desktop'
    f.turns.permissionAsked({session_id:'requests',source:'claude',cwd:root,tool_name:'Read'},f.now())
    const read=()=>projectActivities(f.db,'owner',seen,f.identify)
    expect((await read()).get(f.id)!.activity.waiting).toBe(1)
    f.turns.permissionSettled('requests','allow')
    f.log.writeItem({matterId:m.id,kind:'question',status:'started',key:'question-terminal',payload:{questions:[{question:'留在原会话的问题'}]}})
    expect((await read()).get(f.id)!.sessions[0]).toMatchObject({activity:'waiting',latestStep:'等你回答'})
    f.log.writeItem({matterId:m.id,kind:'question',status:'completed',key:'question-terminal',payload:{}})
    const task=f.matters.create({kind:'task',title:'CC 交办',projectPath:root,ownerChatId:'owner'})
    f.log.writeItem({matterId:task.id,kind:'question',status:'started',key:'question-task',payload:{}})
    expect((await read()).get(f.id)!.activity.waiting).toBe(1)
  })
  it.each(['desktop','phone'] as const)('CC task replied results count unread until seen on %s, including an idle reusable task',async(surface)=>{
    const f=await fixture(),desktop=makeDesktopSurface(f.now),seen=makeMatterSeen(f.db,desktop)
    const task=f.matters.create({kind:'task',title:'CC 交办结果',projectPath:root,ownerChatId:'owner'})
    const turn=f.log.startTurn({matterId:task.id,executor:'codex'})
    f.log.writeItem({matterId:task.id,turnId:turn.id,kind:'agent_message',status:'completed',payload:{text:'结果只在 CC 里看'}})
    f.log.finishTurn(turn.id,{status:'completed'})
    const source=()=>({phase:'replied',requestId:null,waitingFor:null})
    const read=()=>projectActivities(f.db,'owner',seen,f.identify,source)
    expect((await read()).get(f.id)!.activity).toMatchObject({waiting:0,running:0,unread:1})
    f.tick()
    if(surface==='desktop')desktop.noteSeen(task.id)
    else f.matters.bind(task.id,'phone','app')
    expect((await read()).get(f.id)!.activity).toMatchObject({waiting:0,running:0,unread:0})
  })
  it('queued and replied rounds do not run, and a leftover waiting state without a request does not wait',async()=>{
    const f=await fixture(),task=f.matters.create({kind:'task',title:'排队的任务',projectPath:root,ownerChatId:'owner'})
    f.log.startTurn({matterId:task.id,executor:'codex'})
    const m=f.terminal('leftover')
    f.turns.event({session_id:'leftover',source:'claude',cwd:root,kind:'stop'},f.now())
    f.db.query("UPDATE matters SET state='waiting' WHERE id=?").run(m.id)
    const queued=()=>({phase:'queued',requestId:null,waitingFor:null})
    expect((await projectActivities(f.db,'owner',()=>null,f.identify,queued)).get(f.id)!.activity).toMatchObject({waiting:0,running:0,unread:0})
    const working=()=>({phase:'working',requestId:null,waitingFor:null})
    expect((await projectActivities(f.db,'owner',()=>null,f.identify,working)).get(f.id)!.activity).toMatchObject({waiting:0,running:1,unread:0})
  })
  it('terminal permissions retain tool metadata and unresolved requests remain waiting after stale', async () => {
    const f = await fixture(), fresh = f.terminal('fresh'), old = f.terminal('old',CLI_SESSION_STALE_MS+1000)
    f.turns.permissionAsked({session_id:'fresh',source:'claude',cwd:root,tool_name:'Bash',summary:'检查迁移'},f.now())
    f.turns.permissionAsked({session_id:'old',source:'claude',cwd:root,tool_name:'Bash',summary:'过期请求'},f.now()-CLI_SESSION_STALE_MS-1000)
    const value = (await projectActivities(f.db,'owner',()=>null,f.identify)).get(f.id)!
    expect(value.activity).toMatchObject({waiting:2,running:0,unread:0})
    expect(value.sessions.find(s=>s.id===fresh.id)).toMatchObject({activity:'waiting',latestStep:expect.stringContaining('Bash')})
    expect(value.sessions.find(s=>s.id===fresh.id)!.latestStep).toBe('等你批准 · Bash')
    expect(value.sessions.find(s=>s.id===old.id)).toMatchObject({activity:'waiting',latestStep:'等你批准 · Bash'})
  })
  it('task pending/runtime phase comes from the narrow source and nested tool labels show the actual latest step', async () => {
    const f = await fixture(), task = f.matters.create({kind:'task',title:'检查项目',projectPath:root,ownerChatId:'owner'})
    const turn = f.log.startTurn({matterId:task.id,executor:'codex'})
    f.log.writeItem({matterId:task.id,turnId:turn.id,kind:'tool_call',status:'started',payload:{text:'完整审计不进入活动',activity:{label:'核验迁移',output:'秘密正文'}}})
    let fact = {phase:'working',requestId:'permission-id' as string|null,waitingFor:'Bash: 运行本地检查' as string|null}
    const source = vi.fn(() => fact)
    const read = async () => (await projectActivities(f.db,'owner',()=>null,f.identify,source)).get(f.id)!
    expect((await read()).sessions[0]).toMatchObject({activity:'waiting',requestId:'permission-id',latestStep:'等你回应'})
    fact = {phase:'working',requestId:null,waitingFor:null}
    expect((await read()).sessions[0]).toMatchObject({activity:'running',latestStep:'工具步骤'})
    f.log.writeItem({matterId:task.id,turnId:turn.id,kind:'agent_message',status:'completed',payload:{text:'这段正文不能进入话题活动'}})
    fact = {phase:'replied',requestId:null,waitingFor:null}
    expect((await read()).activity).toMatchObject({waiting:0,unread:1,running:0})
    expect(JSON.stringify(await read())).not.toContain('秘密正文')
    expect(JSON.stringify(await read())).not.toContain('这段正文不能进入')
  })
  it('terminal replies never need seen, while an open permission remains waiting even after seen', async () => {
    const f = await fixture(), terminal = f.terminal('done'), desktop = makeDesktopSurface(f.now), seen = makeMatterSeen(f.db,desktop)
    f.turns.event({session_id:'done',source:'claude',cwd:root,kind:'stop',text:'不把答复正文带进话题'},f.now())
    expect((await projectActivities(f.db,'owner',seen,f.identify)).get(f.id)!.activity).toMatchObject({waiting:0,unread:0})
    f.tick();desktop.noteSeen(terminal.id)
    expect((await projectActivities(f.db,'owner',seen,f.identify)).get(f.id)!.activity.waiting).toBe(0)
    const bubbles=makeTopicBubbles(f.db);bubbles.adopt('owner','open','owner',[{id:f.id}]);const sleep=bubbles.beginSleep('owner','sleep')
    const activity=await projectActivities(f.db,'owner',seen,f.identify)
    expect(bubbles.closeAfterSleep(sleep,new Set([...activity].filter(([,v])=>v.activity.waiting||v.activity.running).map(([id])=>id)))).toBe(1)
    f.tick();f.turns.permissionAsked({session_id:'done',source:'claude',cwd:root,tool_name:'Read',summary:'读配置'},f.now())
    desktop.noteSeen(terminal.id);f.matters.bind(terminal.id,'phone','pwa')
    expect((await projectActivities(f.db,'owner',seen,f.identify)).get(f.id)!.activity.waiting).toBe(1)
    f.tick();f.turns.event({session_id:'done',source:'claude',cwd:root,kind:'session_end'},f.now())
    expect((await projectActivities(f.db,'owner',seen,f.identify)).get(f.id)!.activity.unread).toBe(0)
    f.matters.bind(terminal.id,'phone','pwa')
    expect((await projectActivities(f.db,'owner',seen,f.identify)).get(f.id)!.activity.unread).toBe(0)
  })
  it('recent sorting includes thread activity when no session exists', async () => {
    const f = await fixture()
    const newer = await f.threads.create({chatId:'owner',title:'新话题',summary:'',facets:[],tags:[],private:false,episodes:[]})
    await f.threads.update(f.id,{lastActive:'2030-01-01T00:00:00Z'})
    await f.threads.update(newer,{lastActive:'2020-01-01T00:00:00Z'})
    expect((await topicsProjection(f.db,'owner')).summary.recentIds[0]).toBe(f.id)
  })
  it('activity and seen changes push through the existing topics source without polling', async () => {
    const f=await fixture(), m=f.matters.create({kind:'task',title:'CC 交办推送',projectPath:root,ownerChatId:'owner'}), desktop=makeDesktopSurface(f.now),seen=makeMatterSeen(f.db,desktop)
    const turn=f.log.startTurn({matterId:m.id,executor:'codex'})
    const wiring=makePhoneEventsWiring({home:async()=>({}) as never,changes:matterFeed(f.db),hints:cb=>onWriteHint(f.db,cb),pollMs:60_000,
      topics:async()=>Object.fromEntries(await projectActivities(f.db,'owner',seen,f.identify))})
    const frames:any[]=[];const off=wiring.events.subscribe('topics',undefined,frame=>frames.push(frame.data))
    try {
      await expect.poll(()=>frames.length).toBe(1)
      expect(frames[0][f.id].activity.running).toBe(1)
      f.tick();f.log.writeItem({matterId:m.id,turnId:turn.id,kind:'agent_message',status:'completed',payload:{text:'完整答复不入活动'}})
      f.log.finishTurn(turn.id,{status:'completed',matterState:'done'})
      await expect.poll(()=>frames.length).toBe(2)
      expect(frames[1][f.id].activity).toMatchObject({waiting:0,unread:1,running:0})
      f.tick();desktop.noteSeen(m.id);hintWrite(f.db,{kind:'matter',matterId:m.id})
      await expect.poll(()=>frames.length).toBe(3)
      expect(frames[2][f.id].activity.waiting).toBe(0)
      expect(frames[2][f.id].activity.unread).toBe(0)
      expect(JSON.stringify(frames)).not.toContain('完整答复不入活动')
    } finally {off();wiring.dispose()}
  })
  it('an explicitly ambiguous worktree path cannot be hidden by a uniquely mapped project path', async () => {
    const f=await fixture(), m=f.terminal('ambiguous')
    await f.threads.create({chatId:'owner',title:'other',summary:'',facets:[],tags:[],private:false,episodes:[]})
    f.log.updateTurn(f.log.turns(m.id)[0]!.id,{policy:{cwd:'/projects/conflict'}})
    const identify=async(path:string)=>path==='/projects/conflict'?{key:'/projects/conflict/.git',roots:['/projects/conflict'],names:['bx','other']}:identity
    expect(await projectActivities(f.db,'owner',()=>null,identify)).toEqual(new Map())
  })
  it('waiting and running projects enter the recent eight before newer idle projects', async () => {
    const f=await fixture(), ids:string[]=[],seenIds=new Set<string>()
    for(let n=0;n<10;n++){
      const id=n===0?f.id:await f.threads.create({chatId:'owner',title:`project-${n}`,summary:'',facets:[],tags:[],private:false,episodes:[]})
      ids.push(id)
      const path=`/projects/activity-${n}`,sid=`activity-${n}`
      f.turns.event({session_id:sid,source:'claude',cwd:path,kind:'prompt'},f.now())
      const m=f.matters.findBySurface('cli',sid)!
      await f.threads.addEntry({threadId:id,kind:'progress',line:`项目${n}的来源`,source:'work',matterId:m.id})
      if(n===0)f.turns.permissionAsked({session_id:sid,source:'claude',cwd:path,tool_name:'Read',summary:'读文件'},f.now())
      if(n>1){f.turns.event({session_id:sid,source:'claude',cwd:path,kind:'stop',text:'完整答复'},f.now());seenIds.add(m.id)}
      f.tick()
    }
    const value=await topicsProjection(f.db,'owner',undefined,id=>seenIds.has(id)?'desktop':null)
    expect(value.summary.recentIds).toHaveLength(8)
    expect(value.summary.recentIds.slice(0,2)).toEqual(ids.slice(0,2))
  })
  it('shared resolver reuses identity evidence across project and worktree paths', async () => {
    const f = await fixture(), m=f.terminal('history')
    await f.threads.addEntry({threadId:f.id,kind:'progress',line:'进展',source:'work',matterId:m.id})
    const resolve=makeProjectTopicResolver(f.db,'owner',[{id:f.id,title:'bx',aliases:[],tags:[],summary:'',lastActive:'',entries:[]}],f.identify)
    expect((await resolve(root)).topicId).toBe(f.id)
    expect((await resolve(worktree)).topicId).toBe(f.id)
    expect(f.identify.mock.calls.filter(([path])=>path===root)).toHaveLength(1)
  })
  it('activity-only topics answer progress queries with bounded recent steps and no memory bodies', async () => {
    const activity=new Map([['bx',{activity:{waiting:1,running:2,unread:0,lastActiveAt:100},sessions:[{id:'m',kind:'task' as const,title:'核验设置',executor:'codex',activity:'waiting' as const,latestStep:'等你批准 · 本地检查',updatedAt:100,requestId:'p'}]}]])
    const r=await resolveTopicRecall('bx 那边怎么样了',[{id:'bx',title:'bx',aliases:['网络工具'],tags:[],summary:'',lastActive:'',entries:[]}],{activity,bodies:false})
    expect(r!.block).toContain('1 个等你，2 个在跑')
    expect(r!.block).toContain('等你批准 · 本地检查')
  })
})

it('uses the actual terminal transcript step summary without tool output or assistant bodies',async()=>{
 const f=await fixture(),m=f.terminal('transcript-step')
 const bytes=Buffer.from(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'PRIVATE_ASSISTANT_BODY'},{type:'tool_use',id:'check',name:'Bash',input:{command:'bun test'}}]}})+'\n')
 const steps=makeTerminalSteps({store:makeTerminalStepStore({db:f.db,log:f.log,matters:f.matters}),turns:f.turns,size:()=>bytes.length,read:(_p,from,to)=>bytes.subarray(from,to)})
 steps.ingest('transcript-step','/offline/transcript.jsonl','claude')
 const value=(await projectActivities(f.db,'owner',()=>null,f.identify)).get(f.id)!
 expect(value.sessions.find(s=>s.id===m.id)?.latestStep).toBe('运行命令')
 expect(JSON.stringify(value)).not.toContain('bun test')
 expect(JSON.stringify(value)).not.toContain('PRIVATE_ASSISTANT_BODY')
})

it('sends executor registry display names with project sessions',async()=>{
  const f=await fixture()
  for(const executor of ['codex','claude','cursor','gemini']){
    const task=f.matters.create({kind:'task',title:executor,projectPath:root,ownerChatId:'owner'})
    f.log.startTurn({matterId:task.id,executor})
  }
  const sessions=(await projectActivities(f.db,'owner',()=>null,f.identify)).get(f.id)!.sessions
  expect(Object.fromEntries(sessions.map(s=>[s.executor,(s as any).displayName]))).toEqual({codex:'Codex',claude:'Claude',cursor:'Cursor',gemini:'Gemini'})
})

it('preserves registered executor names, including the two Gemini connections',async()=>{
  const {executorNames}=await import('../../domain/provider-display-names')
  const f=await fixture()
  for(const executor of ['agy','gemini']){
    const task=f.matters.create({kind:'task',title:executor,projectPath:root,ownerChatId:'owner'})
    f.log.startTurn({matterId:task.id,executor})
  }
  const sessions=(await projectActivities(f.db,'owner',()=>null,f.identify,undefined,id=>executorNames(id,['agy','gemini']).name)).get(f.id)!.sessions
  expect(Object.fromEntries(sessions.map(s=>[s.executor,s.displayName]))).toEqual({agy:'Gemini(账号)',gemini:'Gemini'})
})


describe('independent review regressions',()=>{
  it('permission arguments, questions, diffs and tool output never enter activity or bodies:false recall',async()=>{
    const f=await fixture(), terminal=f.terminal('secret-permission')
    const secrets=['ordinary-secret','url-password','FAKE_TOKEN_123','- old-private\n+ new-private','PRIVATE_OUTPUT']
    const body=`curl --password=${secrets[0]} https://user:${secrets[1]}@example.invalid; TOKEN=${secrets[2]}\n${secrets[3]}\n${secrets[4]}`
    f.turns.permissionAsked({session_id:'secret-permission',source:'claude',cwd:root,tool_name:'Bash',summary:body},f.now())
    const task=f.matters.create({kind:'task',title:'审批文件',projectPath:root,ownerChatId:'owner'})
    const turn=f.log.startTurn({matterId:task.id,executor:'codex'})
    f.log.writeItem({matterId:task.id,turnId:turn.id,kind:'permission',status:'started',payload:{tool:'apply_patch',description:body}})
    const activity=await projectActivities(f.db,'owner',()=>null,f.identify,()=>({phase:'working',requestId:'p',waitingFor:body,requestKind:'permission',tool:'apply_patch'}))
    const recall=await resolveTopicRecall('bx 那边怎么样了',[{id:f.id,title:'bx',aliases:[],tags:[],summary:'',lastActive:'',entries:[]}],{activity,bodies:false})
    for(const secret of secrets){expect(JSON.stringify(activity.get(f.id))).not.toContain(secret);expect(recall!.block).not.toContain(secret)}
    expect(activity.get(f.id)!.sessions.find(s=>s.id===terminal.id)!.latestStep).toBe('等你批准 · Bash')
    expect(activity.get(f.id)!.sessions.find(s=>s.id===task.id)!.latestStep).toBe('等你批准 · apply_patch')
    f.log.writeItem({matterId:task.id,turnId:turn.id,kind:'tool_call',status:'completed',payload:{tool:'Bash',activity:{type:'command',label:body,output:body},text:body}})
    f.turns.event({session_id:'secret-permission',source:'claude',cwd:root,kind:'permission',decision:'allow'} as never,f.now())
    const steps=await projectActivities(f.db,'owner',()=>null,f.identify,()=>({phase:'working',requestId:null,waitingFor:null}))
    for(const secret of secrets)expect(JSON.stringify(steps.get(f.id))).not.toContain(secret)
  })
  it.each(['no-topic','private','done'])('current cwd %s cannot fall back to the old project, even with old work evidence',async(shape)=>{
    const f=await fixture(),m=f.terminal('moved')
    await f.threads.addEntry({threadId:f.id,kind:'progress',line:'旧项目产出',source:'work',matterId:m.id})
    f.turns.event({session_id:'moved',source:'claude',cwd:root,kind:'stop'},f.now());f.tick()
    if(shape!=='no-topic')await f.threads.create({chatId:'owner',title:'other',private:shape==='private',status:shape==='done'?'done':'active',summary:'',facets:[],tags:[],episodes:[]})
    f.cli.touch({session_id:'moved',source:'claude',cwd:'/projects/other'},f.now())
    f.turns.event({session_id:'moved',source:'claude',cwd:'/projects/other',kind:'prompt'},f.now())
    const identify=async(path:string)=>path==='/projects/other'?{key:'/projects/other/.git',roots:['/projects/other'],names:['other']}:identity
    expect(await projectActivities(f.db,'owner',()=>null,identify)).toEqual(new Map())
  })
  it('independent common dirs with the same repo/origin basename never merge by name',async()=>{
    const f=await fixture();await f.threads.update(f.id,{title:'app'})
    for(const path of ['/clients/one/app','/clients/two/app'])f.turns.event({session_id:path,source:'claude',cwd:path,kind:'prompt'},f.now())
    const identify=async(path:string)=>({key:path+'/.git',roots:[path],names:['app']})
    expect(await projectActivities(f.db,'owner',()=>null,identify)).toEqual(new Map())
  })
  it('unresolved old permission stays waiting while an old running turn expires',async()=>{
    const f=await fixture(),age=CLI_SESSION_STALE_MS+1000
    const pending=f.terminal('old-pending',age),running=f.terminal('old-running',age)
    f.turns.permissionAsked({session_id:'old-pending',source:'claude',cwd:root,tool_name:'Read',summary:'ignored'},f.now()-age)
    const value=(await projectActivities(f.db,'owner',()=>null,f.identify)).get(f.id)!
    expect(value.sessions.find(s=>s.id===pending.id)).toMatchObject({activity:'waiting',latestStep:'等你批准 · Read'})
    expect(value.sessions.find(s=>s.id===running.id)).toMatchObject({activity:'idle'})
    expect(value.activity).toMatchObject({waiting:1,running:0})
  })
  it('queued task runtime overrides the already-open working matter turn',async()=>{
    const f=await fixture(),m=f.matters.create({kind:'task',title:'路径被占，排队',projectPath:root,ownerChatId:'owner'})
    f.log.startTurn({matterId:m.id,executor:'codex'})
    const value=(await projectActivities(f.db,'owner',()=>null,f.identify,()=>({phase:'queued',requestId:null,waitingFor:null}))).get(f.id)!
    expect(value.activity.running).toBe(0)
    expect(value.sessions[0]).toMatchObject({activity:'idle',latestStep:'排队中'})
  })
  it('owner-checked workbench output establishes a renamed project association',async()=>{
    const f=await fixture();await f.threads.update(f.id,{title:'家庭服务器'})
    const m=f.matters.create({kind:'task',title:'配置服务器',projectPath:root,ownerChatId:'owner'})
    f.log.startTurn({matterId:m.id,executor:'codex'})
    const entry=await f.threads.addEntry({threadId:f.id,kind:'progress',line:'已整理配置',source:'work',matterId:m.id})
    expect((await projectActivities(f.db,'owner',()=>null,f.identify)).get(f.id)!.sessions[0]!.id).toBe(m.id)
    await f.threads.updateEntry(entry,{status:'superseded'})
    expect(await projectActivities(f.db,'owner',()=>null,f.identify)).toEqual(new Map())
  })
  it('warm projections, pushes and detail pages reuse activity; one changed matter does not reread unrelated history',async()=>{
    const f=await fixture(),seen=()=>null
    for(let i=0;i<120;i++)f.terminal(`cache-${i}`)
    for(let i=0;i<600;i++)await f.threads.addEntry({threadId:f.id,kind:'fact',line:`无关历史 ${i}`})
    const read=()=>projectActivities(f.db,'owner',seen,f.identify)
    await read();f.identify.mockClear()
    const query=vi.spyOn(f.db,'query')
    const first=await read()
    for(let i=0;i<10;i++)expect(await read()).toBe(first)
    expect(f.identify).not.toHaveBeenCalled()
    expect(query.mock.calls.length).toBeLessThanOrEqual(15)
    query.mockClear();f.tick()
    const m=f.matters.findBySurface('cli','cache-0')!
    f.log.writeItem({matterId:m.id,kind:'tool_call',status:'completed',payload:{tool:'Read'}})
    query.mockClear()
    const next=await read()
    expect(next).not.toBe(first)
    expect(f.identify).not.toHaveBeenCalled()
    expect(query.mock.calls.filter(([sql])=>/matter_items/.test(sql)).length).toBeLessThanOrEqual(2)
    expect(next.get(f.id)!.sessions).toHaveLength(120)
  })
  it('a failed identity path cannot suppress a healthy project',async()=>{
    const f=await fixture();f.terminal('healthy')
    f.turns.event({session_id:'broken',source:'claude',cwd:'/broken',kind:'prompt'},f.now())
    const identify=async(path:string)=>{if(path==='/broken')throw Error('unreadable');return identity}
    expect((await projectActivities(f.db,'owner',()=>null,identify)).get(f.id)!.sessions).toHaveLength(1)
  })
})


it('reuses cached small summaries and the same merged session list across pushes and detail pages',async()=>{
 const f=await fixture(),seen=()=>null
 for(let i=0;i<30;i++)f.terminal(`page-${i}`)
 const first=f.matters.findBySurface('cli','page-0')!
 await f.threads.addEntry({threadId:f.id,kind:'progress',line:'明确来源',source:'work',matterId:first.id})
 for(let i=0;i<800;i++)await f.threads.addEntry({threadId:f.id,kind:'fact',line:`不相关的历史 ${i}`})
 const initial=await topicsProjection(f.db,'owner',undefined,seen)
 const offsets={entries:0,matters:0,messages:0},limits={entries:1,matters:3,messages:1}
 await topicDetailPage(f.db,'owner',f.id,offsets,limits,seen,initial)
 const query=vi.spyOn(f.db,'query')
 for(let i=0;i<6;i++){
   const next=await topicsProjection(f.db,'owner',undefined,seen)
   expect(next.all).toBe(initial.all);expect(next.activities).toBe(initial.activities)
   const page=await topicDetailPage(f.db,'owner',f.id,{...offsets,matters:i*3},limits,seen,next)
   expect(page!.matters).toHaveLength(3)
 }
 expect(query.mock.calls.filter(([sql])=>/FROM matters m|WITH RECURSIVE valid_entry|FROM matter_topics l/.test(sql))).toHaveLength(0)
 expect(query.mock.calls.filter(([sql])=>/FROM topic_entries/.test(sql)).every(([sql])=>/COUNT|LIMIT/.test(sql))).toBe(true)
})

it('expires running activity without a write and invalidates cached association on privacy, provenance and cwd changes',async()=>{
 const f=await fixture(),m=f.terminal('cached-changes'),seen=()=>null
 let clock=Date.now();vi.spyOn(Date,'now').mockImplementation(()=>clock)
 const read=()=>projectActivities(f.db,'owner',seen,f.identify)
 expect((await read()).get(f.id)!.activity.running).toBe(1)
 clock+=CLI_SESSION_STALE_MS+1
 expect((await read()).get(f.id)!.activity.running).toBe(0)
 await f.threads.update(f.id,{private:true});expect(await read()).toEqual(new Map())
 await f.threads.update(f.id,{private:false});expect((await read()).get(f.id)!.sessions[0]!.id).toBe(m.id)
 vi.restoreAllMocks()
})


it.each(['stop','session_end'] as const)('old unseen terminal %s results stay idle after thirty minutes',async(kind)=>{
 const f=await fixture();f.terminal('old-result',CLI_SESSION_STALE_MS+1000)
 f.turns.event({session_id:'old-result',source:'claude',cwd:root,kind},f.now()-CLI_SESSION_STALE_MS-1000)
 expect((await projectActivities(f.db,'owner',()=>null,f.identify)).get(f.id)!.sessions[0]!.activity).toBe('idle')
})

it('a terminal moved across repositories cannot backfill new output into its original repository',async()=>{
 const f=await fixture(),m=f.terminal('new-output')
 await f.threads.update(f.id,{title:'改名项目'})
 f.turns.event({session_id:'new-output',source:'claude',cwd:root,kind:'stop'},f.now());f.tick()
 f.cli.touch({session_id:'new-output',source:'claude',cwd:'/projects/new'},f.now())
 f.turns.event({session_id:'new-output',source:'claude',cwd:'/projects/new',kind:'prompt'},f.now())
 await f.threads.addEntry({threadId:f.id,kind:'progress',line:'新仓库的产出',source:'work',matterId:m.id})
 const identify=async(path:string)=>path==='/projects/new'?{key:'/projects/new/.git',roots:['/projects/new'],names:['new']}:identity
 const resolve=makeProjectTopicResolver(f.db,'owner',[{id:f.id,title:'改名项目',aliases:[],tags:[],summary:'',lastActive:'',entries:[]}],identify)
 expect((await resolve(root)).topicId).toBeNull()
})

it('a not-yet-registered session cannot claim the name of a known independent repository',async()=>{
 const f=await fixture();f.terminal('known-name')
 const identify=async(path:string)=>path===root?identity:{key:'/other/bx/.git',roots:['/other/bx'],names:['bx']}
 const resolve=makeProjectTopicResolver(f.db,'owner',[{id:f.id,title:'bx',aliases:[],tags:[],summary:'',lastActive:'',entries:[]}],identify)
 expect((await resolve('/other/bx')).topicId).toBeNull()
})

it('a nonresponding identity path is bounded independently of healthy projects',async()=>{
 const f=await fixture();f.terminal('healthy-timeout')
 f.turns.event({session_id:'unresponsive',source:'claude',cwd:'/unresponsive',kind:'prompt'},f.now())
 const identify=async(path:string)=>path==='/unresponsive'?new Promise<never>(()=>{}):identity
 const start=performance.now()
 const value=await projectActivities(f.db,'owner',()=>null,identify)
 expect(value.get(f.id)!.sessions).toHaveLength(1)
 expect(performance.now()-start).toBeLessThan(2000)
},3000)


it('one step and repeated pages avoid scanning 1500 unrelated linked historical matters',async()=>{
 const f=await fixture(),m=f.terminal('live-linked'),seen=()=>null
 await f.threads.addEntry({threadId:f.id,kind:'progress',line:'来源',source:'work',matterId:m.id})
 const history=await f.threads.create({chatId:'owner',title:'历史项目',private:false,summary:'',facets:[],tags:[],episodes:[]})
 f.db.transaction(()=>{
  const link=f.db.query('INSERT INTO matter_topics(matter_id,thread_id,attached_ts) VALUES(?,?,?)')
  link.run(m.id,f.id,'2026-11-09')
  for(let i=0;i<1500;i++){
   const old=f.matters.create({kind:'task',title:'已归档的历史',projectPath:'/projects/archive',ownerChatId:'owner'})
   f.db.query('UPDATE matters SET archived_at=1 WHERE id=?').run(old.id)
   link.run(old.id,history,'2026-11-09')
  }
 })()
 const coldStart=performance.now(),initial=await topicsProjection(f.db,'owner',undefined,seen),coldMs=performance.now()-coldStart
 expect(initial.all.find(t=>t.id===history)!.matterSummary.total).toBe(1500)
 f.tick();f.log.writeItem({matterId:m.id,kind:'tool_call',status:'completed',payload:{tool:'Read'}})
 const query=vi.spyOn(f.db,'query'),stepStart=performance.now(),updated=await topicsProjection(f.db,'owner',undefined,seen),stepMs=performance.now()-stepStart
 const stepQueries=query.mock.calls.length
 expect(query.mock.calls.filter(([sql])=>/FROM matter_topics l/.test(sql)).every(([sql])=>/m.id IN/.test(sql))).toBe(true)
 expect(query.mock.calls.filter(([sql])=>/WITH RECURSIVE valid_entry/.test(sql))).toHaveLength(0)
 expect(updated.all.find(t=>t.id===history)!.matterSummary.total).toBe(1500)
 query.mockClear();const warmStart=performance.now()
 for(let i=0;i<10;i++){
  const snapshot=await topicsProjection(f.db,'owner',undefined,seen)
  expect(snapshot.all).toBe(updated.all)
  await topicDetailPage(f.db,'owner',f.id,{entries:0,matters:0,messages:0},{entries:1,matters:1,messages:1},seen,snapshot)
 }
 const warmMs=performance.now()-warmStart,warmQueries=query.mock.calls.length
 expect(query.mock.calls.filter(([sql])=>/FROM matters m|WITH RECURSIVE valid_entry|FROM matter_topics l/.test(sql))).toHaveLength(0)
 process.stdout.write('TOPICS_REVIEW_MEASURE '+JSON.stringify({historicalLinks:1500,coldMs,stepMs,stepQueries,warmTenPagesMs:warmMs,warmQueries})+'\n')
})
