import {GIT_REVIEW_MIME} from '../git-review'
import {stepPayload,timelineKind} from '../../../adapters/store/workbench/store'
import type {ServiceCtx} from './ctx'
import type {Active} from './state'

/** Same completion boundary as output snapshots. Only metadata enters the ledger. */
export function finishLedger(ctx:ServiceCtx,running:Active,status:string):void {
  const {store}=ctx,id=running.taskId
  const replies=store.steps(id).filter(s=>timelineKind(s)==='text'&&stepPayload(s).runId===running.identity)
  const reply=replies.at(-1);const meta=running.ledgerArtifact
  const since=store.execution.run(id,running.identity)?.createdAt??Infinity
  const outputs=store.artifacts(id).filter(a=>a.mime!==GIT_REVIEW_MIME&&a.createdAt>=since).map(a=>`.cc-workbench/${id}/${a.name}`)
  const files=[...new Set([...(meta?.files??[]),...outputs])]
  store.ledger.artifact(id,running.identity,running.task.providerId,{workspace:running.path,fileCount:meta||outputs.length?files.length:null,files,commit:meta?.commit??null})
  store.ledger.finish(id,running.identity,status,reply?stepPayload(reply).text:'',running.turn?.id)
}

