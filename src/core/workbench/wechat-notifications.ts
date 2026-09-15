import {createHash} from 'node:crypto'
import type {Database} from 'bun:sqlite'

export type WechatNoticeStatus='pending'|'sending'|'accepted'|'unknown'|'suppressed'
export type WechatNoticeKind='permission'|'question'|'completed'|'failed'|'interrupted'|'cancelled'

export interface WechatNotificationSubscription {
  taskId:string
  ownerChatId:string
  accountId:string
  enabled:boolean
  generation:number
  createdAt:number
  updatedAt:number
}

export interface WechatNotificationNotice {
  id:string
  taskId:string
  runId:string
  ownerChatId:string
  accountId:string
  kind:WechatNoticeKind
  requestId:string|null
  text:string
  status:WechatNoticeStatus
  createdAt:number
  updatedAt:number
  reason:string|null
  subscriptionGeneration:number
}

export interface WechatNotificationIntent {
  id:string
  noticeId:string
  taskId:string
  runId:string
  ownerChatId:string
  accountId:string
  subscriptionGeneration:number
  kind:WechatNoticeKind
  requestId:string|null
  text:string
  status:'pending'|'materialized'|'suppressed'
  createdAt:number
  updatedAt:number
  reason:string|null
}

export type NoticeStatus=WechatNoticeStatus
export type NoticeKind=WechatNoticeKind
export type Notice=WechatNotificationNotice
export type NotificationSubscription=WechatNotificationSubscription

type StoredSubscription={taskId:string;ownerChatId:string;accountId:string;enabled:number;generation:number;createdAt:number;updatedAt:number}
type StoredNotice=Omit<WechatNotificationNotice,'status'> & {status:WechatNoticeStatus;nextAttemptAt:number|null;deferCount:number}
type StoredIntent=WechatNotificationIntent
export type WechatNotificationInput=Pick<WechatNotificationNotice,'taskId'|'runId'|'ownerChatId'|'accountId'|'kind'|'text'> & {requestId?:string|null}

const NOTICE_SELECT=`SELECT id,task_id AS taskId,run_id AS runId,owner_chat_id AS ownerChatId,account_id AS accountId,subscription_generation AS subscriptionGeneration,kind,request_id AS requestId,text,status,created_at AS createdAt,updated_at AS updatedAt,reason,next_attempt_at AS nextAttemptAt,defer_count AS deferCount FROM workbench_wechat_notices`
const SUBSCRIPTION_SELECT=`SELECT task_id AS taskId,owner_chat_id AS ownerChatId,account_id AS accountId,enabled,generation,created_at AS createdAt,updated_at AS updatedAt FROM workbench_wechat_subscriptions`
const INTENT_SELECT=`SELECT id,notice_id AS noticeId,task_id AS taskId,run_id AS runId,owner_chat_id AS ownerChatId,account_id AS accountId,subscription_generation AS subscriptionGeneration,kind,request_id AS requestId,text,status,created_at AS createdAt,updated_at AS updatedAt,reason FROM workbench_wechat_notice_intents`
const kinds=new Set<WechatNoticeKind>(['permission','question','completed','failed','interrupted','cancelled'])
const ids=(value:string)=>typeof value==='string'&&value.length>0&&value.length<=500&&!/[\0\r\n]/.test(value)
const publicNotice=({nextAttemptAt:_nextAttemptAt,deferCount:_deferCount,...row}:StoredNotice):WechatNotificationNotice=>row
const publicSubscription=(row:StoredSubscription):WechatNotificationSubscription=>({...row,enabled:row.enabled===1})
const identity=(input:WechatNotificationInput & {subscriptionGeneration:number})=>`wn-${createHash('sha256').update(JSON.stringify([input.taskId,input.runId,input.kind,input.requestId??null,input.subscriptionGeneration])).digest('hex').slice(0,32)}`

export {initializeWechatNotificationSchema} from '../../lib/db'

export function makeWechatNotificationStore(db:Database){
  const readNotice=(id:string)=>db.query<StoredNotice,[string]>(`${NOTICE_SELECT} WHERE id=?`).get(id)
  const readIntent=(id:string)=>db.query<StoredIntent,[string]>(`${INTENT_SELECT} WHERE id=?`).get(id)
  const validateInput=(input:WechatNotificationInput)=>{
    if(!ids(input.taskId)||!ids(input.runId)||!ids(input.ownerChatId)||!ids(input.accountId)||!kinds.has(input.kind)||
      (input.requestId!==undefined&&input.requestId!==null&&!ids(input.requestId))||typeof input.text!=='string'||input.text.length<1||input.text.length>4000)throw Error('invalid_notification')
  }
  const activeSubscription=(input:WechatNotificationInput)=>{
    const subscription=db.query<StoredSubscription,[string]>(`${SUBSCRIPTION_SELECT} WHERE task_id=?`).get(input.taskId)
    if(!subscription||subscription.enabled!==1)throw Error('subscription_inactive')
    if(subscription.ownerChatId!==input.ownerChatId||subscription.accountId!==input.accountId)throw Error('subscription_mismatch')
    return subscription
  }
  const insertNotice=(normalized:WechatNotificationInput & {requestId:string|null;subscriptionGeneration:number})=>{
    const id=identity(normalized),existing=readNotice(id)
    if(existing){
      if(existing.taskId!==normalized.taskId||existing.runId!==normalized.runId||existing.ownerChatId!==normalized.ownerChatId||existing.accountId!==normalized.accountId||existing.subscriptionGeneration!==normalized.subscriptionGeneration||existing.kind!==normalized.kind||existing.requestId!==normalized.requestId||existing.text!==normalized.text)throw Error('notification_conflict')
      return publicNotice(existing)
    }
    const now=Date.now()
    db.query('INSERT INTO workbench_wechat_notices(id,task_id,run_id,owner_chat_id,account_id,subscription_generation,kind,request_id,text,status,created_at,updated_at,reason,next_attempt_at,defer_count) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,normalized.taskId,normalized.runId,normalized.ownerChatId,normalized.accountId,normalized.subscriptionGeneration,normalized.kind,normalized.requestId,normalized.text,'pending',now,now,null,null,0)
    return publicNotice(readNotice(id)!)
  }
  return {
    watch(taskId:string,ownerChatId:string,accountId:string,enabled:boolean):WechatNotificationSubscription {
      if(!ids(taskId)||!ids(ownerChatId)||!ids(accountId)||typeof enabled!=='boolean')throw Error('invalid_subscription')
      return db.transaction(()=>{
        const current=db.query<StoredSubscription,[string]>(`${SUBSCRIPTION_SELECT} WHERE task_id=?`).get(taskId)
        const now=Date.now()
        if(current){
          if(current.ownerChatId!==ownerChatId)throw Error('subscription_conflict')
          const accountChanged=current.accountId!==accountId,reenabled=current.enabled===0&&enabled
          if(!enabled||accountChanged){
            const reason=accountChanged?'subscription_rebound':'subscription_muted'
            db.query("UPDATE workbench_wechat_notices SET status='suppressed',reason=?,updated_at=?,next_attempt_at=NULL WHERE task_id=? AND status='pending'").run(reason,now,taskId)
            db.query("UPDATE workbench_wechat_notice_intents SET status='suppressed',reason=?,updated_at=? WHERE task_id=? AND status='pending'").run(reason,now,taskId)
          }
          const generation=current.generation+(accountChanged||reenabled?1:0)
          db.query('UPDATE workbench_wechat_subscriptions SET account_id=?,enabled=?,generation=?,updated_at=? WHERE task_id=?').run(accountId,enabled?1:0,generation,now,taskId)
        }else db.query('INSERT INTO workbench_wechat_subscriptions(task_id,owner_chat_id,account_id,enabled,generation,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(taskId,ownerChatId,accountId,enabled?1:0,1,now,now)
        return publicSubscription(db.query<StoredSubscription,[string]>(`${SUBSCRIPTION_SELECT} WHERE task_id=?`).get(taskId)!)
      })()
    },
    subscription(taskId:string):WechatNotificationSubscription|null {
      if(!ids(taskId))throw Error('invalid_subscription')
      const row=db.query<StoredSubscription,[string]>(`${SUBSCRIPTION_SELECT} WHERE task_id=?`).get(taskId)
      return row?publicSubscription(row):null
    },
    enqueue(input:WechatNotificationInput):WechatNotificationNotice {
      validateInput(input)
      return db.transaction(()=>{
        const subscription=activeSubscription(input)
        return insertNotice({...input,requestId:input.requestId??null,subscriptionGeneration:subscription.generation})
      })()
    },
    stage(input:WechatNotificationInput):WechatNotificationIntent {
      validateInput(input)
      return db.transaction(()=>{
        const subscription=activeSubscription(input),normalized={...input,requestId:input.requestId??null,subscriptionGeneration:subscription.generation}
        const noticeId=identity(normalized),id=`wi-${noticeId.slice(3)}`,existing=readIntent(id)
        if(existing){
          if(existing.noticeId!==noticeId||existing.taskId!==input.taskId||existing.runId!==input.runId||existing.ownerChatId!==input.ownerChatId||existing.accountId!==input.accountId||existing.subscriptionGeneration!==subscription.generation||existing.kind!==input.kind||existing.requestId!==normalized.requestId||existing.text!==input.text)throw Error('notification_conflict')
          return existing
        }
        const now=Date.now()
        db.query('INSERT INTO workbench_wechat_notice_intents(id,notice_id,task_id,run_id,owner_chat_id,account_id,subscription_generation,kind,request_id,text,status,created_at,updated_at,reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,noticeId,input.taskId,input.runId,input.ownerChatId,input.accountId,subscription.generation,input.kind,normalized.requestId,input.text,'pending',now,now,null)
        return readIntent(id)!
      })()
    },
    materializeIntents(limit=50,now=Date.now()):number {
      const bounded=Math.max(1,Math.min(500,Math.trunc(limit)))
      const idsToProcess=db.query<{id:string},[number]>("SELECT id FROM workbench_wechat_notice_intents WHERE status='pending' ORDER BY created_at,id LIMIT ?").all(bounded).map(row=>row.id)
      let processed=0
      for(const id of idsToProcess)db.transaction(()=>{
        const intent=readIntent(id);if(!intent||intent.status!=='pending')return
        const subscription=db.query<StoredSubscription,[string]>(`${SUBSCRIPTION_SELECT} WHERE task_id=?`).get(intent.taskId)
        if(!subscription||subscription.enabled!==1||subscription.ownerChatId!==intent.ownerChatId||subscription.accountId!==intent.accountId||subscription.generation!==intent.subscriptionGeneration){
          db.query("UPDATE workbench_wechat_notice_intents SET status='suppressed',reason='subscription_changed',updated_at=? WHERE id=? AND status='pending'").run(now,id);processed++;return
        }
        insertNotice({taskId:intent.taskId,runId:intent.runId,ownerChatId:intent.ownerChatId,accountId:intent.accountId,subscriptionGeneration:intent.subscriptionGeneration,kind:intent.kind,requestId:intent.requestId,text:intent.text})
        db.query("UPDATE workbench_wechat_notice_intents SET status='materialized',reason=NULL,updated_at=? WHERE id=? AND status='pending'").run(now,id);processed++
      })()
      return processed
    },
    list(taskId:string):WechatNotificationNotice[]{
      if(!ids(taskId))throw Error('invalid_notification')
      return db.query<StoredNotice,[string]>(`${NOTICE_SELECT} WHERE task_id=? ORDER BY created_at,id`).all(taskId).map(publicNotice)
    },
    pending(limit=50,now=Date.now()):WechatNotificationNotice[]{
      const bounded=Math.max(1,Math.min(500,Math.trunc(limit)))
      return db.query<StoredNotice,[number,number]>(`${NOTICE_SELECT} WHERE status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY created_at,id LIMIT ?`).all(now,bounded).map(publicNotice)
    },
    claim(id:string,now=Date.now()):WechatNotificationNotice|null {
      if(!ids(id))throw Error('invalid_notification')
      return db.transaction(()=>{
        const result=db.query("UPDATE workbench_wechat_notices SET status='sending',updated_at=?,reason=NULL WHERE id=? AND status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?)").run(now,id,now)
        return result.changes===1?publicNotice(readNotice(id)!):null
      })()
    },
    complete(id:string,status:Exclude<WechatNoticeStatus,'sending'>,reason:string|null=null,now=Date.now(),nextAttemptAt:number|null=null):WechatNotificationNotice|null {
      if(!ids(id)||!['pending','accepted','unknown','suppressed'].includes(status)||(reason!==null&&(typeof reason!=='string'||reason.length>1000)))throw Error('invalid_notification')
      const result=status==='pending'
        ?db.query("UPDATE workbench_wechat_notices SET status=?,reason=?,updated_at=?,next_attempt_at=?,defer_count=defer_count+1 WHERE id=? AND status='sending'").run(status,reason,now,nextAttemptAt,id)
        :db.query("UPDATE workbench_wechat_notices SET status=?,reason=?,updated_at=?,next_attempt_at=NULL WHERE id=? AND status='sending'").run(status,reason,now,id)
      return result.changes===1?publicNotice(readNotice(id)!):null
    },
    defer(id:string,reason:string|null='deferred',now=Date.now(),baseMs=1000,maxMs=60_000):WechatNotificationNotice|null {
      if(!ids(id)||baseMs<1||maxMs<baseMs||(reason!==null&&(typeof reason!=='string'||reason.length>1000)))throw Error('invalid_notification')
      return db.transaction(()=>{
        const row=readNotice(id);if(!row||row.status!=='sending')return null
        const delay=Math.min(maxMs,baseMs*2**Math.min(row.deferCount,30))
        const result=db.query("UPDATE workbench_wechat_notices SET status='pending',reason=?,updated_at=?,next_attempt_at=?,defer_count=defer_count+1 WHERE id=? AND status='sending'").run(reason,now,now+delay,id)
        return result.changes===1?publicNotice(readNotice(id)!):null
      })()
    },
    nextDue(now=Date.now()):number|null {
      const immediate=db.query("SELECT 1 FROM workbench_wechat_notices WHERE status='pending' AND next_attempt_at IS NULL LIMIT 1").get()||db.query("SELECT 1 FROM workbench_wechat_notice_intents WHERE status='pending' LIMIT 1").get()
      if(immediate)return now
      return db.query<{due:number|null},[]>("SELECT MIN(next_attempt_at) AS due FROM workbench_wechat_notices WHERE status='pending' AND next_attempt_at IS NOT NULL").get()!.due
    },
    releaseDeferred(ownerChatId:string,accountId:string,now=Date.now()):number {
      if(!ids(ownerChatId)||!ids(accountId))throw Error('invalid_notification')
      return db.query("UPDATE workbench_wechat_notices SET next_attempt_at=NULL,updated_at=? WHERE status='pending' AND next_attempt_at IS NOT NULL AND owner_chat_id=? AND account_id=?").run(now,ownerChatId,accountId).changes
    },
    recoverStaleSending(now=Date.now()):number {
      return db.query("UPDATE workbench_wechat_notices SET status='unknown',reason='worker_restarted',updated_at=?,next_attempt_at=NULL WHERE status='sending'").run(now).changes
    },
  }
}

export type WechatNotificationStore=ReturnType<typeof makeWechatNotificationStore>
export interface WechatNotificationWorkerOptions {
  store:WechatNotificationStore
  eligible:(notice:WechatNotificationNotice)=>boolean|Promise<boolean>
  send:(notice:WechatNotificationNotice,signal:AbortSignal)=>Promise<{status:'accepted'|'deferred'|'unknown'|'blocked';reason?:string}>
  now?:()=>number
  setTimer?:(callback:()=>void,delay:number)=>unknown
  clearTimer?:(timer:unknown)=>void
  batchSize?:number
  deferBaseMs?:number
  deferMaxMs?:number
  yieldControl?:()=>Promise<void>
}

export function makeWechatNotificationWorker(options:WechatNotificationWorkerOptions){
  const now=options.now??Date.now,batchSize=options.batchSize??50,deferBaseMs=Math.max(1,options.deferBaseMs??1000),deferMaxMs=Math.max(deferBaseMs,options.deferMaxMs??60_000)
  const schedule=options.setTimer??((callback,delay)=>setTimeout(callback,delay))
  const unschedule=options.clearTimer??(timer=>clearTimeout(timer as ReturnType<typeof setTimeout>))
  const yieldControl=options.yieldControl??(()=>new Promise<void>(resolve=>setTimeout(resolve,0)))
  let closing=false,closed=false,running:Promise<void>|null=null,rerun=false,timer:unknown=null,controller:AbortController|null=null
  options.store.recoverStaleSending(now())
  const arm=(delay:number)=>{
    if(closing||closed)return
    if(timer!==null)unschedule(timer)
    timer=schedule(()=>{timer=null;void wake().catch(()=>arm(deferBaseMs))},delay)
  }
  const armNextDue=()=>{const due=options.store.nextDue(now());if(due!==null)arm(Math.max(0,due-now()))}
  const drain=async()=>{
    do {
      rerun=false
      while(!closing){
        const processed=options.store.materializeIntents(batchSize,now())
        if(processed<batchSize)break
        await yieldControl()
      }
      while(!closing){
        const candidates=options.store.pending(batchSize,now())
        if(candidates.length===0)break
        for(const candidate of candidates){
          if(closing)break
          const notice=options.store.claim(candidate.id,now());if(!notice)continue
          let allowed:boolean
          try{allowed=await options.eligible(notice)}catch(error){
            options.store.complete(notice.id,'unknown',error instanceof Error?error.message:'eligibility_failed',now());continue
          }
          if(closing){options.store.complete(notice.id,'unknown','worker_closed',now());break}
          if(!allowed){options.store.complete(notice.id,'suppressed','ineligible',now());continue}
          controller=new AbortController()
          let result:{status:'accepted'|'deferred'|'unknown'|'blocked';reason?:string}
          try{result=await options.send(notice,controller.signal)}catch(error){result={status:'unknown',reason:error instanceof Error?error.message:'send_failed'}}finally{controller=null}
          if(result.status==='deferred')options.store.defer(notice.id,result.reason??'deferred',now(),deferBaseMs,deferMaxMs)
          else options.store.complete(notice.id,result.status==='blocked'?'suppressed':result.status,result.reason??null,now())
          if(closing)break
        }
        if(!closing&&candidates.length===batchSize)await yieldControl()
        else break
      }
    } while(rerun&&!closing)
  }
  function wake(wakeOptions?:{contextAvailable?:{ownerChatId:string;accountId:string}}):Promise<void>{
    if(closing||closed)return Promise.resolve()
    if(wakeOptions?.contextAvailable)options.store.releaseDeferred(wakeOptions.contextAvailable.ownerChatId,wakeOptions.contextAvailable.accountId,now())
    if(running){rerun=true;return running}
    running=drain().then(()=>{if(!closing)armNextDue()},error=>{if(!closing)arm(deferBaseMs);throw error}).finally(()=>{running=null})
    return running
  }
  armNextDue()
  return {
    wake,
    async close():Promise<void>{
      if(closed){return}
      closing=true;if(timer!==null){unschedule(timer);timer=null}controller?.abort()
      if(running)await running.catch(()=>{})
      closed=true
    },
  }
}
