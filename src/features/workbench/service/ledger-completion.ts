import {GIT_REVIEW_MIME,type GitReview} from '../git-review'
import {readArtifactSnapshot} from '../../../adapters/workbench/artifacts'
import {stepPayload,timelineKind} from '../../../adapters/store/workbench/store'
import type {ServiceCtx} from './ctx'
import type {Active} from './state'

/** A baton can span several dispatch runs. Keep every frozen output and review pointer. */
function batonArtifacts(ctx:ServiceCtx,id:string,since:number,latest?:Active['ledgerArtifact']){
  const artifacts=ctx.store.artifacts(id).filter(a=>a.createdAt>=since)
  const files=new Set<string>();let commit:string|null=null,known=false
  // Store order is newest first. Consume every report oldest first so the final commit is latest.
  for(const a of artifacts.filter(a=>a.mime===GIT_REVIEW_MIME).reverse())try{
    const report=JSON.parse(readArtifactSnapshot(a.storagePath,ctx.stateDir,a.sha256).toString()) as GitReview
    for(const f of report.files)files.add(f.path)
    commit=report.headAfter;known=true
  }catch{/* Only metadata from verified snapshots is used; unavailable data is explicit below. */}
  if(latest){for(const file of latest.files)files.add(file);commit=latest.commit??commit;known=true}
  for(const a of artifacts.filter(a=>a.mime!==GIT_REVIEW_MIME)){files.add(`.cc-workbench/${id}/${a.name}`);known=true}
  return {files:[...files],fileCount:known?files.size:null,commit}
}

/** Same completion boundary as output snapshots. Only metadata enters the ledger. */
export function finishLedger(ctx:ServiceCtx,running:Active,status:string):void {
  const {store}=ctx,id=running.taskId
  if(!store.ledger.enabled(id))return
  const baton=running.ledgerRunId??running.identity
  const replies=store.steps(id).filter(s=>timelineKind(s)==='text'&&stepPayload(s).runId===running.identity)
  const reply=replies.at(-1)
  const since=store.execution.run(id,baton)?.createdAt??Infinity
  store.ledger.artifact(id,baton,running.task.providerId,{workspace:running.path,...batonArtifacts(ctx,id,since,running.ledgerArtifact)})
  store.ledger.finish(id,baton,status,reply?stepPayload(reply).text:'',running.turn?.id)
}

/** First handoff only: derive the first baton from existing task records, never its transcript. */
export function seedLedger(ctx:ServiceCtx,task:Active['task'],prior?:Active):void {
  const {store}=ctx,id=task.id,run=store.execution.last(id)
  if(!run)throw Error('matter_session_ended')
  const steps=store.steps(id),first=steps.find(s=>timelineKind(s)==='user')
  store.ledger.start(id,run.runId,task.providerId,first?stepPayload(first).text:task.title)
  const reply=steps.filter(s=>timelineKind(s)==='text').at(-1)
  store.ledger.artifact(id,run.runId,task.providerId,{workspace:task.path,...batonArtifacts(ctx,id,0,prior?.ledgerArtifact)})
  store.ledger.finish(id,run.runId,task.status,reply?stepPayload(reply).text:'')
}
