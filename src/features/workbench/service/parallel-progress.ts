import type {ServiceCtx} from './ctx'
import type {Active} from './state'

export function parallelProgress(ctx:ServiceCtx,running:Active,status:'running'|'waiting'){
  const {store}=ctx,member=store.plans.candidateForTask(running.taskId)
  if(!member?.runId||member.runId!==running.ledgerRunId||member.status===status||!['queued','running','waiting'].includes(member.status))return
  store.atomic(()=>{store.plans.progressCandidate(member.runId!,status);store.bump(member.matterId)})
  ctx.hub.bumped(member.matterId)
}
