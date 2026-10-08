/**
 * review 域:逐文件标记(接受 / 打回)与「打回 = 续接要求 + 标记」。
 * 从 service.ts 逐字搬来(spec 2026-09-27-workbench-service-split §3 第 1 项);只认 ctx,
 * 续接与投递走 ctx.actions 晚绑定。
 */
import { randomUUID } from 'node:crypto'
import { saveArtifactSnapshot,readArtifactSnapshot } from '../artifacts'
import { GIT_REVIEW_MIME, type GitReview, type ReviewFile } from '../git-review'
import { normalizeInputRequestId, type LiveInput } from '../live-inputs'
import { composeReturnText, derivedReturnRequestId, parseGitReviewSnapshot, type ReviewTurn } from '../review'
import type { ReviewMark } from '../review-marks'
import type { ServiceCtx } from './ctx'
import type { WorkbenchTaskView } from './types'

export interface ReviewDomain {
  resolveReviewRevert(id:string,input:{operationId:string;observedFingerprint:string}):Promise<import('../restore-manager').RestoreOperation>
  exportWorkspace(id:string):Promise<import('../store').Artifact>
  reviewList(id:string):ReviewTurn[]
  markReviewFile(id:string,input:{artifactId:string;path:string;mark:'accepted'|'returned';comment?:string}):ReviewMark
  returnReviewFiles(id:string,input:{artifactId:string;paths:string[];comment:string;inputRequestId?:string;restartToken?:string}):WorkbenchTaskView|Promise<LiveInput>
  /** 把一个文件恢复成这一轮开始前的样子(2026-10-06,对标 Codex 的逐文件撤销)。见实现处的门。 */
  revertReviewFile(id:string,input:{artifactId:string;path:string;changeId?:string;requestId?:string}):Promise<import('../restore-manager').RestoreOperation>
}

export function makeReviewDomain(ctx:ServiceCtx):ReviewDomain {
  const { store } = ctx
  /** 一件成果 ⇒ 它装的变更快照;不是 review mime、读不出、解析不出都是 null(坏快照不抛,由调用方标 unavailable)。 */
  function readReviewSnapshot(artifact:{mime:string;storagePath:string;sha256:string}):GitReview|null {
    if(artifact.mime!==GIT_REVIEW_MIME)return null
    try{return parseGitReviewSnapshot(readArtifactSnapshot(artifact.storagePath,ctx.stateDir,artifact.sha256))}catch{return null}
  }
  /** 标记的落点:成果必须属于该任务(否则 store.artifact 抛 not_found)且真是一份读得出的快照。 */
  function reviewTarget(id:string,artifactId:string) {
    const artifact=store.artifact(id,artifactId)
    const review=readReviewSnapshot(artifact)
    if(!review)throw new Error('invalid_review_reference')
    return {artifact,review}
  }
  function reviewComment(value:unknown,required:boolean):string {
    if(value===undefined&&!required)return ''
    if(typeof value!=='string'||value.length>2000)throw new Error('invalid_review_reference')
    const comment=value.trim()
    if(required&&!comment)throw new Error('invalid_review_reference')
    return comment
  }
  /** 门控:路径要在这份快照里,且不是「没展开」的那种 —— 没看过的文件不能说接受或打回。 */
  function markableFile(review:GitReview,path:string):ReviewFile {
    const file=review.files.find(candidate=>candidate.path===path)
    if(!file)throw new Error('invalid_review_reference')
    if(file.kind==='not_reviewed')throw new Error('review_file_unmarkable')
    return file
  }

  return {
    async resolveReviewRevert(id,input){
      const {w}=ctx.recovery!.owned(id)
      normalizeInputRequestId(input.operationId)
      if(!/^[a-f0-9]{64}$/.test(input.observedFingerprint))throw Error('invalid_request')
      const operation=await ctx.recovery!.manager.resolveKeepCurrent({workspaceId:w.id,taskId:id,...input})
      ctx.hub.touched(id);return operation
    },
    async exportWorkspace(id){
      const {w}=ctx.recovery!.owned(id)
      return ctx.recovery!.withMutation(w.id,async()=>{
        if(ctx.recovery!.manager.blocked(w.id))throw Error('workspace_blocked')
        const exported=await ctx.recovery!.git().exportPatch(w)
        const name=`workspace-${randomUUID()}.patch`
        store.atomic(()=>{saveArtifactSnapshot(store,id,{name,mime:'text/x-patch',bytes:exported.bytes},ctx.stateDir);store.addEvent(id,'system',JSON.stringify({type:'workspace_export',sha256:exported.sha256,excluded:exported.excluded}))})
        ctx.hub.touched(id)
        const {storagePath:_storage,...artifact}=store.artifacts(id).find(a=>a.name===name)!
        return artifact
      })
    },
    reviewList(id:string):ReviewTurn[] {
      store.get(id)
      const workspace=store.gitWorkspaceForTask(id)
      const blockReason=workspace?(workspace.removedAt?'worktree_removed':ctx.recovery?.blockReason(workspace.id)):undefined
      const restores=workspace?ctx.recovery?.manager.list(workspace.id)??[]:[]
      const marks=new Map<string,ReviewMark>()
      for(const mark of store.reviewMarks.list(id))marks.set(`${mark.artifactSha256}\0${mark.path}`,mark)
      return store.artifacts(id).filter(a=>a.mime===GIT_REVIEW_MIME).map(a=>{
        const head={artifactId:a.id,sha256:a.sha256,name:a.name,createdAt:a.createdAt}
        const restore=restores.find(r=>r.taskId===id&&r.artifactId===a.id)
        const review=readReviewSnapshot(a)
        if(!review)return {...head,status:'unavailable' as const,headBefore:null,headAfter:null,preexistingPaths:[],notes:['快照无法读取或已损坏'],files:[]}
        return {...head,...(restore?{restore:{runId:restore.restoreRunId,scope:'closed_session' as const,startedAt:restore.startedAt,finishedAt:restore.finishedAt!}}:{}),status:review.status,headBefore:review.headBefore,headAfter:review.headAfter,preexistingPaths:review.preexistingPaths,notes:review.notes,
          files:review.files.map(file=>{
            const found=restore?.files.find(f=>f.path===file.path)
            const revert=found?.state==='available'&&blockReason?{...found,state:'blocked' as const,reason:blockReason}:found
            if(revert)file={...file,revert} as ReviewFile
            const mark=marks.get(`${a.sha256}\0${file.path}`)
            return mark?{...file,mark:{mark:mark.mark,comment:mark.comment,createdAt:mark.createdAt}}:{...file}
          })}
      })
    },
    markReviewFile(id:string,input:{artifactId:string;path:string;mark:'accepted'|'returned';comment?:string}):ReviewMark {
      if(input.mark!=='accepted'&&input.mark!=='returned')throw new Error('invalid_request')
      const comment=reviewComment(input.comment,false)
      const {artifact,review}=reviewTarget(id,input.artifactId)
      const file=markableFile(review,input.path)
      const mark=store.reviewMarks.set({taskId:id,artifactSha256:artifact.sha256,path:file.path,afterSha256:file.afterSha256??null,mark:input.mark,comment})
      ctx.hub.touched(id)
      return mark
    },
    /**
     * 打回 = 把「哪几处、为什么、当时长什么样」组成一段续接要求 + 逐文件标 `returned`。
     * 按会话状态分路(评审 2026-09-21 #7):**会话还留着且已答复** ⇒ 走 `submitInput` 投给同一条
     * 会话(和主人自己在输入框里补一句话同一条路),回的是一张投递回执;`continueTask` 对任何还在
     * `runsByTask` 的任务一律 `workbench_busy`,照旧走它的话保留会话(Claude)答复后永远送不到。
     * **还在写** ⇒ `workbench_busy`(回合中间不能打回)。**已经结算** ⇒ `continueTask` 照旧:
     * 那道门(忙 / 归档 / 免审未确认 / 要不要重开都由它判)错误码原样透传。
     * 标记**在续接成功之后**才落:`restart_confirmation_required` 是设计内的首次回应(桌面要靠它拿
     * 重开令牌),`workbench_busy` 是常见的抢跑 —— 先落标记会让主人常态化看到「已打回」却根本没发出去。
     * 原会话不能恢复时,主人确认后带上 `restartToken` 再发一次(校验交给 continueTask,和「继续」同一道门),
     * 打回就不再是死胡同。
     * 重发同一个 inputRequestId 时 continueTask 走幂等分支,再写一遍同样的标记无妨。
     */
    returnReviewFiles(id:string,input:{artifactId:string;paths:string[];comment:string;inputRequestId?:string;restartToken?:string}):WorkbenchTaskView|Promise<LiveInput> {
      if(!Array.isArray(input.paths)||!input.paths.length||input.paths.length>20||input.paths.some(path=>typeof path!=='string'||!path))throw new Error('invalid_review_reference')
      const comment=reviewComment(input.comment,true)
      // 请求 id 先验,免得为一个畸形请求留下标记。
      const given=input.inputRequestId===undefined?undefined:normalizeInputRequestId(input.inputRequestId)
      const {artifact,review}=reviewTarget(id,input.artifactId)
      // 重发同一笔打回要落到幂等分支,所以文本必须可重现:去重**排序** + 同一句意见 ⇒ 同一段文本。
      // 排序是为了跟派生 id 对齐 —— id 不看顺序,文本要是看,换个勾选顺序重发就会撞 `input_conflict`。
      const files=[...new Set(input.paths)].sort().map(path=>markableFile(review,path))
      const text=composeReturnText(files.map(({path,diff})=>({path,diff})),comment)
      const marks=()=>{
        for(const file of files)store.reviewMarks.set({taskId:id,artifactSha256:artifact.sha256,path:file.path,afterSha256:file.afterSha256??null,mark:'returned',comment})
        ctx.hub.touched(id)
      }
      const running=ctx.state.runsByTask.get(id)
      if(running){
        // 回合中间打回 = 抢跑:这一轮还在写,等它答复(桌面/微信都会把这句话如实转给主人)。
        if(!ctx.actions.deref('review').isReplied(running))throw new Error('workbench_busy')
        // 请求 id 没给就从这笔打回本身派生:重发落 liveInputs 的幂等分支,不会投第二遍。
        // 把 run 的 identity 也算进去:会话重开之后这是另一次投递,不然会撞上一条 run 那笔 liveInput。
        const requestId=given??derivedReturnRequestId(artifact.sha256,files.map(file=>file.path),comment,running.identity)
        // 标记仍在拿到回执之后才落:投不出去就不该让主人看到「已打回」。
        return ctx.actions.deref('review').submitInput(id,{runId:running.identity,requestId,text}).then(receipt=>{marks();return receipt})
      }
      const task=ctx.actions.deref('review').continueTask(id,text,{inputRequestId:given??randomUUID(),...(input.restartToken!==undefined?{restartToken:input.restartToken}:{})})
      marks()
      return task
    },
    async revertReviewFile(id:string,input:{artifactId:string;path:string;changeId?:string;requestId?:string}) {
      if(!input.changeId||!input.requestId)throw Error('review_revert_unavailable')
      normalizeInputRequestId(input.changeId);normalizeInputRequestId(input.requestId)
      const {w}=ctx.recovery!.owned(id)
      reviewTarget(id,input.artifactId)
      const request={workspaceId:w.id,taskId:id,artifactId:input.artifactId,path:input.path,changeId:input.changeId,requestId:input.requestId}
      const prior=ctx.recovery!.manager.lookupRevert(request)
      if(prior)return prior
      const operation=await ctx.recovery!.manager.revert(request)
      ctx.hub.touched(id)
      return operation
    },
  }
}
