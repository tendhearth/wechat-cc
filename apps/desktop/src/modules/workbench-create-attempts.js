// @ts-check
import {entryFailureKind} from '../shared/task-entry-contract.js'
const KEY='cc.workbench.create-attempts.v1'
/** @typedef {{input:Record<string,unknown>,signature:string,uncertain:boolean}} Attempt */
/** Legacy project form keeps its title/path semantics, but uses the same numbered
 * creation service. An uncertain request must be checked or replayed unchanged.
 * @param {{storage?:Pick<Storage,'getItem'|'setItem'>|null,invoke:(method:'GET'|'POST',path:string,body?:Record<string,unknown>)=>Promise<unknown>}} deps */
export function createWorkbenchCreateAttempts(deps){
 /** @type {Map<string,Attempt>} */const attempts=new Map()
 try{for(const [scope,a] of JSON.parse(deps.storage?.getItem(KEY)??'[]'))if(typeof scope==='string'&&a?.input&&typeof a.signature==='string'&&/^[0-9a-f-]{36}$/i.test(a.input.requestId))attempts.set(scope,a)}catch{}
 const persist=()=>deps.storage?.setItem(KEY,JSON.stringify([...attempts]))
 return{
  /** @param {string} scope @param {Record<string,unknown>} input */
  async send(scope,input){
   const signature=JSON.stringify(input)
   let a=attempts.get(scope)
   if(!a||!a.uncertain&&a.signature!==signature)a={input:{...structuredClone(input),requestId:crypto.randomUUID()},signature,uncertain:false}
   attempts.set(scope,a);persist()
   const snapshot=a
   const lookup=async()=>{
    try{const value=/** @type {{task?:import('./workbench.js').Task,receipt?:{requestId:string}}} */(await deps.invoke('GET',`/v1/workbench/entry-receipt?requestId=${encodeURIComponent(String(snapshot.input.requestId))}`));return value.receipt?.requestId===snapshot.input.requestId&&value.task?.id?value:null}catch{return null}
   }
   let value=snapshot.uncertain?await lookup():null
   if(!value){
    snapshot.uncertain=true;persist()
    try{value=/** @type {{task?:import('./workbench.js').Task}} */(await deps.invoke('POST','/v1/workbench/create',structuredClone(snapshot.input)));if(!value?.task?.id)throw Error('unconfirmed_receipt')}
    catch(error){value=await lookup();if(!value){const kind=entryFailureKind(error instanceof Error?error.message:String(error),{surface:'desktop',method:'POST'});if(kind==='expired')attempts.delete(scope);else if(kind==='rejected')snapshot.uncertain=false;persist();throw error}}
   }
   attempts.delete(scope);persist()
   return{...value,input:snapshot.input,matches:signature===snapshot.signature}
  },
 }
}
