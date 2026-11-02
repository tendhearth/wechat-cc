import {afterEach,beforeEach,describe,expect,it} from 'vitest'
import {openDb,type Db} from '../../lib/db'
import {makeMatterStore} from './matters-store'
import {makeMatterLog} from './matter-log'
import type {MatterLog,MatterStore} from '../../ports/matters'

/**
 * MatterLog —— 一件事的轮与步只经这一个口写(设计稿 2026-10-31 §3.1、M1)。这里钉它的不变式:
 * seq 每件事单调、cursor 全库单调、同一把 item_key 合成一行且做完的不倒回、轮结束不留转圈的步、
 * 统一状态由轮与「等你」的步推出来。
 */
let db:Db,store:MatterStore,log:MatterLog,clock=1_000
beforeEach(()=>{
  db=openDb({path:':memory:'});clock=1_000
  store=makeMatterStore(db,()=>clock);log=makeMatterLog(db,()=>clock)
  store.create({id:'0000000a',kind:'task',title:'修登录'})
  store.create({id:'0000000b',kind:'chat',title:'聊天'})
})
afterEach(()=>db.close())
const state=(id:string)=>log.state(id)?.state

describe('轮',()=>{
  it('updateTurn:补实际模型 / 换掉策略摘要,游标前进,不碰状态;没给的不动;结束了的轮也能补',()=>{
    const t=log.startTurn({matterId:'0000000a',executor:'codex',model:null,policy:{choice:'auto'}})
    const u=log.updateTurn(t.id,{model:'gpt-5.5'})
    expect(u).toMatchObject({model:'gpt-5.5',policy:{choice:'auto'},status:'running'})
    expect(u.cursor).toBeGreaterThan(t.cursor)
    expect(state('0000000a')).toBe('working')
    log.finishTurn(t.id,{status:'completed'})
    expect(log.updateTurn(t.id,{policy:{choice:'auto',effective:'gpt-5.5'}})).toMatchObject({model:'gpt-5.5',policy:{choice:'auto',effective:'gpt-5.5'},status:'completed'})
    expect(state('0000000a')).toBe('open')
    expect(()=>log.updateTurn('nope',{model:'x'})).toThrow('turn_not_found')
  })
  it('开一轮 ⇒ 每件事从 1 数、带执行者与 run;这件事进 working、updated_at 跟着动',()=>{
    clock=2_000
    const t1=log.startTurn({matterId:'0000000a',executor:'codex',model:'gpt-5.5',runId:'run-1',policy:{mode:'review'}})
    expect(t1).toMatchObject({matterId:'0000000a',seq:1,runId:'run-1',executor:'codex',model:'gpt-5.5',nativeSessionId:null,status:'running',errorCode:null,usage:null,policy:{mode:'review'},startedAt:2_000,endedAt:null})
    expect(t1.id).toMatch(/^[a-f0-9]{16}$/)
    expect(state('0000000a')).toBe('working')
    expect(store.get('0000000a')!.updatedAt).toBe(2_000)
    const t2=log.startTurn({matterId:'0000000b',executor:'claude'})
    expect(t2.seq).toBe(1)
    expect(t2.cursor).toBeGreaterThan(t1.cursor)
  })
  it('一轮结束 ⇒ 记结局、用量、原生会话;没别的轮在跑就回 open;要说「做完 / 没做成」显式给',()=>{
    const t=log.startTurn({matterId:'0000000a',executor:'claude'})
    clock=5_000
    const done=log.finishTurn(t.id,{status:'completed',usage:{input:10,output:3},nativeSessionId:'sess-1'})
    expect(done).toMatchObject({status:'completed',usage:{input:10,output:3},nativeSessionId:'sess-1',endedAt:5_000})
    expect(done.cursor).toBeGreaterThan(t.cursor)
    expect(state('0000000a')).toBe('open')
    const t2=log.startTurn({matterId:'0000000a',executor:'claude'})
    expect(t2.seq).toBe(2)
    log.finishTurn(t2.id,{status:'failed',errorCode:'quota_exhausted',matterState:'failed'})
    expect(log.state('0000000a')).toEqual({state:'failed',archivedAt:null})
    expect(log.turns('0000000a').map(x=>[x.seq,x.status,x.errorCode])).toEqual([[1,'completed',null],[2,'failed','quota_exhausted']])
  })
  it('结束一轮是幂等的:重放不改结局、不动游标',()=>{
    const t=log.startTurn({matterId:'0000000a',executor:'claude'})
    const first=log.finishTurn(t.id,{status:'cancelled'})
    expect(log.finishTurn(t.id,{status:'completed',matterState:'done'})).toEqual(first)
    expect(state('0000000a')).toBe('open')
  })
  it('同一件事两轮同时跑:一轮结束,另一轮还在 ⇒ 仍是 working,matterState 也不生效',()=>{
    const a=log.startTurn({matterId:'0000000a',executor:'claude'})
    log.startTurn({matterId:'0000000a',executor:'codex'})
    log.finishTurn(a.id,{status:'completed',matterState:'done'})
    expect(state('0000000a')).toBe('working')
  })
  it('拒绝:没这件事、没这一轮、空执行者',()=>{
    expect(()=>log.startTurn({matterId:'ffffffff',executor:'claude'})).toThrow('matter_not_found')
    expect(()=>log.finishTurn('nope',{status:'completed'})).toThrow('turn_not_found')
    expect(()=>log.startTurn({matterId:'0000000a',executor:''})).toThrow('invalid_turn_executor')
  })
})

describe('步',()=>{
  it('新步 ⇒ seq 每件事单调、游标全库单调;正文在 messages 的只引 id',()=>{
    const t=log.startTurn({matterId:'0000000b',executor:'claude'})
    const said=log.writeItem({matterId:'0000000b',turnId:t.id,kind:'user_message',status:'completed',messageId:'msg-1'})
    const tool=log.writeItem({matterId:'0000000b',turnId:t.id,kind:'tool_call',status:'started',key:'call-1',payload:{label:'读 a.ts'}})
    expect(said).toMatchObject({seq:1,kind:'user_message',messageId:'msg-1',payload:{},key:null})
    expect(tool).toMatchObject({seq:2,status:'started',key:'call-1',payload:{label:'读 a.ts'}})
    expect(tool.cursor).toBeGreaterThan(said.cursor)
    const other=log.writeItem({matterId:'0000000a',kind:'system',status:'completed',payload:{text:'开始了'}})
    expect(other).toMatchObject({seq:1,turnId:null})
  })
  it('同一把 key ⇒ 合成一行:seq 不变、游标前进、payload 换新;做完的不会被迟到的 started 倒回去',()=>{
    const a=log.writeItem({matterId:'0000000a',kind:'tool_call',status:'started',key:'k',payload:{label:'跑测试'}})
    clock=3_000
    const b=log.writeItem({matterId:'0000000a',kind:'tool_call',status:'completed',key:'k',payload:{label:'跑测试',output:'ok'}})
    expect(b).toMatchObject({id:a.id,seq:a.seq,status:'completed',payload:{label:'跑测试',output:'ok'},createdAt:a.createdAt,updatedAt:3_000})
    expect(b.cursor).toBeGreaterThan(a.cursor)
    const late=log.writeItem({matterId:'0000000a',kind:'tool_call',status:'started',key:'k',payload:{label:'跑测试'}})
    expect(late).toEqual(b)
    expect(log.items('0000000a')).toHaveLength(1)
  })
  it('逐字流:appendText 接在已有的 text 后面,截在 40000 字',()=>{
    log.writeItem({matterId:'0000000a',kind:'agent_message',status:'started',key:'m1',appendText:'你好'})
    const b=log.writeItem({matterId:'0000000a',kind:'agent_message',status:'started',key:'m1',appendText:',主人'})
    expect(b.payload).toEqual({text:'你好,主人'})
    const big=log.writeItem({matterId:'0000000a',kind:'agent_message',status:'completed',key:'m1',appendText:'x'.repeat(50_000)})
    expect((big.payload.text as string).length).toBe(40_000)
  })
  it('按游标取变化:只回游标之后写过的(包括被更新的旧步)',()=>{
    const a=log.writeItem({matterId:'0000000a',kind:'tool_call',status:'started',key:'k'})
    const b=log.writeItem({matterId:'0000000a',kind:'system',status:'completed'})
    log.writeItem({matterId:'0000000a',kind:'tool_call',status:'completed',key:'k'})
    expect(log.items('0000000a',{afterCursor:b.cursor}).map(i=>i.id)).toEqual([a.id])
    expect(log.items('0000000a').map(i=>i.seq)).toEqual([1,2])
  })
  it('按 key 取一步;没有 ⇒ null(同一把 key 在别的事里不算)',()=>{
    const a=log.writeItem({matterId:'0000000a',kind:'tool_call',status:'started',key:'k',payload:{label:'x'}})
    expect(log.item('0000000a','k')).toEqual(a)
    expect(log.item('0000000b','k')).toBeNull()
    expect(log.item('0000000a','nope')).toBeNull()
  })
  it('拒绝:轮不属于这件事、同一把 key 换了 kind、陌生的 kind / status',()=>{
    const t=log.startTurn({matterId:'0000000a',executor:'claude'})
    expect(()=>log.writeItem({matterId:'0000000b',turnId:t.id,kind:'system',status:'completed'})).toThrow('turn_not_in_matter')
    log.writeItem({matterId:'0000000a',kind:'tool_call',status:'started',key:'k'})
    expect(()=>log.writeItem({matterId:'0000000a',kind:'error',status:'completed',key:'k'})).toThrow('item_kind_mismatch')
    expect(()=>log.writeItem({matterId:'0000000a',kind:'reasoning' as never,status:'completed'})).toThrow('invalid_item_kind')
    expect(()=>log.writeItem({matterId:'0000000a',kind:'system',status:'running' as never})).toThrow('invalid_item_status')
    expect(()=>log.writeItem({matterId:'ffffffff',kind:'system',status:'completed'})).toThrow('matter_not_found')
  })
})

describe('统一状态从轮与「等你」的步推出来',()=>{
  it('权限卡 / 提问开着 ⇒ waiting;了结 ⇒ 回 working;轮结束 ⇒ open',()=>{
    const t=log.startTurn({matterId:'0000000a',executor:'claude'})
    log.writeItem({matterId:'0000000a',turnId:t.id,kind:'permission',status:'started',key:'p1',payload:{tool:'Bash'}})
    expect(state('0000000a')).toBe('waiting')
    log.writeItem({matterId:'0000000a',turnId:t.id,kind:'question',status:'started',key:'q1'})
    log.writeItem({matterId:'0000000a',turnId:t.id,kind:'permission',status:'completed',key:'p1'})
    expect(state('0000000a')).toBe('waiting')
    log.writeItem({matterId:'0000000a',turnId:t.id,kind:'question',status:'completed',key:'q1'})
    expect(state('0000000a')).toBe('working')
    log.finishTurn(t.id,{status:'completed'})
    expect(state('0000000a')).toBe('open')
  })
  it('轮结束时还开着的步一律记失败:不留转圈的工具、不留永远等你的卡',()=>{
    const t=log.startTurn({matterId:'0000000a',executor:'claude'})
    log.writeItem({matterId:'0000000a',turnId:t.id,kind:'tool_call',status:'started',key:'c1'})
    log.writeItem({matterId:'0000000a',turnId:t.id,kind:'permission',status:'started',key:'p1'})
    log.writeItem({matterId:'0000000a',turnId:t.id,kind:'tool_call',status:'completed',key:'c2'})
    const before=Math.max(...log.items('0000000a').map(i=>i.cursor))
    log.finishTurn(t.id,{status:'cancelled',matterState:'cancelled'})
    const items=log.items('0000000a')
    expect(items.map(i=>[i.key,i.status])).toEqual([['c1','failed'],['p1','failed'],['c2','completed']])
    expect(items.filter(i=>i.key!=='c2').every(i=>i.cursor>before)).toBe(true)
    expect(state('0000000a')).toBe('cancelled')
  })
  it('轮结束后迟到的 started(卡 / 提问 / 工具)记成 failed:不把这件事拉回「等你」(Codex 评审 P2)',()=>{
    const t=log.startTurn({matterId:'0000000a',executor:'claude'})
    log.finishTurn(t.id,{status:'completed'})
    const late=log.writeItem({matterId:'0000000a',turnId:t.id,kind:'permission',status:'started',key:'p-late'})
    expect(late.status).toBe('failed')
    expect(state('0000000a')).toBe('open')
    expect(log.writeItem({matterId:'0000000a',turnId:t.id,kind:'tool_call',status:'completed',key:'c-late'}).status).toBe('completed')
  })
  it('普通的步不动状态:还没有轮记录的 working(工作台在 M2b 之前)写一步也还是 working(Codex 评审 P2)',()=>{
    db.query("UPDATE matters SET state='working' WHERE id='0000000a'").run()
    log.writeItem({matterId:'0000000a',kind:'tool_call',status:'started',key:'c'})
    log.writeItem({matterId:'0000000a',kind:'agent_message',status:'completed'})
    expect(state('0000000a')).toBe('working')
    log.writeItem({matterId:'0000000a',kind:'question',status:'started',key:'q'})
    expect(state('0000000a')).toBe('waiting')
    log.writeItem({matterId:'0000000a',kind:'question',status:'completed',key:'q'})
    expect(state('0000000a')).toBe('working')
  })
  it('显式结局:还有轮在跑时不许直接判;做完的事再开一轮就回到 working',()=>{
    const t=log.startTurn({matterId:'0000000a',executor:'claude'})
    expect(()=>log.setState('0000000a','done')).toThrow('matter_has_running_turn')
    log.finishTurn(t.id,{status:'completed'})
    log.setState('0000000a','done')
    expect(state('0000000a')).toBe('done')
    log.startTurn({matterId:'0000000a',executor:'claude'})
    expect(state('0000000a')).toBe('working')
    expect(()=>log.setState('0000000a','working' as never)).toThrow('invalid_matter_state')
  })
  it('归档和状态正交:归档的事照样能开轮,归档时间不动',()=>{
    clock=7_000;store.setStatus('0000000a','archived')
    log.startTurn({matterId:'0000000a',executor:'claude'})
    expect(log.state('0000000a')).toEqual({state:'working',archivedAt:7_000})
    expect(log.state('ffffffff')).toBeNull()
  })
})

describe('一个口写全:任何一步失败,整次写都不留半截',()=>{
  it('同一把 key 换 kind 被拒 ⇒ 游标没被吃掉、updated_at 没动',()=>{
    log.writeItem({matterId:'0000000a',kind:'tool_call',status:'started',key:'k'})
    const cursor=(db.query('SELECT value FROM matter_log_cursor').get() as {value:number}).value
    clock=9_000
    expect(()=>log.writeItem({matterId:'0000000a',kind:'error',status:'completed',key:'k'})).toThrow()
    expect((db.query('SELECT value FROM matter_log_cursor').get() as {value:number}).value).toBe(cursor)
    expect(store.get('0000000a')!.updatedAt).toBe(1_000)
  })
})
