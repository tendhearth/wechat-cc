// @ts-check
import {entryFailureKind} from '../shared/task-entry-contract.js'
const KEY='cc.workbench.fork-attempts.v1'
/** @typedef {{input:Record<string,unknown>,uncertain:boolean,taskId?:string}} Attempt */
/** A remount may still be waiting on the original transport. */
/** @type {Map<string,Promise<string>>} */const inFlight=new Map()
/** @type {WeakMap<object,{attempts:Map<string,Attempt>,choices:Map<string,string>}>} */const states=new WeakMap()
/** @param {{storage?:Pick<Storage,'getItem'|'setItem'>|null,invoke:(method:'GET'|'POST',path:string,body?:Record<string,unknown>)=>Promise<unknown>}} deps */
export function createWorkbenchForkAttempts(deps){
 const cached=deps.storage?states.get(deps.storage):undefined
 /** @type {Map<string,Attempt>} */const attempts=cached?.attempts??new Map()
 /** @type {Map<string,string>} */const choices=cached?.choices??new Map()
 if(!cached)try{const saved=JSON.parse(deps.storage?.getItem(KEY)??'{}');for(const [scope,a] of saved.attempts??[])if(typeof scope==='string'&&a?.input&&/^[0-9a-f-]{36}$/i.test(a.input.requestId))attempts.set(scope,a);for(const [id,provider] of saved.choices??[])if(typeof id==='string'&&typeof provider==='string')choices.set(id,provider)}catch{}
 if(deps.storage&&!cached)states.set(deps.storage,{attempts,choices})
 const persist=()=>deps.storage?.setItem(KEY,JSON.stringify({attempts:[...attempts],choices:[...choices]}))
 const scope=(/** @type {string} */id,/** @type {string} */provider)=>JSON.stringify([id,provider])
 const receiptTask=(/** @type {unknown} */raw,/** @type {Attempt} */a)=>{
  const value=/** @type {{receipt?:{requestId?:unknown,taskId?:unknown},task?:{id?:unknown}}|null} */(raw),r=value?.receipt
  return typeof r?.requestId==='string'&&r.requestId.toLowerCase()===String(a.input.requestId).toLowerCase()&&typeof r.taskId==='string'&&r.taskId.length>0&&(!value?.task||value.task.id===r.taskId)?r.taskId:null
 }
 return{
  /** @param {string} id */provider:id=>choices.get(id),
  /** @param {string} id @param {string} provider */choose(id,provider){choices.set(id,provider);persist()},
  /** @param {string} id @param {string} provider */get:(id,provider)=>attempts.get(scope(id,provider)),
  /** @param {string} id @param {string} provider @param {Record<string,unknown>} input */
  async send(id,provider,input){
   const key=scope(id,provider)
   let a=attempts.get(key)
   if(!a||!a.uncertain&&!a.taskId&&JSON.stringify(input)!==JSON.stringify(Object.fromEntries(Object.entries(a.input).filter(([k])=>k!=='requestId'))))a={input:{...structuredClone(input),requestId:crypto.randomUUID()},uncertain:false}
   attempts.set(key,a);choices.set(id,provider);persist()
   const snapshot=a,requestId=String(a.input.requestId)
   if(snapshot.taskId)return snapshot.taskId
   const running=inFlight.get(requestId)
   if(running){const taskId=await running;snapshot.taskId=taskId;persist();return taskId}
   const lookup=async()=>{try{return receiptTask(await deps.invoke('GET',`/v1/workbench/entry-receipt?requestId=${encodeURIComponent(requestId)}`),snapshot)}catch{return null}}
   const run=async()=>{
    let taskId=snapshot.uncertain?await lookup():null
    if(!taskId){
     snapshot.uncertain=true;persist()
     try{taskId=receiptTask(await deps.invoke('POST','/v1/workbench/create-entry',structuredClone(snapshot.input)),snapshot);if(!taskId)throw Error('unconfirmed_receipt')}
     catch(error){taskId=await lookup();if(!taskId){const kind=entryFailureKind(error instanceof Error?error.message:String(error),{surface:'desktop',method:'POST'});if(kind==='expired')attempts.delete(key);else if(kind==='rejected')snapshot.uncertain=false;persist();throw error}}
    }
    snapshot.taskId=taskId;persist();return taskId
   }
   const promise=run();inFlight.set(requestId,promise)
   try{return await promise}finally{inFlight.delete(requestId)}
  },
 }
}
