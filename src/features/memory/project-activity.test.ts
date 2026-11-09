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
import { topicsProjection } from './topic-projection'
import { makeTopicBubbles } from '../../lib/topic-bubbles'
import { makeProjectTopicResolver } from '../terminal/project-memory'
import { resolveTopicRecall } from '../../daemon/threads/recall'
import { makePhoneEventsWiring } from '../phone/phone-topic-sources'
import { matterFeed } from '../../adapters/store/matter-feed'
import { hintWrite, onWriteHint } from '../../lib/write-hints'

const dbs: Db[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close() })
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
  return { db,threads,matters,log,id,turns,terminal,identify,now,tick:() => {at++} }
}
describe('project activity from existing session and task facts', () => {
  it('terminal permissions retain the requested tool/summary; stale terminal turns do not count as live', async () => {
    const f = await fixture(), fresh = f.terminal('fresh'), old = f.terminal('old',CLI_SESSION_STALE_MS+1000)
    f.turns.permissionAsked({session_id:'fresh',source:'claude',cwd:root,tool_name:'Bash',summary:'检查迁移'},f.now())
    f.turns.permissionAsked({session_id:'old',source:'claude',cwd:root,tool_name:'Bash',summary:'过期请求'},f.now()-CLI_SESSION_STALE_MS-1000)
    const value = (await projectActivities(f.db,'owner',()=>null,f.identify)).get(f.id)!
    expect(value.activity).toMatchObject({waiting:1,running:0,unread:0})
    expect(value.sessions.find(s=>s.id===fresh.id)).toMatchObject({activity:'waiting',latestStep:expect.stringContaining('Bash')})
    expect(value.sessions.find(s=>s.id===fresh.id)!.latestStep).toContain('检查迁移')
    expect(value.sessions.find(s=>s.id===old.id)).toMatchObject({activity:'idle'})
  })
  it('task pending/runtime phase comes from the narrow source and nested tool labels show the actual latest step', async () => {
    const f = await fixture(), task = f.matters.create({kind:'task',title:'检查项目',projectPath:root,ownerChatId:'owner'})
    const turn = f.log.startTurn({matterId:task.id,executor:'codex'})
    f.log.writeItem({matterId:task.id,turnId:turn.id,kind:'tool_call',status:'started',payload:{text:'完整审计不进入活动',activity:{label:'核验迁移',output:'秘密正文'}}})
    let fact = {phase:'working',requestId:'permission-id' as string|null,waitingFor:'Bash: 运行本地检查' as string|null}
    const source = vi.fn(() => fact)
    const read = async () => (await projectActivities(f.db,'owner',()=>null,f.identify,source)).get(f.id)!
    expect((await read()).sessions[0]).toMatchObject({activity:'waiting',requestId:'permission-id',latestStep:expect.stringContaining('运行本地检查')})
    fact = {phase:'working',requestId:null,waitingFor:null}
    expect((await read()).sessions[0]).toMatchObject({activity:'running',latestStep:'核验迁移'})
    f.log.writeItem({matterId:task.id,turnId:turn.id,kind:'agent_message',status:'completed',payload:{text:'这段正文不能进入话题活动'}})
    fact = {phase:'replied',requestId:null,waitingFor:null}
    expect((await read()).activity.waiting).toBe(1)
    expect(JSON.stringify(await read())).not.toContain('秘密正文')
    expect(JSON.stringify(await read())).not.toContain('这段正文不能进入')
  })
  it('desktop and phone seen clear only the completed response; an open permission remains waiting', async () => {
    const f = await fixture(), terminal = f.terminal('done'), desktop = makeDesktopSurface(f.now), seen = makeMatterSeen(f.db,desktop)
    f.turns.event({session_id:'done',source:'claude',cwd:root,kind:'stop',text:'不把答复正文带进话题'},f.now())
    expect((await projectActivities(f.db,'owner',seen,f.identify)).get(f.id)!.activity.waiting).toBe(1)
    f.tick();desktop.noteSeen(terminal.id)
    expect((await projectActivities(f.db,'owner',seen,f.identify)).get(f.id)!.activity.waiting).toBe(0)
    const bubbles=makeTopicBubbles(f.db);bubbles.adopt('owner','open','owner',[{id:f.id}]);const sleep=bubbles.beginSleep('owner','sleep')
    const activity=await projectActivities(f.db,'owner',seen,f.identify)
    expect(bubbles.closeAfterSleep(sleep,new Set([...activity].filter(([,v])=>v.activity.waiting||v.activity.running).map(([id])=>id)))).toBe(1)
    f.tick();f.turns.permissionAsked({session_id:'done',source:'claude',cwd:root,tool_name:'Read',summary:'读配置'},f.now())
    desktop.noteSeen(terminal.id);f.matters.bind(terminal.id,'phone','pwa')
    expect((await projectActivities(f.db,'owner',seen,f.identify)).get(f.id)!.activity.waiting).toBe(1)
    f.tick();f.turns.event({session_id:'done',source:'claude',cwd:root,kind:'session_end'},f.now())
    expect((await projectActivities(f.db,'owner',seen,f.identify)).get(f.id)!.activity.unread).toBe(1)
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
    const f=await fixture(), m=f.terminal('push'), desktop=makeDesktopSurface(f.now),seen=makeMatterSeen(f.db,desktop)
    const wiring=makePhoneEventsWiring({home:async()=>({}) as never,changes:matterFeed(f.db),hints:cb=>onWriteHint(f.db,cb),pollMs:60_000,
      topics:async()=>Object.fromEntries(await projectActivities(f.db,'owner',seen,f.identify))})
    const frames:any[]=[];const off=wiring.events.subscribe('topics',undefined,frame=>frames.push(frame.data))
    try {
      await expect.poll(()=>frames.length).toBe(1)
      expect(frames[0][f.id].activity.running).toBe(1)
      f.tick();f.turns.event({session_id:'push',source:'claude',cwd:root,kind:'stop',text:'完整答复不入活动'},f.now())
      await expect.poll(()=>frames.length).toBe(2)
      expect(frames[1][f.id].activity.waiting).toBe(1)
      f.tick();desktop.noteSeen(m.id);hintWrite(f.db,{kind:'matter',matterId:m.id})
      await expect.poll(()=>frames.length).toBe(3)
      expect(frames[2][f.id].activity.waiting).toBe(0)
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
 expect(value.sessions.find(s=>s.id===m.id)?.latestStep).toContain('bun test')
 expect(JSON.stringify(value)).not.toContain('PRIVATE_ASSISTANT_BODY')
})
