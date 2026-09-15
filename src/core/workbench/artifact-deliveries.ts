import {createHash} from 'node:crypto'
import type {Db} from '../../lib/db'
import {isWorkbenchMediaItem,type ArtifactTransportOutcome as IlinkArtifactTransportOutcome,type WorkbenchMediaItem} from '../../lib/ilink-workbench'

export type ArtifactDeliveryStatus='prepared'|'uploading'|'uploaded'|'sending'|'accepted'|'unknown'|'blocked'
export interface ArtifactDeliveryReceipt {
  id:string;commandHash:string;taskId:string;artifactId:string;artifactSha256:string
  name:string;mime:string;size:number;ownerChatId:string;accountId:string
  status:ArtifactDeliveryStatus;mediaItemJson:string|null;reason:string|null;createdAt:number;updatedAt:number
}
export interface ArtifactDeliveryPayload {name:string;mime:string;size:number;sha256:string;contentBase64:string}
export type ArtifactUploadOutcome={status:'uploaded';item:WorkbenchMediaItem}|{status:'retryable';reason:string}|{status:'blocked';reason:string}
export type ArtifactTransportOutcome=IlinkArtifactTransportOutcome

const SELECT=`SELECT id,command_hash AS commandHash,task_id AS taskId,artifact_id AS artifactId,
  artifact_sha256 AS artifactSha256,name,mime,size,owner_chat_id AS ownerChatId,account_id AS accountId,
  status,media_item_json AS mediaItemJson,reason,created_at AS createdAt,updated_at AS updatedAt
  FROM workbench_artifact_deliveries`
const IMMUTABLE:Array<keyof Omit<ArtifactDeliveryReceipt,'status'|'mediaItemJson'|'reason'|'createdAt'|'updatedAt'>>=
  ['id','commandHash','taskId','artifactId','artifactSha256','name','mime','size','ownerChatId','accountId']

export {initializeArtifactDeliverySchema} from '../../lib/db'

const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)

/** Parse the only outbound item families artifact delivery may persist or send. */
export function parseWorkbenchMediaItem(json:string):WorkbenchMediaItem {
  let value:unknown
  try{value=JSON.parse(json)}catch{throw Error('invalid_artifact_media')}
  if(!isWorkbenchMediaItem(value))throw Error('invalid_artifact_media')
  return value
}

function validInput(input:Omit<ArtifactDeliveryReceipt,'status'|'mediaItemJson'|'reason'|'createdAt'|'updatedAt'>){
  if(!input.id||!input.commandHash.match(/^[a-f0-9]{64}$/)||!input.taskId||!input.artifactId||!input.artifactSha256.match(/^[a-f0-9]{64}$/)||!input.name||!input.mime||!Number.isSafeInteger(input.size)||input.size<0||input.size>8*1024*1024||!input.ownerChatId||!input.accountId)throw Error('invalid_artifact_delivery')
}

export function makeArtifactDeliveryStore(db:Db){
  const get=(id:string)=>db.query<ArtifactDeliveryReceipt,[string]>(SELECT+' WHERE id=?').get(id)
  const requireReceipt=(id:string)=>{const receipt=get(id);if(!receipt)throw Error('artifact_delivery_not_found');return receipt}
  const transition=(id:string,from:ArtifactDeliveryStatus|ArtifactDeliveryStatus[],to:ArtifactDeliveryStatus,fields:{mediaItemJson?:string|null;reason?:string|null}={})=>{
    const states=Array.isArray(from)?from:[from],sets=['status=?','updated_at=?'],args:Array<string|number|null>=[to,Date.now()]
    if(Object.hasOwn(fields,'mediaItemJson')){sets.push('media_item_json=?');args.push(fields.mediaItemJson??null)}
    if(Object.hasOwn(fields,'reason')){sets.push('reason=?');args.push(fields.reason??null)}
    args.push(id,...states)
    const result=db.query(`UPDATE workbench_artifact_deliveries SET ${sets.join(',')} WHERE id=? AND status IN (${states.map(()=>'?').join(',')})`).run(...args)
    if(!result.changes)throw Error('artifact_delivery_stale')
    return requireReceipt(id)
  }
  return{
    get,
    reserve(input:Omit<ArtifactDeliveryReceipt,'status'|'mediaItemJson'|'reason'|'createdAt'|'updatedAt'>){
      return db.transaction(()=>{
        const prior=get(input.id)
        if(prior){if(IMMUTABLE.some(field=>prior[field]!==input[field]))throw Error('artifact_delivery_conflict');return{receipt:prior,created:false}}
        validInput(input)
        const artifact=db.query<{taskId:string},[string]>('SELECT task_id AS taskId FROM workbench_artifacts WHERE id=?').get(input.artifactId)
        if(artifact&&artifact.taskId!==input.taskId)throw Error('artifact_delivery_scope')
        const now=Date.now()
        db.query(`INSERT INTO workbench_artifact_deliveries(id,command_hash,task_id,artifact_id,artifact_sha256,name,mime,size,owner_chat_id,account_id,status,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,'prepared',?,?)`).run(input.id,input.commandHash,input.taskId,input.artifactId,input.artifactSha256,input.name,input.mime,input.size,input.ownerChatId,input.accountId,now,now)
        return{receipt:requireReceipt(input.id),created:true}
      })()
    },
    claimUpload(id:string){const result=db.query("UPDATE workbench_artifact_deliveries SET status='uploading',reason=NULL,updated_at=? WHERE id=? AND status='prepared'").run(Date.now(),id);return result.changes?requireReceipt(id):null},
    uploaded(id:string,item:WorkbenchMediaItem){const normalized=parseWorkbenchMediaItem(JSON.stringify(item));return transition(id,'uploading','uploaded',{mediaItemJson:JSON.stringify(normalized),reason:null})},
    retryUpload:(id:string,reason:string)=>transition(id,'uploading','prepared',{mediaItemJson:null,reason}),
    claimSend(id:string){const result=db.query("UPDATE workbench_artifact_deliveries SET status='sending',reason=NULL,updated_at=? WHERE id=? AND status='uploaded' AND media_item_json IS NOT NULL").run(Date.now(),id);return result.changes?requireReceipt(id):null},
    complete(id:string,status:'accepted'|'unknown'|'blocked',reason?:string){
      const from:ArtifactDeliveryStatus[]=status==='blocked'?['prepared','uploading','uploaded','sending']:['sending']
      return transition(id,from,status,{reason:reason??null})
    },
    deferSend:(id:string,reason:string)=>transition(id,'sending','uploaded',{reason}),
    recover(){return db.transaction(()=>{
      const now=Date.now()
      const uploadsReset=db.query("UPDATE workbench_artifact_deliveries SET status='prepared',media_item_json=NULL,reason='worker_restarted',updated_at=? WHERE status='uploading'").run(now).changes
      const sendsUnknown=db.query("UPDATE workbench_artifact_deliveries SET status='unknown',reason='worker_restarted',updated_at=? WHERE status='sending'").run(now).changes
      return{uploadsReset,sendsUnknown}
    })()},
  }
}
export type ArtifactDeliveryStore=ReturnType<typeof makeArtifactDeliveryStore>

interface WorkerOptions {
  store:ArtifactDeliveryStore
  load:(receipt:ArtifactDeliveryReceipt)=>Promise<ArtifactDeliveryPayload>
  upload:(receipt:ArtifactDeliveryReceipt,payload:ArtifactDeliveryPayload,signal:AbortSignal)=>Promise<ArtifactUploadOutcome>
  send:(receipt:ArtifactDeliveryReceipt,item:WorkbenchMediaItem,signal:AbortSignal)=>Promise<ArtifactTransportOutcome>
}

function abortError(){return new DOMException('aborted','AbortError')}
function abortable<T>(start:()=>Promise<T>|T,signal:AbortSignal):Promise<T>{
  const operation=Promise.resolve().then(()=>{if(signal.aborted)throw abortError();return start()})
  operation.catch(()=>{})
  if(signal.aborted)return Promise.reject(abortError())
  return new Promise<T>((resolve,reject)=>{
    const abort=()=>reject(abortError());signal.addEventListener('abort',abort,{once:true})
    operation.then(value=>{signal.removeEventListener('abort',abort);resolve(value)},error=>{signal.removeEventListener('abort',abort);reject(error)})
  })
}
function retryableLoad(error:unknown){return object(error)&&['EBUSY','EIO','EMFILE','ENFILE','ENOMEM'].includes(String(error.code??''))}
function payloadBytes(receipt:ArtifactDeliveryReceipt,payload:ArtifactDeliveryPayload):Buffer {
  if(payload.name!==receipt.name||payload.mime!==receipt.mime||payload.size!==receipt.size||payload.sha256!==receipt.artifactSha256||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload.contentBase64))throw Error('artifact_changed')
  const bytes=Buffer.from(payload.contentBase64,'base64')
  if(bytes.length!==receipt.size||createHash('sha256').update(bytes).digest('hex')!==receipt.artifactSha256)throw Error('artifact_changed')
  return bytes
}

/** Explicit-only serialized delivery worker. It owns no timer, scan, or enqueue path. */
export function makeArtifactDeliveryWorker(options:WorkerOptions){
  options.store.recover()
  let closing=false,current:AbortController|null=null,tail=Promise.resolve()
  let closePromise:Promise<void>|null=null
  const inflight=new Map<string,Promise<ArtifactDeliveryReceipt>>(),pending=new Set<Promise<ArtifactDeliveryReceipt>>()
  const run=async(id:string):Promise<ArtifactDeliveryReceipt>=>{
    let receipt=options.store.get(id);if(!receipt)throw Error('artifact_delivery_not_found')
    if(closing||['accepted','unknown','blocked'].includes(receipt.status))return receipt
    const controller=new AbortController();current=controller
    try{
      if(receipt.status==='prepared'){
        receipt=options.store.claimUpload(id)??options.store.get(id)!
        if(receipt.status!=='uploading')return receipt
        let payload:ArtifactDeliveryPayload
        try{payload=await abortable(()=>options.load(receipt!),controller.signal);payloadBytes(receipt,payload)}
        catch(error){
          if(error instanceof DOMException&&error.name==='AbortError')return options.store.retryUpload(id,closing?'worker_closed':'upload_cancelled')
          if(retryableLoad(error))return options.store.retryUpload(id,'load_retryable')
          return options.store.complete(id,'blocked',error instanceof Error&&error.message==='artifact_changed'?'artifact_changed':'load_invalid')
        }
        try{
          const outcome=await abortable(()=>options.upload(receipt!,payload,controller.signal),controller.signal)
          if(outcome.status==='retryable')return options.store.retryUpload(id,outcome.reason)
          if(outcome.status==='blocked')return options.store.complete(id,'blocked',outcome.reason)
          receipt=options.store.uploaded(id,outcome.item)
        }catch(error){return options.store.retryUpload(id,error instanceof DOMException&&error.name==='AbortError'?(closing?'worker_closed':'upload_cancelled'):'upload_retryable')}
      }
      if(receipt.status!=='uploaded'||!receipt.mediaItemJson)return options.store.get(id)!
      let item:WorkbenchMediaItem
      try{item=parseWorkbenchMediaItem(receipt.mediaItemJson)}catch{return options.store.complete(id,'blocked','invalid_artifact_media')}
      receipt=options.store.claimSend(id)??options.store.get(id)!
      if(receipt.status!=='sending')return receipt
      try{
        const outcome=await abortable(()=>options.send(receipt!,item,controller.signal),controller.signal)
        if(outcome.status==='accepted')return options.store.complete(id,'accepted')
        if(outcome.status==='deferred')return options.store.deferSend(id,outcome.reason)
        return options.store.complete(id,outcome.status,outcome.reason)
      }catch(error){return options.store.complete(id,'unknown',error instanceof DOMException&&error.name==='AbortError'?(closing?'worker_closed':'send_cancelled'):'send_uncertain')}
    }finally{if(current===controller)current=null}
  }
  const deliver=(id:string)=>{
    const existing=inflight.get(id);if(existing)return existing
    const operation=tail.then(()=>run(id));tail=operation.then(()=>{},()=>{})
    inflight.set(id,operation);pending.add(operation)
    operation.finally(()=>{inflight.delete(id);pending.delete(operation)}).catch(()=>{})
    return operation
  }
  const close=()=>closePromise??=(async()=>{closing=true;current?.abort();await Promise.allSettled([...pending])})()
  return{deliver,close}
}
