import {afterEach,beforeEach,describe,expect,it} from 'vitest'
import {migrations,openDb,runMigrations,type Db} from '../../lib/db'
import {openSqlite} from '../../lib/runtime/sqlite'
import { makeMatterStore } from './matters-store'
import { makeMatterLog } from './matter-log'
import type { MatterStore } from '../../ports/matters'

/**
 * matter(事)= 主人心里的"一件事":跨表面(微信 / 桌面 / 手机 / 终端)、跨供应商会话都是它。
 * 设计见 docs/cc-workbench.md「一件事」一节(2026-09-16)。这里钉 store 的最小面。
 */
let db:Db,store:MatterStore,clock=1_000
beforeEach(()=>{db=openDb({path:':memory:'});clock=1_000;store=makeMatterStore(db,()=>clock)})
afterEach(()=>db.close())

describe('matters',()=>{
  it('creates a task matter with the task id and reads it back',()=>{
    const m=store.create({id:'deadbeef',kind:'task',title:'整理周报',projectPath:'/work',ownerChatId:'owner'})
    expect(m).toEqual({id:'deadbeef',kind:'task',title:'整理周报',projectPath:'/work',status:'open',state:'open',archivedAt:null,ownerChatId:'owner',originMatterId:null,originMessageId:null,createdAt:1_000,updatedAt:1_000})
    expect(store.get('deadbeef')).toEqual(m)
    expect(store.get('nope')).toBeNull()
  })

  it('mints an 8-hex id when none is given',()=>{
    const m=store.create({kind:'chat',title:'闲聊'})
    expect(m.id).toMatch(/^[a-f0-9]{8}$/)
    expect(m.projectPath).toBeNull();expect(m.ownerChatId).toBeNull()
  })

  it('ensureChat is idempotent per chat and binds the wechat surface',()=>{
    const a=store.ensureChat('chat-1')
    clock=2_000
    const b=store.ensureChat('chat-1')
    expect(b.id).toBe(a.id);expect(b.kind).toBe('chat')
    expect(store.bindings(a.id)).toEqual([{matterId:a.id,surface:'wechat',surfaceKey:'chat-1',lastSeenAt:2_000}])
    expect(store.findBySurface('wechat','chat-1')?.id).toBe(a.id)
    expect(store.ensureChat('chat-2').id).not.toBe(a.id)
  })

  it('findChat is the read-only half of ensureChat: no matter created, no last_seen bump, tasks bound to the chat ignored',()=>{
    expect(store.findChat('chat-1')).toBeNull()
    expect(store.list()).toEqual([])
    const t=store.create({id:'cafecafe',kind:'task',title:'t'});store.bind(t.id,'wechat','chat-1')
    expect(store.findChat('chat-1')).toBeNull()
    const a=store.ensureChat('chat-1');clock=9_000
    expect(store.findChat('chat-1')?.id).toBe(a.id)
    expect(store.bindings(a.id)).toEqual([{matterId:a.id,surface:'wechat',surfaceKey:'chat-1',lastSeenAt:1_000}])
  })

  it('binds several surfaces to one matter and refreshes last_seen',()=>{
    const m=store.create({id:'aaaaaaaa',kind:'task',title:'t'})
    store.bind(m.id,'wechat','chat-1');clock=5;store.bind(m.id,'desktop','app-1');clock=9;store.bind(m.id,'wechat','chat-1')
    expect(store.bindings(m.id).map(b=>[b.surface,b.surfaceKey,b.lastSeenAt])).toEqual([['wechat','chat-1',9],['desktop','app-1',5]])
  })

  it('records executor sessions with roles, once each',()=>{
    const m=store.create({id:'bbbbbbbb',kind:'task',title:'t'})
    store.addSession(m.id,'codex','sess-1','main');store.addSession(m.id,'codex','sess-1','main');clock=7_000;store.addSession(m.id,'claude','sess-2','review')
    expect(store.sessions(m.id)).toEqual([
      {matterId:m.id,providerId:'codex',sessionId:'sess-1',role:'main',createdAt:1_000},
      {matterId:m.id,providerId:'claude',sessionId:'sess-2',role:'review',createdAt:7_000},
    ])
  })

  it('lists newest-updated first with kind / status / since filters and a limit',()=>{
    store.create({id:'00000001',kind:'task',title:'old'});clock=2_000
    const chat=store.ensureChat('c');clock=3_000
    const t=store.create({id:'00000003',kind:'task',title:'new'});clock=4_000
    store.setStatus('00000001','done')
    expect(store.list().map(m=>m.id)).toEqual(['00000001','00000003',chat.id])
    expect(store.list({kind:'task'}).map(m=>m.id)).toEqual(['00000001','00000003'])
    expect(store.list({statuses:['open','replied']}).map(m=>m.id)).toEqual(['00000003',chat.id])
    expect(store.list({since:2_500}).map(m=>m.id)).toEqual(['00000001','00000003'])
    expect(store.list({limit:1}).map(m=>m.id)).toEqual(['00000001'])
    store.bind(t.id,'desktop','app')
    expect(store.list({surface:'desktop'}).map(m=>m.id)).toEqual([t.id]);expect(store.list({surface:'wechat'}).map(m=>m.id)).toEqual([chat.id])
    expect(()=>store.list({surface:'fax' as never})).toThrow()
    expect(store.get(t.id)?.status).toBe('open')
  })

  it('rejects unknown kinds, statuses and surfaces at the boundary',()=>{
    expect(()=>store.create({kind:'x' as never,title:'t'})).toThrow()
    const m=store.create({id:'cccccccc',kind:'task',title:'t'})
    expect(()=>store.setStatus(m.id,'weird' as never)).toThrow()
    expect(()=>store.bind(m.id,'fax' as never,'k')).toThrow()
    expect(()=>store.bind('missing','wechat','k')).toThrow()
  })

  it('记住出生地:从哪次交流、哪条消息里被交办的',()=>{
    const chat=store.ensureChat('chat-1')
    const task=store.create({kind:'task',title:'改首页',originMatterId:chat.id,originMessageId:'msg-7'})
    expect(store.get(task.id)).toMatchObject({originMatterId:chat.id,originMessageId:'msg-7'})
    // 桌面上亲手派的没有出生地 —— 这正是「不回报」的判据,不需要额外开关。
    const handmade=store.create({kind:'task',title:'手动派的'})
    expect(store.get(handmade.id)).toMatchObject({originMatterId:null,originMessageId:null})
  })
  it('agents:任务自己的执行者在前,审阅交接与会话按新到旧跟在后面,同一家只算一次',()=>{
    const task=(id:string,provider:string)=>db.query('INSERT INTO workbench_tasks(id,title,path,provider_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id,'t','/w',provider,'completed',1,1)
    for(const [id,p] of [['aaaaaaaa','claude'],['bbbbbbbb','codex'],['cccccccc','cursor']] as const){task(id,p);store.create({id,kind:'task',title:'t'})}
    const handoff=(id:string,src:string,dst:string,at:number)=>db.query("INSERT INTO workbench_handoffs(id,source_task_id,target_task_id,purpose,request,packet_sha256,artifact_refs_json,created_at,packet_json,token_hash) VALUES(?,?,?,'review','r','x','[]',?,'{}',?)").run(id,src,dst,at,id)
    handoff('h1','aaaaaaaa','bbbbbbbb',10)
    handoff('h2','aaaaaaaa','cccccccc',20)
    store.addSession('aaaaaaaa','claude','s1','main')
    store.create({id:'dddddddd',kind:'chat',title:'聊天'})
    const got=store.agents(['aaaaaaaa','bbbbbbbb','dddddddd','not-an-id'])
    expect(got.get('aaaaaaaa')).toEqual(['claude','cursor','codex'])
    expect(got.get('bbbbbbbb')).toEqual(['codex','claude'])
    expect(got.has('dddddddd')).toBe(false)
    expect(store.agents([]).size).toBe(0)
  })
})

describe('matter origin (v77, 2026-10-19)',()=>{
  it('records where a matter was born once, at creation; unknown ⇒ no field at all',()=>{
    const m=store.create({id:'aaaaaaaa',kind:'task',title:'从手机来的',origin:'app'})
    expect(m.origin).toBe('app')
    expect(store.get('aaaaaaaa')?.origin).toBe('app')
    const old=store.create({id:'bbbbbbbb',kind:'task',title:'不知道'})
    expect(old).not.toHaveProperty('origin')
    expect(store.create({id:'cccccccc',kind:'task',title:'显式 null',origin:null})).not.toHaveProperty('origin')
    expect(store.list().find(x=>x.id==='aaaaaaaa')?.origin).toBe('app')
  })

  it('rejects values outside the six surfaces (strict at the store and at the column)',()=>{
    expect(()=>store.create({kind:'task',title:'x',origin:'phone' as never})).toThrow('invalid_matter_origin')
    expect(()=>db.query("INSERT INTO matters(id,kind,title,status,origin_surface,created_at,updated_at) VALUES('dddddddd','task','x','open','phone',1,1)").run()).toThrow()
  })

  it('never changes afterwards — status / rename / touch / bind keep it, and the column itself refuses any update (even NULL → value)',()=>{
    store.create({id:'aaaaaaaa',kind:'task',title:'微信',origin:'wechat'})
    store.setStatus('aaaaaaaa','done');store.rename('aaaaaaaa','改名');store.touch('aaaaaaaa');store.bind('aaaaaaaa','phone','pwa')
    expect(store.get('aaaaaaaa')?.origin).toBe('wechat')
    expect(()=>db.query("UPDATE matters SET origin_surface='desktop' WHERE id='aaaaaaaa'").run()).toThrow('matter_origin_immutable')
    store.create({id:'bbbbbbbb',kind:'task',title:'老的'})
    // 不回填:老行永远是 NULL
    expect(()=>db.query("UPDATE matters SET origin_surface='wechat' WHERE id='bbbbbbbb'").run()).toThrow('matter_origin_immutable')
    // 别的列照样能改
    db.query("UPDATE matters SET title='还能改标题' WHERE id='bbbbbbbb'").run()
    expect(store.get('bbbbbbbb')?.title).toBe('还能改标题')
  })

  it('ensureChat writes the origin only when it creates the row, never on a later sighting from another surface',()=>{
    const a=store.ensureChat('chat-1',undefined,'desktop')
    expect(a.origin).toBe('desktop')
    expect(store.ensureChat('chat-1',undefined,'wechat').origin).toBe('desktop')
    expect(store.ensureChat('chat-2')).not.toHaveProperty('origin')
    expect(store.ensureChat('chat-2',undefined,'app')).not.toHaveProperty('origin')
  })

  it('origins() answers one page at once, leaving unknown ids out; a hand-edited odd value reads as unknown',()=>{
    store.create({id:'aaaaaaaa',kind:'task',title:'a',origin:'cli'})
    store.create({id:'bbbbbbbb',kind:'task',title:'b'})
    const got=store.origins(['aaaaaaaa','bbbbbbbb','cccccccc','not-an-id'])
    expect([...got]).toEqual([['aaaaaaaa','cli']])
    expect(store.origins([]).size).toBe(0)
  })

  it('migrates an existing v76 database: old rows stay NULL (no backfill, no guessing)',()=>{
    const legacy=openSqlite(':memory:')
    try{
      legacy.exec('PRAGMA foreign_keys = ON;')
      // 跑到 v76 为止,塞一行老的事,再按正常开机的路径升级到最新
      for(let i=0;i<76;i++)migrations[i]!(legacy)
      legacy.exec('PRAGMA user_version = 76;')
      legacy.query("INSERT INTO matters(id,kind,title,status,owner_chat_id,created_at,updated_at) VALUES('eeeeeeee','task','老的事','open','owner',1,1)").run()
      runMigrations(legacy, migrations)
      expect((legacy.query('PRAGMA user_version').get() as {user_version:number}).user_version).toBe(migrations.length)
      const old=makeMatterStore(legacy).get('eeeeeeee')
      expect(old?.title).toBe('老的事')
      expect(old).not.toHaveProperty('origin')
      expect(legacy.query<{o:string|null},[]>("SELECT origin_surface AS o FROM matters WHERE id='eeeeeeee'").get()?.o).toBeNull()
      // 再跑一遍迁移也不碰它(幂等)
      migrations[76]!(legacy)
      expect(makeMatterStore(legacy).get('eeeeeeee')).not.toHaveProperty('origin')
    }finally{legacy.close()}
  })
})

describe('v92 的新列:发起方、统一状态、归档时间(读出口照旧不带)',()=>{
  const row=(id:string)=>db.query('SELECT kind,initiator,state,archived_at,status FROM matters WHERE id=?').get(id)
  it('四种 kind 与协议同一组;陌生的(包括从没建过的 companion)在边界拒掉',async()=>{
    const {MATTER_KINDS}=await import('@wechat-cc/protocol')
    MATTER_KINDS.forEach((kind,i)=>store.create({id:`0000000${i}`,kind,title:kind}))
    expect(()=>store.create({kind:'companion' as never,title:'x'})).toThrow('invalid_matter_kind')
  })
  it('发起方默认是主人;CC 自己做的事记 cc;陌生值拒掉',()=>{
    store.create({id:'0000000a',kind:'task',title:'t'})
    store.create({id:'0000000b',kind:'act',initiator:'cc',title:'写信'})
    expect(row('0000000a')).toMatchObject({initiator:'owner',state:'open',archived_at:null})
    expect(row('0000000b')).toMatchObject({kind:'act',initiator:'cc'})
    expect(()=>store.create({kind:'act',initiator:'stranger' as never,title:'x'})).toThrow('invalid_matter_initiator')
    expect(store.get('0000000b')).not.toHaveProperty('initiator')
  })
  it('旧 setStatus 顺手跟上归档时间与做完 / 重开;没做成不被「做完」盖掉',()=>{
    store.create({id:'0000000a',kind:'task',title:'t'})
    clock=2_000;store.setStatus('0000000a','archived')
    expect(row('0000000a')).toEqual({kind:'task',initiator:'owner',state:'open',archived_at:2_000,status:'archived'})
    clock=3_000;store.setStatus('0000000a','archived')
    expect(row('0000000a')).toMatchObject({archived_at:2_000})
    store.setStatus('0000000a','done')
    expect(row('0000000a')).toMatchObject({state:'done',archived_at:null})
    store.setStatus('0000000a','replied')
    expect(row('0000000a')).toMatchObject({state:'open'})
    db.query("UPDATE matters SET state='failed' WHERE id='0000000a'").run()
    store.setStatus('0000000a','done')
    expect(row('0000000a')).toMatchObject({state:'failed',status:'done'})
    db.query("UPDATE matters SET state='working' WHERE id='0000000a'").run()
    store.setStatus('0000000a','replied')
    expect(row('0000000a')).toMatchObject({state:'working'})
  })
})

describe('旧 status 现算(M6b):get 与列表筛选同一个式子',()=>{
  it('每一格:get 给的 status = legacyStatus;statuses 筛选(SQL 版本)挑出的正好是这些',async()=>{
    const {legacyStatus}=await import('../../domain/matters/legacy-status')
    const STATES=['open','working','waiting','done','failed','cancelled'] as const
    const TURNS=[null,'running','completed','failed','cancelled','interrupted'] as const
    const TASKS=[null,'queued','running','cancelling','completed','failed','cancelled','interrupted'] as const
    const want=new Map<string,{kind:string;status:string}>();let n=0,cursor=0
    for(const kind of ['chat','task','terminal','act'] as const)for(const state of STATES)for(const archived of [false,true])for(const turn of TURNS)for(const task of kind==='task'?TASKS:[null])for(const storedReplied of [false,true]){
      const id=(++n).toString(16).padStart(8,'0')
      db.query("INSERT INTO matters(id,kind,title,state,archived_at,status,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?)").run(id,kind,'t',state,archived?9:null,storedReplied?'replied':'open',n)
      if(turn){
        // 更早的一轮放相反的状态:只认 seq 最大的那一轮
        db.query("INSERT INTO matter_turns(id,matter_id,seq,executor,status,started_at,cursor) VALUES(?,?,1,'x',?,1,?)").run(id+'a',id,turn==='completed'?'failed':'completed',++cursor)
        db.query("INSERT INTO matter_turns(id,matter_id,seq,executor,status,started_at,cursor) VALUES(?,?,2,'x',?,1,?)").run(id+'b',id,turn,++cursor)
      }
      if(task)db.query("INSERT INTO workbench_tasks(id,title,path,provider_id,status,created_at,updated_at) VALUES(?,'t','/w','claude',?,1,1)").run(id,task)
      want.set(id,{kind,status:legacyStatus({kind,state,archivedAt:archived?9:null,latestTurn:turn,taskStatus:task,storedReplied})})
    }
    for(const [id,w] of want)expect([id,store.get(id)?.status]).toEqual([id,w.status])
    for(const kind of ['chat','task','terminal','act'] as const)for(const status of ['open','replied','done','archived'] as const){
      // 一页最多 500:翻过的那页把 updated_at 取负(since:0 就不再给它),直到翻完;只动排序用的时间,不碰算 status 的输入
      const got:string[]=[];let page:string[]
      do{page=store.list({kind,statuses:[status],limit:500,since:0}).filter(m=>!got.includes(m.id)).map(m=>m.id);got.push(...page);if(page.length)db.query(`UPDATE matters SET updated_at=-updated_at WHERE id IN (${page.map(()=>'?').join(',')})`).run(...page)}while(page.length)
      got.sort()
      const exp=[...want].filter(([,w])=>w.status===status&&w.kind===kind).map(([id])=>id).sort()
      expect([kind,status,got]).toEqual([kind,status,exp])
    }
    // 四种都出现过(这张格子没漏掉哪一种)
    expect(new Set([...want.values()].map(w=>w.status))).toEqual(new Set(['open','replied','done','archived']))
  })
  it('Codex P2:常驻会话交了结果、后台还在干 ⇒ 轮已收、state 回 open,但没安静下来(列没写 replied)⇒ 列表与 get 都是 open;安静下来写了 replied ⇒ replied',()=>{
    const log=makeMatterLog(db,()=>clock)
    const m=store.create({id:'0000beef',kind:'task',title:'t'})
    db.query("INSERT INTO workbench_tasks(id,title,path,provider_id,status,created_at,updated_at) VALUES(?,'t','/w','claude','running',1,1)").run(m.id)
    const turn=log.startTurn({matterId:m.id,executor:'claude'})
    log.finishTurn(turn.id,{status:'completed'})           // execute.ts noteTurn:result 到了,轮收了
    expect(log.state(m.id)?.state).toBe('open')
    expect(store.get(m.id)?.status).toBe('open')
    expect(store.list({statuses:['replied']})).toEqual([])
    expect(store.list({statuses:['open']}).map(x=>x.id)).toEqual([m.id])
    store.setStatus(m.id,'replied')                          // settleQuiet:运行时闲了、没后台、没待拍板
    expect(store.get(m.id)?.status).toBe('replied')
    expect(store.list({statuses:['replied']}).map(x=>x.id)).toEqual([m.id])
  })
  it('筛选不再看列:列写着 replied、算出来 open 的不进 replied;state / archivedAt 上线',()=>{
    const m=store.create({id:'0000abcd',kind:'task',title:'t'})
    db.query("UPDATE matters SET status='replied' WHERE id=?").run(m.id)
    expect(store.list({statuses:['replied']})).toEqual([])
    expect(store.get(m.id)).toMatchObject({status:'open',state:'open',archivedAt:null})
    clock=7_000;store.setStatus(m.id,'archived')
    expect(store.list({statuses:['archived']}).map(x=>[x.id,x.status,x.archivedAt])).toEqual([[m.id,'archived',7_000]])
    expect(store.list({statuses:['open','replied','done']})).toEqual([])
  })
})
