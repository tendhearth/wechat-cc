/** Durable writer boundaries and the shared file-mutation reservation. */
import {randomUUID} from 'node:crypto'
import {join} from 'node:path'
import {saveArtifactSnapshot} from '../artifacts'
import {GIT_REVIEW_MIME,serializeGitReview} from '../git-review'
import {pathsConflict,type PathReservation} from '../scheduler'
import type {StoredRun,RestoreOperation} from '../restore-store'
import type {ServiceCtx} from './ctx'
import type {Active} from './state'
import type {RecoveryDomain} from './types'
import {writerGroupsOf,groupAlive} from './writer-exit'

export function makeRecoveryDomain(ctx:ServiceCtx):RecoveryDomain{
 const {store,state}=ctx,restores=store.restores
 const git=()=>store.gitWorkspaceManager({root:join(ctx.deps.managedWorkspaceRoot??join(ctx.stateDir,'..','Tasks'),'GitWorkspaces'),stateDir:ctx.stateDir})
 function workspace(id:string,receiptOnly=false){const w=store.gitWorkspaces.get(id);if(!w)throw Error('restore_not_found');if(w.removedAt&&!receiptOnly)throw Error('worktree_removed');return w}
 function owned(taskId:string,receiptOnly=false){const task=store.get(taskId),w=task.gitWorkspaceId?workspace(task.gitWorkspaceId,receiptOnly):null;if(!w)throw Error('review_revert_unavailable');if(task.ownerChatId!==ctx.deps.ownerChatId()||w.ownerKey!==task.ownerChatId||w.executionPath!==task.path)throw Error('restore_not_found');return {task,w}}
 const holders=()=>[...state.reservations.values(),...state.writerOrphans.values(),...state.queue]
 function assertClosed(id:string,allowed?:PathReservation,runId?:string,quietCommit=false){
  const w=workspace(id)
  for(const h of holders())if(h.identity!==allowed?.identity&&pathsConflict(h.path,w.executionPath)&&!(allowed&&h.state==='queued'))throw Error('writer_not_closed')
  for(const r of restores.allRuns())if(pathsConflict(r.path,w.executionPath)&&r.status!=='closed'&&!(r.restoreRunId===runId&&(r.closeProof||quietCommit)))throw Error('writer_not_closed')
  if(!allowed&&store.pendingInputPaths().some(path=>pathsConflict(path,w.executionPath)))throw Error('writer_not_closed')
 }
 async function withMutation<T>(id:string,operation:()=>Promise<T>,allowed?:PathReservation,runId?:string,quietCommit=false):Promise<T>{
  if(!allowed||quietCommit)ctx.ensureAccepting()
  const w=workspace(id)
  if([...state.mutations.values()].some(m=>pathsConflict(m.path,w.executionPath)))throw Error('workspace_blocked')
  assertClosed(id,allowed,runId,quietCommit)
  const reservation:PathReservation={identity:randomUUID(),taskId:allowed?.taskId??id,title:'File operation',path:w.executionPath,order:++state.order,state:'active'}
  state.mutations.set(reservation.identity,reservation)
  const pending=(async()=>{try{return await operation()}finally{state.mutations.delete(reservation.identity)}})()
  const settlement=pending.then(()=>{},()=>{});state.collections.add(settlement)
  void settlement.then(()=>state.collections.delete(settlement))
  return pending
 }
 async function withCommit<T>(taskId:string,operation:()=>Promise<T>):Promise<T>{
  const {task,w}=owned(taskId),own=state.runsByTask.get(taskId)
  gate(task.path)
  if(restores.pending(w.id)||restores.workspace(w.id)?.invalid)throw Error('workspace_blocked')
  if(!own)return withMutation(w.id,operation)
  if(store.liveInputs.count(taskId))throw Error('writer_not_closed')
  if(own.finishing||own.uncertain||!ctx.actions.deref('workspace-commit').isReplied(own))throw Error('writer_not_closed')
  return withMutation(w.id,operation,own,own.restoreRunId,true)
 }
 function blockReason(workspaceId:string):string|undefined{
  const w=workspace(workspaceId)
  if([...state.mutations.values()].some(m=>pathsConflict(m.path,w.executionPath)))return 'workspace_blocked'
  try{assertClosed(workspaceId)}catch{return 'writer_not_closed'}
 }
 function committed(operation:Readonly<RestoreOperation>){store.addEvent(operation.taskId,'system',JSON.stringify({type:'workspace_restore',...operation}))}
 const manager=(allowed?:PathReservation,runId?:string,reserved=false)=>store.restoreManager({blobRoot:join(ctx.stateDir,'workbench-restore-blobs'),readGitState:path=>git().readGitState(path),withMutation:(id,fn)=>reserved?fn():withMutation(id,fn,allowed,runId),assertWriterClosed:id=>assertClosed(id,allowed,runId),onOperationCommitted:committed})
 const publicManager=manager()
 function registeredConflict(path:string){return store.gitWorkspaces.list().some(w=>!w.removedAt&&!!w.executionPath&&pathsConflict(w.executionPath,path))}
 function admit(path:string,gitWorkspaceId?:string|null){if(!gitWorkspaceId&&registeredConflict(path))throw Error('git_workspace_binding_required')}
 function captureWriters(){
  // Capture live legacy records before general restart cleanup erases their running status.
  for(const task of store.runningWriters())if(!task.gitWorkspaceId&&registeredConflict(task.path))store.update(task.id,task.status,'writer_not_closed')
 }
 function gate(path:string,own?:Active){
  if([...state.writerOrphans.values()].some(r=>registeredConflict(r.path)&&pathsConflict(r.path,path)))throw Error('writer_not_closed')
  if([...state.mutations.values()].some(m=>pathsConflict(m.path,path)))throw Error('workspace_blocked')
  for(const r of restores.allRuns())if(pathsConflict(r.path,path)){
   if(restores.pending(r.workspaceId)||restores.workspace(r.workspaceId)?.invalid)throw Error('workspace_blocked')
   if((r.status!=='closed'||!r.artifactId)&&!state.runsByTask.has(r.taskId))throw Error('writer_not_closed')
   if(r.status!=='closed'&&own?.restoreRunId===r.restoreRunId&&r.closeProof)throw Error('writer_not_closed')
  }
 }
 async function begin(running:Active){
  admit(running.path,running.task.gitWorkspaceId)
  if(!running.task.gitWorkspaceId)return
  gate(running.path,running)
  const w=workspace(running.task.gitWorkspaceId)
  await git().verify(w)
  if(w.executionPath!==running.path||w.executionIdentity!==running.directoryIdentity)throw Error('workspace_identity_changed')
  try{
   const r=await manager(running).begin({workspaceId:w.id,taskId:running.taskId,runId:running.identity,path:running.path,directoryIdentity:w.executionIdentity!})
   running.restoreRunId=r.restoreRunId
  }catch(error){running.restoreRunId=restores.runs(w.id).find(r=>r.runId===running.identity)?.restoreRunId;throw error}
 }
 function remember(running:Active){if(!running.restoreRunId)return;const r=restores.run(running.restoreRunId)!;r.writerGroups=[...new Set([...(r.writerGroups??[]),...writerGroupsOf(running)])];restores.putRun(r)}
 function mark(running:Active,status:'closing'|'uncertain'){if(!running.restoreRunId)return;remember(running);const r=restores.run(running.restoreRunId)!;if(r.status==='closed')return;r.status=status;restores.putRun(r)}
 async function finish(r:StoredRun,holder:PathReservation,kind:NonNullable<StoredRun['closeProof']>['kind']){
  const current=restores.run(r.restoreRunId)!
  const groups=current.writerGroups??[]
  if((kind==='groups_gone'||kind==='administrator')&&groups.some(g=>groupAlive(ctx,g)))throw Error('writer_alive')
  if(kind==='groups_gone'&&!groups.length)throw Error('writer_not_closed')
  current.closeProof??={kind,at:ctx.now(),groups};if(current.status!=='closed')current.status='closing';restores.putRun(current)
  await withMutation(current.workspaceId,async()=>{
  const m=manager(holder,current.restoreRunId,true)
  const review=await m.close(current.restoreRunId)
  if(!review.artifactId){
   store.atomic(()=>{saveArtifactSnapshot(store,current.taskId,{name:`会话改动-${current.restoreRunId}.json`,mime:GIT_REVIEW_MIME,bytes:serializeGitReview(review.review)},ctx.stateDir);const artifact=store.artifacts(current.taskId).find(a=>a.name===`会话改动-${current.restoreRunId}.json`)!;m.bindArtifact(current.restoreRunId,artifact.id,artifact.sha256)})
   ctx.hub.touched(current.taskId)
  }
  },holder,current.restoreRunId)
 }
 function close(running:Active,kind:NonNullable<StoredRun['closeProof']>['kind']='session_close'){
  if(!running.restoreRunId)return Promise.resolve()
  return running.restoreSettlement??=(async()=>{remember(running);await finish(restores.run(running.restoreRunId!)!,running,kind)})().catch(error=>{running.restoreSettlement=undefined;throw error})
 }
 async function confirmOrphan(taskId:string,kind:'groups_gone'|'administrator'){
  const rows=restores.allRuns().filter(r=>r.taskId===taskId&&(r.status!=='closed'||!r.artifactId))
  for(const r of rows){const holder=state.writerOrphans.get(taskId);if(!holder)throw Error('writer_not_closed');await finish(r,holder,kind)}
 }
 function adopt(){
  for(const hold of store.writerHolds())if(registeredConflict(hold.path))state.writerOrphans.set(hold.id,{identity:`legacy/${hold.id}`,taskId:hold.id,title:hold.title,path:hold.path,order:-1,state:'uncertain',groups:hold.groups??[]})
  for(const r of restores.allRuns())if(r.status!=='closed'||!r.artifactId){
   const t=store.get(r.taskId)
   state.writerOrphans.set(t.id,{identity:`restore/${r.restoreRunId}`,taskId:t.id,title:t.title,path:r.path,order:-1,state:'uncertain',groups:r.writerGroups??[]})
   store.update(t.id,'interrupted','writer_not_closed')
  }
 }
 async function recover(){
  // A durable close proof permits finishing an interrupted artifact bind, never inventing a new before.
  for(const r of restores.allRuns())if(r.closeProof&&(r.status!=='closed'||!r.artifactId)){
   const holder=state.writerOrphans.get(r.taskId)
   if(holder)try{await finish(r,holder,r.closeProof.kind);store.clearWriterError(r.taskId);state.writerOrphans.delete(r.taskId);ctx.hub.touched(r.taskId)}catch{/* keep the durable and in-memory barrier */}
  }
  // Orphan exit is settled by lifecycle's evidence checks. Journal recovery never bypasses it.
  for(const id of new Set(restores.allRuns().map(r=>r.workspaceId)))if(restores.pending(id)){
   try{await publicManager.recover(id);for(const r of restores.runs(id))ctx.hub.touched(r.taskId)}catch{/* durable barrier remains */}
  }
 }
 function facts(taskId:string){const w=store.gitWorkspaceForTask(taskId);if(!w)return '';const ops=restores.operations(w.id).filter(o=>o.receipt.state==='reverted'||o.receipt.state==='resolved_keep_current');return ops.length?'文件现场已在执行会话之间更新，请重新读取这些路径，不要沿用此前内容：\n'+ops.map(o=>JSON.stringify({path:o.receipt.path,state:o.receipt.state,operationId:o.receipt.operationId})).join('\n'):''}
 return {manager:publicManager,owned,git,admit,captureWriters,registeredConflict,gate,begin,remember,mark,close,confirmOrphan,adopt,recover,facts,withMutation,withCommit,blockReason}
}
