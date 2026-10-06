import {randomUUID} from 'node:crypto'
import {closeSync,constants,fchmodSync,fstatSync,fsyncSync,linkSync,lstatSync,openSync,readFileSync,renameSync,unlinkSync,writeSync} from 'node:fs'
import {dirname,join,resolve} from 'node:path'
import type {Db} from '../../lib/db'
import type {GitReview,ReviewFile} from './git-review'
import {createRestoreStore,type RestoreOperation,type RestoreRun,type StoredChange,type StoredOperation,type StoredRun} from './restore-store'
import {captureSnapshot,checkChain,digest,directoryId,gitInventory,initializeBlobs,verifyBlobRoot,loadBlob,observe,parentChain,safeRelative,sameContent,restoreError,syncDirectory,versionAt,type FileVersion,type GitState} from './restore-snapshots'
export type {RestoreOperation,RestoreRun} from './restore-store'
export interface RestoreFile {path:string;changeId:string;state:'available'|'blocked'|'reverted'|'needs_recovery'|'resolved_keep_current';reason?:string;operationId?:string;observedFingerprint?:string}
export interface RestoreReview extends RestoreRun {artifactId:string|null;files:RestoreFile[];review:GitReview}
export interface RestoreManagerOptions {
 db:Db;blobRoot:string
 /** Relative index keys refer to this exact execution directory, including a repository subdirectory. */
 readGitState:(path:string)=>Promise<GitState>
 /** Must reserve the execution directory AND all conflicting ancestor/descendant writers/mutations. */
 withMutation:<T>(workspaceId:string,operation:()=>Promise<T>)=>Promise<T>
 /** Must prove durable closed status for every writer, retained session, subprocess and queued input. */
 assertWriterClosed:(workspaceId:string)=>void|Promise<void>
 /** Synchronous same-database event/seq writes only; thrown errors roll the entire receipt transaction back. */
 onOperationCommitted?:(operation:Readonly<RestoreOperation>)=>void
}
export interface BeginRestore {workspaceId:string;taskId:string;runId:string;path:string;directoryIdentity:string}
export interface RevertFile {workspaceId:string;taskId:string;artifactId:string;path:string;changeId:string;requestId:string}
const terminal=(state:string)=>state==='reverted'||state==='resolved_keep_current'||state==='conflict'
const errorReason=restoreError
export function createRestoreManager(options:RestoreManagerOptions){
 const {db,blobRoot,readGitState,withMutation,assertWriterClosed}=options,store=createRestoreStore(db)
 if(!readGitState||!withMutation||!assertWriterClosed)throw Error('restore_gates_required')
 const requireRun=(id:string)=>{const r=store.run(id);if(!r)throw Error('restore_not_found');return r}
 const blocked=(workspaceId:string)=>!!store.workspace(workspaceId)?.invalid||store.pending(workspaceId)||store.runs(workspaceId).some(r=>r.status!=='closed')
 function checkRoot(run:StoredRun){const w=store.workspace(run.workspaceId);if(!w||w.invalid||w.path!==run.path||w.directoryIdentity!==run.directoryIdentity)throw Error('workspace_identity_changed');try{if(directoryId(run.path)!==run.directoryIdentity)throw Error('directory_identity_changed')}catch(e){w.invalid=1;store.putWorkspace(w);throw e}}
 function checkVersion(run:StoredRun,change:StoredChange){checkRoot(run);if(store.workspace(run.workspaceId)!.generation!==run.generation||store.pathVersion(run.workspaceId,change.path)!==change.changeId)throw Error('stale_change');if(run.status!=='closed'||!run.before||!run.after)throw Error('writer_not_closed');if(change.reason||change.before.kind==='unknown'||change.after.kind==='unknown')throw Error(change.reason??'snapshot_unavailable')}
 async function checkGit(run:StoredRun,change:StoredChange){
  const before=run.before!,after=run.after!,current=await readGitState(run.path),path=change.path
  if(before.git.head!==after.git.head||current.head!==before.git.head||(before.git.index[path]??null)!==(after.git.index[path]??null)||(current.index[path]??null)!==(before.git.index[path]??null)||before.staged.includes(path)||after.staged.includes(path)||(await gitInventory(run.path)).staged.includes(path))throw Error('git_state_changed')
 }
 function blobs(run:StoredRun,change:StoredChange){for(const version of [change.before,change.after])if(version.kind==='file')loadBlob(blobRoot,version.blobSha,run.blobRootIdentity)}
 function observedFingerprint(run:StoredRun,path:string){
  // Includes observed bytes, mode, leaf AND every directory identity. Failures never follow links.
  try{return digest(JSON.stringify(observe(run.path,path)))}catch(e){
   const identities:unknown[]=[];let cursor=run.path
   for(const part of ['',...path.split('/')]){
    if(part)cursor=join(cursor,part)
    try{const s=lstatSync(cursor,{bigint:true});identities.push({dev:String(s.dev),ino:String(s.ino),mode:String(s.mode),size:String(s.size),mtime:String(s.mtimeNs),ctime:String(s.ctimeNs)});if(!s.isDirectory()||s.isSymbolicLink())break}catch{identities.push(null);break}
   }
   return digest(JSON.stringify({identities,error:errorReason(e)}))
  }
 }
 function needsRecovery(op:StoredOperation,run:StoredRun,error:unknown){op.receipt.state='needs_recovery';op.receipt.reason=errorReason(error);op.receipt.observedFingerprint=observedFingerprint(run,op.receipt.path);try{checkRoot(run)}catch{const w=store.workspace(run.workspaceId);if(w){w.invalid=1;store.putWorkspace(w)}}store.putOperation(op)}
 function finish(op:StoredOperation,state:'reverted'|'resolved_keep_current'){
  return store.atomic(()=>{op.receipt.state=state;delete op.receipt.reason;delete op.receipt.observedFingerprint;store.putOperation(op);store.setPathVersion(op.receipt.workspaceId,op.receipt.path,randomUUID());options.onOperationCommitted?.({...op.receipt});return {...op.receipt}})
 }
 function review(run:StoredRun):RestoreReview{
  const operations=new Map(store.operations(run.workspaceId).map(o=>[o.receipt.changeId,o])),workspace=store.workspace(run.workspaceId),isBlocked=blocked(run.workspaceId),files:RestoreFile[]=run.changes.map(change=>{
   const op=operations.get(change.changeId),state=op?.receipt.state
   if(state==='reverted'||state==='resolved_keep_current'||state==='needs_recovery')return {path:change.path,changeId:change.changeId,state,operationId:op!.receipt.operationId,...(op!.receipt.reason?{reason:op!.receipt.reason}:{}),...(op!.receipt.observedFingerprint?{observedFingerprint:op!.receipt.observedFingerprint}:{})}
   let reason=change.reason
   if(workspace?.generation!==run.generation)reason='stale_change'
   if(run.status!=='closed')reason='writer_not_closed'
   if(isBlocked)reason='workspace_blocked'
   if(state==='prepared'||state==='applying')reason='operation_pending'
   return {path:change.path,changeId:change.changeId,state:reason?'blocked':'available',...(reason?{reason}:{}),...(op?{operationId:op.receipt.operationId}:{})}
  })
  const publicFiles:ReviewFile[]=[];let diffBytes=0
  for(const c of run.changes){const file:ReviewFile={path:c.path,preexisting:c.before.kind!=='absent',kind:c.reason?'not_reviewed':c.before.kind==='absent'?'added':c.after.kind==='absent'?'deleted':'modified',...(c.before.kind==='file'?{beforeSha256:c.before.blobSha}:{}),...(c.after.kind==='file'?{afterSha256:c.after.blobSha}:{}),...(c.reason?{reason:c.reason}:{})}
   if(!c.reason){try{const text=(v:FileVersion)=>v.kind==='file'?loadBlob(blobRoot,v.blobSha,run.blobRootIdentity).toString('utf8'):'';const a=text(c.before),b=text(c.after);if(a!==b){const lines=(s:string)=>s?s.match(/[^\n]*(?:\n|$)/g)!.filter(Boolean):[];const old=lines(a),next=lines(b);const body=(ls:string[],prefix:string)=>ls.map(l=>prefix+l+(l.endsWith('\n')?'':'\n\\ No newline at end of file\n')).join('');const diff=`@@ -${old.length?1:0},${old.length} +${next.length?1:0},${next.length} @@\n`+body(old,'-')+body(next,'+');if(diffBytes+Buffer.byteLength(diff)>2*1024*1024)throw Error('review_diff_limit');diffBytes+=Buffer.byteLength(diff);file.diff=diff}}catch(e){file.reason=errorReason(e);file.kind='not_reviewed'}}publicFiles.push(file)
  }
  const result:GitReview={version:1,scope:'working-tree-before-after',startedAt:run.startedAt,finishedAt:run.finishedAt??run.startedAt,headBefore:run.before?.git.head??null,headAfter:run.after?.git.head??null,status:run.error?'unavailable':publicFiles.some(f=>f.reason)||run.before?.notes.length||run.after?.notes.length?'partial':'complete',preexistingPaths:[],notes:[...(run.error?[run.error]:[]),...(run.before?.notes??[]),...(run.after?.notes??[])],files:publicFiles}
  return {restoreRunId:run.restoreRunId,workspaceId:run.workspaceId,taskId:run.taskId,runId:run.runId,generation:run.generation,startedAt:run.startedAt,finishedAt:run.finishedAt,status:run.status,artifactId:run.artifactId,files,review:result}
 }
 async function verifyOperation(op:StoredOperation){const run=requireRun(op.restoreRunId),change=run.changes.find(c=>c.changeId===op.receipt.changeId&&c.path===op.receipt.path);if(!change||op.generation!==run.generation||run.workspaceId!==op.receipt.workspaceId||run.taskId!==op.receipt.taskId||run.artifactId!==op.receipt.artifactId)throw Error('operation_identity_changed');await assertWriterClosed(run.workspaceId);checkVersion(run,change);checkChain(run.path,op.chain);await checkGit(run,change);blobs(run,change);return {run,change}}
 function checkAfter(run:StoredRun,change:StoredChange){const current=observe(run.path,change.path);if(!sameContent(current,change.after)||(current.kind==='file'&&change.after.kind==='file'&&current.identity!==change.after.identity))throw Error('file_changed');if(change.after.kind!=='unknown')checkChain(run.path,change.after.chain);return current}
 async function apply(op:StoredOperation,run:StoredRun,change:StoredChange){
  // No await between the final observation and effect. CC's reservation is not an OS-level CAS.
  checkAfter(run,change);checkChain(run.path,op.chain)
  const target=join(run.path,change.path)
  if(change.before.kind==='absent'){
   op.effectReady=true;op.receipt.state='applying';store.putOperation(op);checkAfter(run,change);unlinkSync(target);syncDirectory(dirname(target))
  }else if(change.before.kind==='file'){
   const bytes=loadBlob(blobRoot,change.before.blobSha,run.blobRootIdentity),temporaryPath=join(dirname(change.path),`.cc-workbench-restore-${op.receipt.operationId}.tmp`)
   if(op.temporaryPath&&op.temporaryPath!==temporaryPath)throw Error('temporary_identity_changed')
   let existing=false
   if(op.temporaryPath){try{const st=lstatSync(join(run.path,temporaryPath));existing=true;if(!op.temporaryIdentity||`${st.dev}:${st.ino}`!==op.temporaryIdentity||!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size!==bytes.length||(st.mode&0o777)!==change.before.mode)throw Error('temporary_identity_changed');const saved=readFileSync(join(run.path,temporaryPath));if(digest(saved)!==change.before.blobSha)throw Error('temporary_content_changed')}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;if(op.temporaryIdentity)throw Error('temporary_missing')}}
   if(!existing){op.temporaryPath=temporaryPath;store.putOperation(op)
    const fd=openSync(join(run.path,temporaryPath),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)
    try{let offset=0;while(offset<bytes.length)offset+=writeSync(fd,bytes,offset,bytes.length-offset);fchmodSync(fd,change.before.mode);fsyncSync(fd);const s=fstatSync(fd);op.temporaryIdentity=`${s.dev}:${s.ino}`}finally{closeSync(fd)}
   }
   syncDirectory(dirname(target));op.effectReady=true;op.receipt.state='applying';store.putOperation(op);checkAfter(run,change);checkChain(run.path,op.chain)
   if(change.after.kind==='absent'){linkSync(join(run.path,temporaryPath),target);unlinkSync(join(run.path,temporaryPath))}else renameSync(join(run.path,temporaryPath),target)
   syncDirectory(dirname(target))
  }else throw Error('snapshot_unavailable')
  const current=observe(run.path,change.path);if(!sameContent(current,change.before)||(current.kind==='file'&&current.identity!==op.temporaryIdentity))throw Error('effect_not_verified')
  return finish(op,'reverted')
 }
 const manager={
  async begin(input:BeginRestore):Promise<RestoreRun>{
   if(!input.workspaceId||!input.taskId||!input.runId||!input.directoryIdentity||!input.path||resolve(input.path)!==input.path)throw Error('invalid_restore_begin')
   await assertWriterClosed(input.workspaceId)
   if(directoryId(input.path)!==input.directoryIdentity)throw Error('directory_identity_changed')
   const priorBlob=store.runs(input.workspaceId)[0]?.blobRootIdentity
   if(priorBlob)verifyBlobRoot(blobRoot,priorBlob)
   const blobRootIdentity=initializeBlobs(blobRoot,input.path)
   const run=store.atomic(()=>{if(blocked(input.workspaceId))throw Error('workspace_blocked');const prior=store.workspace(input.workspaceId);if(prior&&(prior.path!==input.path||prior.directoryIdentity!==input.directoryIdentity))throw Error('workspace_identity_changed');const generation=(prior?.generation??0)+1;store.putWorkspace({workspaceId:input.workspaceId,path:input.path,directoryIdentity:input.directoryIdentity,generation,invalid:0});const r:StoredRun={...input,blobRootIdentity,restoreRunId:randomUUID(),generation,startedAt:Date.now(),finishedAt:null,status:'active',artifactId:null,artifactSha256:null,changes:[]};store.insertRun(r);return r})
   try{run.before=await captureSnapshot(run.path,blobRoot,readGitState,run.blobRootIdentity)}catch(e){run.error=errorReason(e)}store.putRun(run);checkRoot(run);verifyBlobRoot(blobRoot,run.blobRootIdentity)
   return {restoreRunId:run.restoreRunId,workspaceId:run.workspaceId,taskId:run.taskId,runId:run.runId,generation:run.generation,startedAt:run.startedAt,finishedAt:run.finishedAt,status:run.status}
  },
  markClosing(id:string){const run=requireRun(id);if(run.status==='closed')return;run.status='closing';store.putRun(run)},
  markUncertain(id:string){const run=requireRun(id);if(run.status==='closed')return;run.status='uncertain';store.putRun(run)},
  async close(id:string):Promise<RestoreReview>{const original=requireRun(id);return withMutation(original.workspaceId,async()=>{
   await assertWriterClosed(original.workspaceId);const run=requireRun(id);if(run.status==='closed')return review(run)
   try{
    checkRoot(run);verifyBlobRoot(blobRoot,run.blobRootIdentity);run.after=await captureSnapshot(run.path,blobRoot,readGitState,run.blobRootIdentity);checkRoot(run)
    if(run.before){const allPaths=[...new Set([...run.before.candidates,...run.after.candidates])],paths=allPaths.slice(0,50_000);if(allPaths.length>50_000)run.after.notes.push('review_path_limit')
     for(const path of paths){const before=versionAt(run.before,path),after=versionAt(run.after,path);if(sameContent(before,after))continue
      let reason=before.kind==='unknown'?before.reason:after.kind==='unknown'?after.reason:undefined
      if(!reason&&(run.before.git.head!==run.after.git.head||(run.before.git.index[path]??null)!==(run.after.git.index[path]??null)||run.before.staged.includes(path)||run.after.staged.includes(path)))reason='git_state_changed'
      if(after.kind==='absent'){try{after.chain=parentChain(run.path,path)}catch{reason='parent_unavailable'}}
      run.changes.push({path,changeId:randomUUID(),before,after,...(reason?{reason}:{})})
     }
    }
   }catch(e){run.error=errorReason(e);run.changes=[]}
   run.status='closed';run.finishedAt=Date.now();store.atomic(()=>{store.putRun(run);for(const change of run.changes)store.setPathVersion(run.workspaceId,change.path,change.changeId)})
   return review(run)
  })},
  bindArtifact(id:string,artifactId:string,artifactSha256:string){const run=requireRun(id);if(run.status!=='closed'||!artifactId||!/^[a-f0-9]{64}$/.test(artifactSha256))throw Error('invalid_restore_artifact');if(run.artifactId&&(run.artifactId!==artifactId||run.artifactSha256!==artifactSha256))throw Error('artifact_conflict');run.artifactId=artifactId;run.artifactSha256=artifactSha256;store.putRun(run)},
  list:(workspaceId:string)=>store.runs(workspaceId).map(review),blocked,
  async revert(input:RevertFile):Promise<RestoreOperation>{
   if(!safeRelative(input.path)||!input.requestId||!input.taskId||!input.artifactId||!input.changeId)throw Error('invalid_restore_request')
   const inputHash=digest(JSON.stringify([input.workspaceId,input.taskId,input.artifactId,input.path,input.changeId,input.requestId]))
   return withMutation(input.workspaceId,async()=>{
    const previous=store.findRequest(input.workspaceId,input.requestId);if(previous){if(previous.inputHash!==inputHash)throw Error('request_conflict');return {...previous.receipt}}
    if(blocked(input.workspaceId))throw Error('workspace_blocked');await assertWriterClosed(input.workspaceId)
    const run=store.runs(input.workspaceId).find(r=>r.taskId===input.taskId&&r.artifactId===input.artifactId),change=run?.changes.find(c=>c.path===input.path&&c.changeId===input.changeId)
    if(!run||!change)throw Error('restore_not_found');checkVersion(run,change);await checkGit(run,change);blobs(run,change);checkAfter(run,change)
    const op:StoredOperation={receipt:{...input,operationId:randomUUID(),state:'prepared'},inputHash,restoreRunId:run.restoreRunId,generation:run.generation,chain:parentChain(run.path,input.path)}
    store.atomic(()=>{if(blocked(input.workspaceId))throw Error('workspace_blocked');checkVersion(run,change);store.insertOperation(op)})
    try{return await apply(op,run,change)}catch(e){needsRecovery(op,run,e);throw Error(errorReason(e))}
   })
  },
  async recover(workspaceId:string):Promise<void>{return withMutation(workspaceId,async()=>{
   for(const op of store.operations(workspaceId).filter(o=>!terminal(o.receipt.state))){const run=requireRun(op.restoreRunId)
    try{
     const {change}=await verifyOperation(op),current=observe(run.path,op.receipt.path)
     if(sameContent(current,change.before)&&op.effectReady){
      if(current.kind==='file'&&(!op.temporaryIdentity||current.identity!==op.temporaryIdentity))throw Error('effect_identity_changed')
      finish(op,'reverted')
     }else if(sameContent(current,change.after)){
      await apply(op,run,change)
     }else throw Error('file_changed')
    }catch(e){needsRecovery(op,run,e)}
   }
  })},
  async resolveKeepCurrent(input:{workspaceId:string;taskId:string;operationId:string;observedFingerprint:string}):Promise<RestoreOperation>{return withMutation(input.workspaceId,async()=>{
   const op=store.operation(input.operationId);if(!op||op.receipt.workspaceId!==input.workspaceId||op.receipt.taskId!==input.taskId)throw Error('operation_not_found');if(op.receipt.state==='resolved_keep_current')return {...op.receipt};if(op.receipt.state!=='needs_recovery')throw Error('operation_not_resolvable')
   await assertWriterClosed(input.workspaceId);const run=requireRun(op.restoreRunId)
   if(!input.observedFingerprint||op.receipt.observedFingerprint!==input.observedFingerprint||observedFingerprint(run,op.receipt.path)!==input.observedFingerprint)throw Error('observation_changed')
   if(store.workspace(run.workspaceId)?.generation!==op.generation||store.pathVersion(run.workspaceId,op.receipt.path)!==op.receipt.changeId)throw Error('stale_change')
   // Root invalidity remains durable even when the user resolves this operation's receipt.
   try{checkRoot(run)}catch{const w=store.workspace(run.workspaceId);if(w){w.invalid=1;store.putWorkspace(w)}}
   return finish(op,'resolved_keep_current')
  })},
 }
 return manager
}
