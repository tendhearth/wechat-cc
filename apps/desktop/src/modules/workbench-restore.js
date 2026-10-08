// @ts-check
/** @typedef {{id:string,artifactId:string,path:string,changeId:string}} Selection */
/** @typedef {Selection & {requestId:string}} Request */
/** @typedef {{operationId:string,workspaceId:string,taskId:string,artifactId:string,path:string,changeId:string,requestId:string,state:'reverted'|'needs_recovery'|'resolved_keep_current',observedFingerprint?:string,reason?:string}} Operation */
/** @typedef {{input:Request,state:'uncertain'|'reverted'|'needs_recovery'|'resolved_keep_current',operation?:Operation,error?:string,workspaceId?:string}} Attempt */
const KEY='cc.workbench.restore.v1'
/** @param {Selection} s */
const key=s=>JSON.stringify([s.id,s.artifactId,s.path,s.changeId])
/** Requests are immutable and persisted before any mutation. A lost reply never
 * creates a second mutation identity; receipts stay bound to the original task.
 * @param {{storage?:Pick<Storage,'getItem'|'setItem'>|null,invoke:(method:'POST',path:string,body:Record<string,unknown>)=>Promise<unknown>}} deps */
export function createRestoreActions(deps){
  /** @type {Map<string,Attempt>} */const attempts=new Map()
  /** @type {Map<string,Promise<Attempt>>} */const inflight=new Map()
  try{for(const a of JSON.parse(deps.storage?.getItem(KEY)??'[]'))if(a?.input&&typeof a.input.id==='string'&&typeof a.input.artifactId==='string'&&typeof a.input.path==='string'&&typeof a.input.changeId==='string'&&/^[0-9a-f-]{36}$/i.test(a.input.requestId))attempts.set(key(a.input),a)}catch{}
  const persist=()=>deps.storage?.setItem(KEY,JSON.stringify([...attempts.values()]))
  return{
    /** @param {Selection} selection */
    get:selection=>attempts.get(key(selection))??null,
    /** @param {Selection} selection @param {string} [workspaceId] @returns {Promise<Attempt>} */
    revert(selection,workspaceId){
      const k=key(selection),pending=inflight.get(k);if(pending)return pending
      let a=attempts.get(k)
      if(a&&a.state!=='uncertain')return Promise.resolve(a)
      a??={input:{...selection,requestId:crypto.randomUUID()},state:'uncertain',...(workspaceId?{workspaceId}:{})}
      attempts.set(k,a)
      const snapshot=a
      const promise=(async()=>{
        // Failed persistence must stop before POST; retain the in-memory identity.
        persist()
        try{
          const value=/** @type {{operation?:Operation}} */(await deps.invoke('POST','/v1/workbench/review-revert',{...snapshot.input})),o=value?.operation
          if(!o||o.taskId!==snapshot.input.id||o.requestId!==snapshot.input.requestId||o.artifactId!==snapshot.input.artifactId||o.path!==snapshot.input.path||o.changeId!==snapshot.input.changeId||!o.operationId||!o.workspaceId||(snapshot.workspaceId&&o.workspaceId!==snapshot.workspaceId)||!['reverted','needs_recovery'].includes(o.state))throw Error('restore_receipt_mismatch')
          snapshot.operation=o;snapshot.state=o.state;delete snapshot.error;persist()
        }catch(error){snapshot.error=error instanceof Error?error.message:String(error);persist()/* Never infer that bytes were restored. */}
        return snapshot
      })().finally(()=>inflight.delete(k))
      inflight.set(k,promise);return promise
    },
    /** @param {{id:string,operationId:string,observedFingerprint:string}} input @param {Pick<Selection,'artifactId'|'path'|'changeId'>} [expected] */
    async resolve(input,expected){
      try{
        const value=/** @type {{operation?:Operation}} */(await deps.invoke('POST','/v1/workbench/review-revert-resolve',{...input})),o=value?.operation
        const previous=[...attempts.values()].find(a=>a.input.id===input.id&&a.operation?.operationId===input.operationId)
        if(!o||o.taskId!==input.id||o.operationId!==input.operationId||o.state!=='resolved_keep_current'||!o.workspaceId||!o.artifactId||!o.path||!o.changeId||!o.requestId||expected&&(o.artifactId!==expected.artifactId||o.path!==expected.path||o.changeId!==expected.changeId)||previous&&(o.requestId!==previous.input.requestId||o.artifactId!==previous.input.artifactId||o.path!==previous.input.path||o.changeId!==previous.input.changeId||o.workspaceId!==previous.operation?.workspaceId))throw Error('restore_receipt_mismatch')
        for(const a of attempts.values())if(a.input.id===input.id&&a.operation?.operationId===input.operationId){a.operation=o;a.state='resolved_keep_current'}
        persist();return{state:'resolved_keep_current',operation:o}
      }catch(error){return{state:'failed',error:error instanceof Error?error.message:String(error)}}
    },
  }
}
