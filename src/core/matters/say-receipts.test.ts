import {randomUUID} from 'node:crypto'
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {openDb,type Db} from '../../lib/db'
import {makeMatterStore,type MatterStore} from './store'
import {makeMattersService} from './service'
import {makeSayReceipts,SAY_RECEIPT_TTL_MS,sayTextHash} from './say-receipts'

/**
 * 对主人微信聊天那件事「说一句」按 requestId 去重(v70)——与工作台输入回执同一规矩:
 * 同 id 同文的重发拿原来的结果、不说第二遍;同 id 异文 ⇒ input_conflict;失败不留回执(重发 = 重试)。
 */
let db:Db,store:MatterStore,clock=1_000
beforeEach(()=>{db=openDb({path:':memory:'});clock=1_000;store=makeMatterStore(db,()=>clock)})
afterEach(()=>db.close())

const gated=()=>{
  const waiters:Array<{resolve:(r:{reply:string})=>void;reject:(e:Error)=>void}>=[]
  const say=vi.fn((_text:string,_surface?:'desktop'|'phone')=>new Promise<{reply:string}>((resolve,reject)=>{waiters.push({resolve,reject})}))
  return {say,waiters}
}
const serviceWith=(say:(text:string,surface?:'desktop'|'phone')=>Promise<{reply:string}>)=>
  makeMattersService({store,chat:{ownerChatId:()=>'owner',say},sayReceipts:makeSayReceipts(db,()=>clock)})

describe('chat matter say receipts',()=>{
  it('a repeat after the reply returns the original reply and never speaks twice',async()=>{
    const m=store.ensureChat('owner'),say=vi.fn(async()=>({reply:'在呢'})),service=serviceWith(say),requestId=randomUUID()
    await expect(service.say(m.id,'在吗','phone',{requestId})).resolves.toEqual({kind:'chat',reply:'在呢'})
    await expect(service.say(m.id,'在吗','phone',{requestId:requestId.toUpperCase()})).resolves.toEqual({kind:'chat',reply:'在呢'})
    expect(say).toHaveBeenCalledTimes(1)
    // 换一个 requestId 才是新的一句
    await service.say(m.id,'在吗','phone',{requestId:randomUUID()})
    expect(say).toHaveBeenCalledTimes(2)
  })

  it('a repeat while the turn is still running joins it instead of starting a second one',async()=>{
    const m=store.ensureChat('owner'),{say,waiters}=gated(),service=serviceWith(say),requestId=randomUUID()
    const first=service.say(m.id,'在吗','phone',{requestId}),second=service.say(m.id,'在吗','phone',{requestId})
    await vi.waitFor(()=>expect(waiters).toHaveLength(1))
    expect(say).toHaveBeenCalledTimes(1)
    waiters[0]!.resolve({reply:'在呢'})
    await expect(first).resolves.toEqual({kind:'chat',reply:'在呢'})
    await expect(second).resolves.toEqual({kind:'chat',reply:'在呢'})
    expect(makeSayReceipts(db).get(requestId)).toMatchObject({status:'replied',reply:'在呢',matterId:m.id,textHash:sayTextHash('在吗')})
  })

  it('the same requestId with a different body is input_conflict (like the workbench input receipt), and nothing is spoken',async()=>{
    const m=store.ensureChat('owner'),say=vi.fn(async()=>({reply:'在呢'})),service=serviceWith(say),requestId=randomUUID()
    await service.say(m.id,'在吗','phone',{requestId})
    await expect(service.say(m.id,'换了一句','phone',{requestId})).rejects.toThrow('input_conflict')
    expect(say).toHaveBeenCalledTimes(1)
    await expect(service.say(m.id,'在吗','phone',{requestId:'not-a-uuid'})).rejects.toThrow('invalid_request')
  })

  it('a failed turn leaves no receipt: the retry with the same requestId really retries',async()=>{
    const m=store.ensureChat('owner'),requestId=randomUUID()
    const say=vi.fn().mockRejectedValueOnce(new Error('reply_sink_busy')).mockResolvedValueOnce({reply:'好了'})
    const service=serviceWith(say)
    await expect(service.say(m.id,'在吗','phone',{requestId})).rejects.toThrow('reply_sink_busy')
    expect(makeSayReceipts(db).get(requestId)).toBeNull()
    await expect(service.say(m.id,'在吗','phone',{requestId})).resolves.toEqual({kind:'chat',reply:'好了'})
    expect(say).toHaveBeenCalledTimes(2)
  })

  it('receipts survive a daemon restart: replied ⇒ original reply; cut off mid-turn ⇒ accepted, not spoken again',async()=>{
    const m=store.ensureChat('owner'),done=randomUUID(),cut=randomUUID()
    await serviceWith(async()=>({reply:'在呢'})).say(m.id,'在吗','phone',{requestId:done})
    const before=gated();void serviceWith(before.say).say(m.id,'还在吗','phone',{requestId:cut}).catch(()=>{})
    await vi.waitFor(()=>expect(before.waiters).toHaveLength(1))
    // 重启:新的 service 实例(内存里的在飞表清空),同一个库
    const say=vi.fn(async()=>({reply:'第二遍'})),restarted=serviceWith(say)
    await expect(restarted.say(m.id,'在吗','phone',{requestId:done})).resolves.toEqual({kind:'chat',reply:'在呢'})
    await expect(restarted.say(m.id,'还在吗','phone',{requestId:cut})).resolves.toEqual({kind:'chat',reply:''})
    await expect(restarted.say(m.id,'别的','phone',{requestId:cut})).rejects.toThrow('input_conflict')
    expect(say).not.toHaveBeenCalled()
  })

  it('without a requestId (desktop / internal API) nothing is deduplicated — old behaviour',async()=>{
    const m=store.ensureChat('owner'),say=vi.fn(async()=>({reply:'在呢'})),service=serviceWith(say)
    await service.say(m.id,'在吗','desktop');await service.say(m.id,'在吗','desktop')
    expect(say).toHaveBeenCalledTimes(2)
    expect(db.query('SELECT COUNT(*) AS n FROM matter_say_receipts').get()).toEqual({n:0})
  })

  it('expires receipts after the TTL (swept on the next reservation)',()=>{
    const receipts=makeSayReceipts(db,()=>clock),old=randomUUID()
    expect(receipts.reserve({requestId:old,matterId:'deadbeef',textHash:sayTextHash('a')}).fresh).toBe(true)
    expect(receipts.reserve({requestId:old,matterId:'deadbeef',textHash:sayTextHash('b')})).toMatchObject({fresh:false,receipt:{textHash:sayTextHash('a')}})
    clock+=SAY_RECEIPT_TTL_MS+1
    receipts.reserve({requestId:randomUUID(),matterId:'deadbeef',textHash:sayTextHash('c')})
    expect(receipts.get(old)).toBeNull()
  })
})
