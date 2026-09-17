import {afterEach,beforeEach,describe,expect,it} from 'vitest'
import {openDb,type Db} from '../../lib/db'
import {makeMatterStore,type MatterStore} from './store'

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
    expect(m).toEqual({id:'deadbeef',kind:'task',title:'整理周报',projectPath:'/work',status:'open',ownerChatId:'owner',createdAt:1_000,updatedAt:1_000})
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
})
