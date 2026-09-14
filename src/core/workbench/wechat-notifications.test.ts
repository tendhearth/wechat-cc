import {Database} from 'bun:sqlite'
import {afterEach,describe,expect,it,vi} from 'vitest'
import {initializeWechatNotificationSchema,makeWechatNotificationStore,makeWechatNotificationWorker,type WechatNotificationNotice} from './wechat-notifications'

const databases:Database[]=[]
function fixture(path=':memory:'){
  const db=new Database(path);databases.push(db)
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE workbench_tasks(id TEXT PRIMARY KEY NOT NULL) STRICT; INSERT INTO workbench_tasks(id) VALUES('task-1'),('task-2');")
  initializeWechatNotificationSchema(db)
  return {db,store:makeWechatNotificationStore(db)}
}
function input(overrides:Partial<Parameters<ReturnType<typeof makeWechatNotificationStore>['enqueue']>[0]>={}){
  return {taskId:'task-1',runId:'run-1',ownerChatId:'owner-1',accountId:'account-1',kind:'completed' as const,requestId:null,text:'完成',...overrides}
}
afterEach(()=>{for(const db of databases.splice(0))try{db.close()}catch{};vi.useRealTimers()})

describe('wechat notification store',()=>{
  it('deduplicates event identity without changing immutable content',()=>{
    const {store}=fixture();store.watch('task-1','owner-1','account-1',true);const first=store.enqueue(input())
    expect(store.enqueue(input())).toEqual(first)
    expect(()=>store.enqueue(input({text:'changed'}))).toThrow('notification_conflict')
    expect(store.list('task-1')).toEqual([first])
  })

  it('persists subscriptions and notices across SQLite reopen',()=>{
    const path=`/tmp/wechat-notifications-${crypto.randomUUID()}.sqlite`
    let {db,store}=fixture(path)
    store.watch('task-1','owner-1','account-1',true);const notice=store.enqueue(input())
    db.close();databases.splice(databases.indexOf(db),1)
    db=new Database(path);databases.push(db);store=makeWechatNotificationStore(db)
    expect(store.subscription('task-1')).toMatchObject({ownerChatId:'owner-1',accountId:'account-1',enabled:true})
    expect(store.list('task-1')).toEqual([notice])
    Bun.file(path).delete().catch(()=>{})
  })

  it('keeps the original owner while allowing an explicit account replacement',()=>{
    const {store}=fixture(),first=store.watch('task-1','owner-1','account-1',true)
    expect(first).toMatchObject({taskId:'task-1',ownerChatId:'owner-1',accountId:'account-1',enabled:true,generation:1})
    expect(store.watch('task-1','owner-1','account-1',true).generation).toBe(1)
    expect(store.watch('task-1','owner-1','account-1',false).enabled).toBe(false)
    expect(()=>store.watch('task-1','other','account-1',true)).toThrow('subscription_conflict')
    expect(store.watch('task-1','owner-1','other',true)).toMatchObject({ownerChatId:'owner-1',accountId:'other',enabled:true,generation:2})
  })

  it('claims pending work once and recovers abandoned sending as unknown',()=>{
    const {store}=fixture();store.watch('task-1','owner-1','account-1',true);const notice=store.enqueue(input())
    expect(store.claim(notice.id,10)?.status).toBe('sending')
    expect(store.claim(notice.id,11)).toBeNull()
    expect(store.recoverStaleSending(12)).toBe(1)
    expect(store.list('task-1')[0]).toMatchObject({status:'unknown',reason:'worker_restarted',updatedAt:12})
    expect(store.pending()).toEqual([])
  })

  it('durably suppresses pending notices when muted so reenable cannot revive old completion',async()=>{
    const {store}=fixture();expect(store.watch('task-1','owner-1','account-1',true).generation).toBe(1)
    const old=store.enqueue(input());expect(store.watch('task-1','owner-1','account-1',false).generation).toBe(1)
    expect(store.list('task-1').find(n=>n.id===old.id)?.status).toBe('suppressed')
    expect(store.watch('task-1','owner-1','account-1',true).generation).toBe(2)
    const sent:string[]=[];const worker=makeWechatNotificationWorker({store,eligible:n=>n.subscriptionGeneration===store.subscription(n.taskId)?.generation,send:async n=>{sent.push(n.id);return{status:'accepted'}}})
    await worker.wake();expect(sent).toEqual([]);expect(store.list('task-1').find(n=>n.id===old.id)?.status).toBe('suppressed');await worker.close()
  })

  it('creates a fresh identity for the same live request after reenable',()=>{
    const {store}=fixture();store.watch('task-1','owner-1','account-1',true);const old=store.enqueue(input({kind:'permission',requestId:'request-1'}))
    store.watch('task-1','owner-1','account-1',false);store.watch('task-1','owner-1','account-1',true)
    const fresh=store.enqueue(input({kind:'permission',requestId:'request-1'}))
    expect(fresh.id).not.toBe(old.id);expect(fresh.subscriptionGeneration).toBe(2);expect(old.subscriptionGeneration).toBe(1)
    expect(store.list('task-1').find(n=>n.id===old.id)?.status).toBe('suppressed');expect(store.list('task-1').find(n=>n.id===fresh.id)?.status).toBe('pending')
  })

  it('rejects enqueue bindings that do not match the current subscription',()=>{
    const {store}=fixture();store.watch('task-1','owner-1','account-1',true)
    expect(()=>store.enqueue(input({ownerChatId:'other'}))).toThrow('subscription_mismatch')
    expect(()=>store.enqueue(input({accountId:'other'}))).toThrow('subscription_mismatch')
    store.watch('task-1','owner-1','account-1',false);expect(()=>store.enqueue(input())).toThrow('subscription_inactive')
  })

  it('persists staged terminal intent across reopen and materializes its immutable notice',()=>{
    const path=`/tmp/wechat-notification-intent-${crypto.randomUUID()}.sqlite`;let {db,store}=fixture(path)
    store.watch('task-1','owner-1','account-1',true);const intent=store.stage(input())
    expect(store.list('task-1')).toEqual([]);db.close();databases.splice(databases.indexOf(db),1)
    db=new Database(path);databases.push(db);store=makeWechatNotificationStore(db)
    expect(store.materializeIntents()).toBe(1)
    expect(store.list('task-1')).toEqual([expect.objectContaining({id:intent.noticeId,text:'完成',subscriptionGeneration:1,status:'pending'})])
    Bun.file(path).delete().catch(()=>{})
  })

  it('keeps intent pending when notice insertion fails and retries without changing identity',()=>{
    const {db,store}=fixture();store.watch('task-1','owner-1','account-1',true);const intent=store.stage(input())
    db.exec("CREATE TRIGGER fail_notice BEFORE INSERT ON workbench_wechat_notices BEGIN SELECT RAISE(ABORT,'injected'); END;")
    expect(()=>store.materializeIntents()).toThrow('injected');expect(store.nextDue(100)).toBe(100)
    db.exec('DROP TRIGGER fail_notice');expect(store.materializeIntents()).toBe(1)
    expect(store.list('task-1')[0]?.id).toBe(intent.noticeId)
  })

  it('suppresses a staged intent from an old generation after reenable',()=>{
    const {store}=fixture();store.watch('task-1','owner-1','account-1',true);store.stage(input())
    store.watch('task-1','owner-1','account-1',false);store.watch('task-1','owner-1','account-1',true)
    expect(store.materializeIntents()).toBe(0);expect(store.list('task-1')).toEqual([]);expect(store.nextDue(100)).toBeNull()
  })
})

describe('wechat notification worker',()=>{
  function subscribed(){const f=fixture();f.store.watch('task-1','owner-1','account-1',true);return f}
  it('coalesces wakes and runs at most one send at a time without losing an in-flight wake',async()=>{
    const {store}=subscribed();store.enqueue(input());let active=0,max=0
    let release!:()=>void;const gate=new Promise<void>(r=>release=r)
    const sent:string[]=[]
    const worker=makeWechatNotificationWorker({store,eligible:()=>true,send:async notice=>{active++;max=Math.max(max,active);sent.push(notice.id);if(sent.length===1)await gate;active--;return{status:'accepted'}}})
    const first=worker.wake();await vi.waitFor(()=>expect(sent).toHaveLength(1))
    store.enqueue(input({runId:'run-2'}));const second=worker.wake();const third=worker.wake();release()
    await Promise.all([first,second,third])
    expect(sent).toHaveLength(2);expect(max).toBe(1)
    await worker.close()
  })

  it('drains more than one bounded batch from a single wake',async()=>{
    const {store}=subscribed();for(let i=0;i<7;i++)store.enqueue(input({runId:`run-${i}`}))
    const sent:string[]=[];let yields=0
    const worker=makeWechatNotificationWorker({store,batchSize:2,eligible:()=>true,send:async n=>{sent.push(n.runId);return{status:'accepted'}},yieldControl:async()=>{yields++}})
    await worker.wake();expect(sent).toHaveLength(7);expect(yields).toBe(3);expect(store.pending()).toEqual([]);await worker.close()
  })

  it('keeps deferred work pending with bounded backoff and does not spin',async()=>{
    vi.useFakeTimers();vi.setSystemTime(100)
    const {store}=subscribed(),notice=store.enqueue(input());let calls=0
    const worker=makeWechatNotificationWorker({store,eligible:()=>true,send:async()=>{calls++;return{status:'deferred',reason:'window_closed'}},deferBaseMs:1000,deferMaxMs:8000})
    await worker.wake();expect(calls).toBe(1);expect(store.list('task-1')[0]).toMatchObject({status:'pending',reason:'window_closed'})
    await worker.wake();expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(1000);await worker.wake();expect(calls).toBe(2)
    await vi.advanceTimersByTimeAsync(1000);expect(calls).toBe(2)
    await vi.advanceTimersByTimeAsync(1000);expect(calls).toBe(3)
    expect(store.list('task-1')[0]!.id).toBe(notice.id);await worker.close()
  })

  it('arms persisted deferred work after restart and a context wake releases its delay',async()=>{
    vi.useFakeTimers();vi.setSystemTime(100)
    const {store}=subscribed(),notice=store.enqueue(input());store.claim(notice.id,100);store.defer(notice.id,'closed',100,1000,8000)
    let calls=0
    const worker=makeWechatNotificationWorker({store,eligible:()=>true,send:async()=>{calls++;return{status:'accepted'}}})
    await vi.advanceTimersByTimeAsync(999);expect(calls).toBe(0)
    await worker.wake({contextAvailable:{ownerChatId:'owner-1',accountId:'account-1'}});expect(calls).toBe(1);await worker.close()
  })

  it('retries persisted deferred work when its timer expires without an incoming wake',async()=>{
    vi.useFakeTimers();vi.setSystemTime(100)
    const {store}=subscribed(),notice=store.enqueue(input());store.claim(notice.id,100);store.defer(notice.id,'closed',100,1000,8000)
    let calls=0;const worker=makeWechatNotificationWorker({store,eligible:()=>true,send:async()=>{calls++;return{status:'accepted'}}})
    await vi.advanceTimersByTimeAsync(999);expect(calls).toBe(0);await vi.advanceTimersByTimeAsync(1);expect(calls).toBe(1);await worker.close()
  })

  it('releases deferred work only for the exact context binding',async()=>{
    vi.useFakeTimers();vi.setSystemTime(100)
    const {store}=subscribed();store.watch('task-2','owner-2','account-2',true)
    const one=store.enqueue(input()),two=store.enqueue(input({taskId:'task-2',ownerChatId:'owner-2',accountId:'account-2'}))
    store.claim(one.id,100);store.defer(one.id,'closed',100,10_000,10_000);store.claim(two.id,100);store.defer(two.id,'closed',100,10_000,10_000)
    const sent:string[]=[];const worker=makeWechatNotificationWorker({store,eligible:()=>true,send:async n=>{sent.push(n.taskId);return{status:'accepted'}}})
    await worker.wake({contextAvailable:{ownerChatId:'owner-2',accountId:'account-2'}})
    expect(sent).toEqual(['task-2']);expect(store.list('task-1')[0]?.status).toBe('pending');await worker.close()
  })

  it('suppresses notices that are muted, rebound, or stale at eligibility time',async()=>{
    const {store}=subscribed()
    store.enqueue(input({runId:'muted'}));store.enqueue(input({runId:'rebound'}));store.enqueue(input({runId:'live',kind:'permission',requestId:'request-live'}));store.enqueue(input({runId:'stale',kind:'permission',requestId:'request-stale'}))
    const sent:string[]=[]
    const worker=makeWechatNotificationWorker({store,eligible:n=>n.runId==='live',send:async n=>{sent.push(n.runId);return{status:'accepted'}}})
    await worker.wake()
    expect(sent).toEqual(['live'])
    expect(store.list('task-1').filter(n=>n.runId!=='live').every(n=>n.status==='suppressed')).toBe(true)
    await worker.close()
  })

  it('maps blocked to suppressed and ambiguous sends to unknown',async()=>{
    const {store}=subscribed();store.enqueue(input({runId:'blocked'}));store.enqueue(input({runId:'ambiguous'}))
    const worker=makeWechatNotificationWorker({store,eligible:()=>true,send:async n=>n.runId==='blocked'?{status:'blocked',reason:'binding'}:{status:'unknown',reason:'timeout'}})
    await worker.wake()
    expect(store.list('task-1').map(n=>[n.runId,n.status,n.reason])).toEqual([['blocked','suppressed','binding'],['ambiguous','unknown','timeout']])
    await worker.close()
  })

  it('aborts an in-flight sender and settles the claim before close resolves',async()=>{
    const {store}=subscribed(),notice=store.enqueue(input());let signal!:AbortSignal
    const worker=makeWechatNotificationWorker({store,eligible:()=>true,send:(_notice,s)=>new Promise(resolve=>{signal=s;s.addEventListener('abort',()=>resolve({status:'accepted'}),{once:true})})})
    void worker.wake();await vi.waitFor(()=>expect(signal).toBeInstanceOf(AbortSignal));await worker.close()
    expect(signal.aborted).toBe(true);expect(store.list('task-1').find(n=>n.id===notice.id)?.status).toBe('accepted')
    await expect(worker.wake()).resolves.toBeUndefined()
  })

  it('marks an aborted unsettled sender unknown before close resolves',async()=>{
    const {store}=subscribed(),notice=store.enqueue(input())
    const worker=makeWechatNotificationWorker({store,eligible:()=>true,send:(_notice,signal)=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}))})
    void worker.wake();await vi.waitFor(()=>expect(store.list('task-1')[0]?.status).toBe('sending'));await worker.close()
    expect(store.list('task-1').find(n=>n.id===notice.id)).toMatchObject({status:'unknown',reason:'aborted'})
  })

  it('suppresses notices queued for an account replaced by explicit resubscribe',async()=>{
    const {store}=subscribed();store.enqueue(input());store.watch('task-1','owner-1','account-2',true);const sent:string[]=[]
    const worker=makeWechatNotificationWorker({store,eligible:n=>store.subscription(n.taskId)?.accountId===n.accountId,send:async n=>{sent.push(n.id);return{status:'accepted'}}})
    await worker.wake();expect(sent).toEqual([]);expect(store.list('task-1')[0]?.status).toBe('suppressed');await worker.close()
  })

  it('invalidates an already claimed notice when generation changes during delayed eligibility',async()=>{
    const {store}=subscribed(),notice=store.enqueue(input());let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),sent:string[]=[]
    const worker=makeWechatNotificationWorker({store,eligible:async n=>{await gate;const sub=store.subscription(n.taskId);return !!sub&&sub.enabled&&sub.generation===n.subscriptionGeneration},send:async n=>{sent.push(n.id);return{status:'accepted'}}})
    const waking=worker.wake();await vi.waitFor(()=>expect(store.list('task-1')[0]?.status).toBe('sending'))
    store.watch('task-1','owner-1','account-2',true);release();await waking
    expect(sent).toEqual([]);expect(store.list('task-1').find(n=>n.id===notice.id)?.status).toBe('suppressed');await worker.close()
  })

  it('never resends after a positive acknowledgement followed by a status write failure',async()=>{
    const {store}=subscribed();store.enqueue(input());let sends=0
    const broken={...store,complete(){throw Error('disk-failed')}}
    const worker=makeWechatNotificationWorker({store:broken,eligible:()=>true,send:async()=>{sends++;return{status:'accepted'}}})
    await expect(worker.wake()).rejects.toThrow('disk-failed');expect(sends).toBe(1)
    await expect(worker.wake()).resolves.toBeUndefined();expect(sends).toBe(1)
    await worker.close()
    expect(store.recoverStaleSending()).toBe(1);expect(store.list('task-1')[0]?.status).toBe('unknown')
  })

  it('contains a timer-triggered status failure and remains available for other pending work',async()=>{
    vi.useFakeTimers();vi.setSystemTime(100)
    const {store}=subscribed(),first=store.enqueue(input());store.claim(first.id,100);store.defer(first.id,'closed',100,1000,8000)
    let fail=true,sends=0
    const wrapped={...store,complete(...args:Parameters<typeof store.complete>){if(fail){fail=false;throw Error('disk-failed')}return store.complete(...args)}}
    const worker=makeWechatNotificationWorker({store:wrapped,eligible:()=>true,send:async()=>{sends++;return{status:'accepted'}}})
    await vi.advanceTimersByTimeAsync(1000);expect(sends).toBe(1);expect(store.list('task-1')[0]?.status).toBe('sending')
    store.enqueue(input({runId:'run-2'}));await worker.wake();expect(sends).toBe(2);expect(store.list('task-1').find(n=>n.runId==='run-2')?.status).toBe('accepted');await worker.close()
  })

  it('schedules bounded recovery for untouched pending work after an ordinary wake storage failure',async()=>{
    vi.useFakeTimers();vi.setSystemTime(100)
    const {store}=subscribed();store.enqueue(input({runId:'run-1'}));store.enqueue(input({runId:'run-2'}));let fail=true,sends=0
    const wrapped={...store,complete(...args:Parameters<typeof store.complete>){if(fail){fail=false;throw Error('disk-failed')}return store.complete(...args)}}
    const worker=makeWechatNotificationWorker({store:wrapped,eligible:()=>true,send:async()=>{sends++;return{status:'accepted'}},deferBaseMs:1000})
    await expect(worker.wake()).rejects.toThrow('disk-failed');expect(sends).toBe(1);expect(store.list('task-1').map(n=>n.status).sort()).toEqual(['pending','sending'])
    await vi.advanceTimersByTimeAsync(999);expect(sends).toBe(1);await vi.advanceTimersByTimeAsync(1);expect(sends).toBe(2)
    expect(store.list('task-1').map(n=>n.status).sort()).toEqual(['accepted','sending']);await worker.close()
  })

  it('bounds text and sends one notice as one wire request',async()=>{
    const {store}=subscribed()
    expect(()=>store.enqueue(input({text:'x'.repeat(4001)}))).toThrow('invalid_notification')
    const notice=store.enqueue(input({text:'x'.repeat(4000)}));const received:WechatNotificationNotice[]=[]
    const worker=makeWechatNotificationWorker({store,eligible:()=>true,send:async n=>{received.push(n);return{status:'accepted'}}})
    await worker.wake();expect(received).toHaveLength(1);expect(received[0]).toMatchObject({id:notice.id,text:notice.text,status:'sending'});await worker.close()
  })
})
