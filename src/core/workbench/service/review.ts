/**
 * review 域:逐文件标记(接受 / 打回)与「打回 = 续接要求 + 标记」;行评论与按块撤回(service/review-lines.ts)。
 * 从 service.ts 逐字搬来(spec 2026-09-27-workbench-service-split §3 第 1 项);只认 ctx,
 * 续接与投递走 ctx.actions 晚绑定。
 */
import { randomUUID } from 'node:crypto'
import { readArtifactSnapshot } from '../artifacts'
import { GIT_REVIEW_MIME, reverseApplyDiff, type GitReview, type ReviewFile } from '../git-review'
import { unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { verifyChain } from '../anchored-fs'
import { pathsConflict } from '../scheduler'
import { normalizeInputRequestId, type LiveInput } from '../live-inputs'
import { composeReturnText, derivedReturnRequestId, parseGitReviewSnapshot, type ReviewTurn } from '../review'
import type { ReviewMark } from '../review-marks'
import type { ServiceCtx } from './ctx'
import type { WorkbenchTaskView } from './types'
import { fileRisk } from '../review-risk'
import { checkpointRefSet } from '../rewind'
import { commentView, hunkViews, laterTouchLookup, revertedLookup } from '../review-annotations'
import type { ReviewComment } from '../review-comments'
import { parseHunks, switchHunks, type Hunk } from '../review-hunks'
import { assertNotRewindBlocked } from '../rewind-store'
import type { ScriptsDomain } from './scripts'
import type { UntilDomain } from './until'
import { makeReviewLines, MERGED_NOTE, type HunkActionInput, type HunkActionResult, type ReviewCommentInput, type ReviewCommentResult, type SendCommentsResult } from './review-lines'
import { atomicReplace, readCurrentText } from './review-write'

export interface ReviewDomain {
  reviewList(id:string):ReviewTurn[]
  markReviewFile(id:string,input:{artifactId:string;path:string;mark:'accepted'|'returned';comment?:string}):ReviewMark
  returnReviewFiles(id:string,input:{artifactId:string;paths:string[];comment:string;inputRequestId?:string;restartToken?:string}):WorkbenchTaskView|Promise<LiveInput>
  /** 把一个文件恢复成这一轮开始前的样子(2026-10-06,对标 Codex 的逐文件撤销)。见实现处的门。 */
  revertReviewFile(id:string,input:{artifactId:string;path:string}):{path:string;restored:'content'|'removed'}
  /** 行评论(v83):建 / 改 / 删草稿;锚点与引用由服务端从快照算。 */
  reviewComment(id:string,input:ReviewCommentInput):ReviewCommentResult
  /** 把草稿一起发给执行者(投递同打回);投递成功后才记已发出。 */
  sendReviewComments(id:string,input:{summary?:string;inputRequestId?:string;restartToken?:string}):SendCommentsResult|Promise<SendCommentsResult>
  /** 按块撤回 / 恢复一块改动(这件事有 run 就拒)。 */
  revertReviewHunk(id:string,input:HunkActionInput):HunkActionResult
}

export function makeReviewDomain(ctx:ServiceCtx,domains:{scripts:Pick<ScriptsDomain,'busy'>;until:Pick<UntilDomain,'checking'>}):ReviewDomain {
  const { store } = ctx
  /** 快照不可变 ⇒ (快照 sha, 路径) 的块解析结果可以一直缓存;有上限,满了丢最早的。 */
  const hunkCache=new Map<string,Hunk[]|null>()
  function hunksOf(artifactSha256:string,file:Pick<ReviewFile,'path'|'diff'>):Hunk[]|null {
    if(!file.diff)return null
    const key=`${artifactSha256}\0${file.path}`
    if(hunkCache.has(key))return hunkCache.get(key)!
    const hunks=parseHunks(file.diff)
    if(hunkCache.size>=512)hunkCache.delete(hunkCache.keys().next().value!)
    hunkCache.set(key,hunks)
    return hunks
  }
  /**
   * 撤回类写动作的门(整文件撤销与按块撤回共用):没确认退出 / 文件夹被占 ⇒ workbench_busy;
   * 回退停住 ⇒ rewind_needs_owner / workbench_busy;检查命令或工作区脚本在跑 ⇒ workbench_busy;
   * 工作区已删 ⇒ review_revert_unavailable。anyRun:这件事有 run(哪怕答复过)就拒。
   */
  function writeGate(id:string,anyRun:boolean):{root:string;merged:boolean} {
    const task=store.get(id)
    if(task.error==='writer_not_closed')throw new Error('workbench_busy')
    for(const holder of [...ctx.state.reservations.values(),...ctx.state.writerOrphans.values()])if(pathsConflict(holder.path,task.path))throw new Error('workbench_busy')
    assertNotRewindBlocked(store.rewinds,id)
    if(anyRun&&ctx.state.runsByTask.has(id))throw new Error('workbench_busy')
    if(domains.scripts.busy(id)||domains.until.checking(id))throw new Error('workbench_busy')
    const wt=store.worktrees.get(id)
    if(wt&&wt.removedAt!==null)throw new Error('review_revert_unavailable')
    return {root:task.path,merged:!!wt&&wt.mergedAt!==null}
  }
  /**
   * 续接投递的分路(打回与发评论共用):在写 ⇒ workbench_busy;答复过 ⇒ submitInput(请求 id 带上 run 的 identity);
   * 结束了 ⇒ continueTask(restart_confirmation_required 等原样透传)。done 只在投递成功之后调。
   */
  function deliver(id:string,text:string,ids:{given?:string;derive:(scope:string)=>string;continueId?:string;restartToken?:string},done:(requestId:string)=>void):WorkbenchTaskView|Promise<LiveInput> {
    const running=ctx.state.runsByTask.get(id)
    if(running){
      if(!ctx.actions.deref('review').isReplied(running))throw new Error('workbench_busy')
      const requestId=ids.given??ids.derive(running.identity)
      return ctx.actions.deref('review').submitInput(id,{runId:running.identity,requestId,text}).then(receipt=>{done(requestId);return receipt})
    }
    const requestId=ids.given??ids.continueId??ids.derive('continue')
    const task=ctx.actions.deref('review').continueTask(id,text,{inputRequestId:requestId,...(ids.restartToken!==undefined?{restartToken:ids.restartToken}:{})})
    done(requestId)
    return task
  }
  /** 一件成果 ⇒ 它装的变更快照;不是 review mime、读不出、解析不出都是 null(坏快照不抛,由调用方标 unavailable)。 */
  function readReviewSnapshot(artifact:{mime:string;storagePath:string;sha256:string}):GitReview|null {
    if(artifact.mime!==GIT_REVIEW_MIME)return null
    try{return parseGitReviewSnapshot(readArtifactSnapshot(artifact.storagePath,ctx.stateDir,artifact.sha256))}catch{return null}
  }
  /** 标记的落点:成果必须属于该任务(否则 store.artifact 抛 not_found)且真是一份读得出的快照。 */
  function reviewTarget(id:string,artifactId:string) {
    const artifact=store.artifact(id,artifactId)
    // 回退撤掉的轮:看得见,不能再标 / 打回 / 撤销(v81)
    if(store.rewinds.discarded(id).has(artifactId))throw new Error('review_round_discarded')
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

  const lines=makeReviewLines(ctx,{reviewTarget,markableFile,readReviewSnapshot,text:reviewComment,hunksOf,writeGate,deliver})

  return {
    reviewList(id:string):ReviewTurn[] {
      const task=store.get(id)
      const discarded=store.rewinds.discarded(id),wt=store.worktrees.get(id)
      // 独立工作区才有「可回退」;checkpoint ref 一次读全(读不了 ⇒ 都不可回退)
      const refs=wt&&wt.removedAt===null&&task.archivedAt===null?checkpointRefSet(wt.root,id):null
      const rewindable=(r:{checkpointBefore?:string;checkpointAfter?:string}|null,gone:boolean)=>wt?{rewindable:{start:!gone&&!!refs&&!!r?.checkpointBefore&&refs.has(r.checkpointBefore),end:!gone&&!!refs&&!!r?.checkpointAfter&&refs.has(r.checkpointAfter)}}:{}
      const marks=new Map<string,ReviewMark>()
      for(const mark of store.reviewMarks.list(id))marks.set(`${mark.artifactSha256}\0${mark.path}`,mark)
      // v83 行评论 / 按块撤回留痕(只读暴露);表不在(老测试只建了几张表)⇒ 当没有
      const comments=new Map<string,ReviewComment[]>()
      let reverted=revertedLookup([],0)
      try{
        for(const c of store.reviewComments.list(id)){const k=`${c.artifactId}\0${c.path}`;comments.set(k,[...comments.get(k)??[],c])}
        reverted=revertedLookup(store.reviewHunks.list(id),store.rewinds.latest(id)?.createdAt??0)
      }catch{/* 表不在 */}
      const turns=store.artifacts(id).filter(a=>a.mime===GIT_REVIEW_MIME).map(a=>({a,review:readReviewSnapshot(a)}))
      const later=laterTouchLookup([...turns].reverse().map(({a,review})=>({artifactId:a.id,discarded:discarded.has(a.id),paths:new Set(review?.files.map(f=>f.path)??[])})))
      return turns.map(({a,review})=>{
        const gone=discarded.has(a.id)
        const head={artifactId:a.id,sha256:a.sha256,name:a.name,createdAt:a.createdAt,...(gone?{discarded:true as const}:{})}
        if(!review)return {...head,status:'unavailable' as const,headBefore:null,headAfter:null,preexistingPaths:[],notes:['快照无法读取或已损坏'],files:[],...rewindable(null,gone)}
        return {...head,...rewindable(review,gone),status:review.status,headBefore:review.headBefore,headAfter:review.headAfter,preexistingPaths:review.preexistingPaths,notes:review.notes,
          files:review.files.map(file=>{
            const mark=marks.get(`${a.sha256}\0${file.path}`)
            const risk=fileRisk(file)
            const hunks=file.kind==='not_reviewed'?undefined:hunkViews(file.diff,reverted(a.sha256,file.path),()=>hunksOf(a.sha256,file))
            const notes=(comments.get(`${a.id}\0${file.path}`)??[]).filter(c=>c.artifactSha256===a.sha256).map(c=>commentView(c,later(a.id,file.path)))
            return {...file,...(mark?{mark:{mark:mark.mark,comment:mark.comment,createdAt:mark.createdAt}}:{}),...(risk.length?{risk}:{}),...(hunks?{hunks}:{}),...(notes.length?{comments:notes}:{})}
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
      // 回合中间打回 = 抢跑 ⇒ workbench_busy;请求 id 没给就从这笔打回本身派生(带上 run 的 identity:
      // 会话重开之后是另一次投递)。标记仍在投递成功之后才落:投不出去就不该让主人看到「已打回」。
      // 结束了的走 continueTask,没给 id 就随机一个(同改造前)。
      return deliver(id,text,{...(given?{given}:{}),derive:scope=>derivedReturnRequestId(artifact.sha256,files.map(file=>file.path),comment,scope),continueId:randomUUID(),...(input.restartToken!==undefined?{restartToken:input.restartToken}:{})},marks)
    },
    /**
     * 逐文件撤销(2026-10-06):把这个文件恢复成快照里「这一轮开始前」的内容。全部是拒绝条件,没有「尽量」:
     * - 文件夹还有会话占着(包括这件事自己留着的会话、没确认退出的那种)⇒ workbench_busy —— 执行者随时可能再写;
     * - 现在的内容和快照里「改完」的那份对不上(sha256)⇒ review_file_changed —— 之后又被改过,不替谁做合并;
     * - 倒推出来的内容和「改动前」的 sha256 对不上 ⇒ review_revert_unavailable(diff 被截断、二进制、只改了权限……);
     * - 要恢复的文件所在目录已经不在 ⇒ review_revert_unavailable(不替人建目录)。
     * 写法:同目录临时文件 → fsync → rename(保留原来的权限位);新增的文件撤销 = 删掉它。全程锚定、不跟链接。
     */
    revertReviewFile(id:string,input:{artifactId:string;path:string}) {
      if(typeof input.path!=='string'||!input.path)throw new Error('invalid_review_reference')
      store.get(id)
      const {artifact,review}=reviewTarget(id,input.artifactId)
      const file=markableFile(review,input.path)
      if(!file.diff)throw new Error('review_revert_unavailable')
      // 门(2026-10-21 补齐):占着 / 没确认退出照旧,另加回退停住、检查 / 脚本在跑、工作区已删
      const {root,merged}=writeGate(id,false)
      const parts=file.path.split('/')
      const fail='review_revert_unavailable'
      const sha=(text:string)=>createHash('sha256').update(text).digest('hex')
      const read=readCurrentText(root,file.path,fail)
      const current=read.text
      let mode=read.mode
      // 按块感知:modified 且 diff 切得开 ⇒ 盘上内容 = 「快照的 after 翻了几块」也能整文件撤(撤过几块之后照样能做)
      const hunks=file.kind==='modified'?hunksOf(artifact.sha256,file):null
      let before:string|null
      if(hunks&&current!==null&&file.afterSha256){
        let state:ReturnType<typeof lines.locate>
        try{state=lines.locate(current,hunks,file.afterSha256)}catch{throw new Error(fail)}
        // 对不上 / 每块都已经是旧的(撤过了)⇒ 同改造前:之后又被改过
        if(!state||state.every(s=>s==='old'))throw new Error('review_file_changed')
        try{before=switchHunks(current,hunks,state,hunks.map(()=>'old' as const))}catch{throw new Error(fail)}
      } else {
        if(file.kind==='deleted'?current!==null:current===null||!file.afterSha256||sha(current)!==file.afterSha256)throw new Error('review_file_changed')
        before=reverseApplyDiff(current??'',file.diff)
      }
      // 执行位按开始时还原(快照记了的话):删掉的脚本重建、或这一轮改过执行位的,都回到原样
      if(file.beforeExecutable!==undefined)mode=file.kind==='deleted'?(file.beforeExecutable?0o755:0o644):file.beforeExecutable?mode|((mode&0o444)>>2):mode&~0o111
      if(before===null)throw new Error('review_file_changed')
      verifyChain(root,parts.slice(0,-1),fail,{leafDirectory:true})
      if(file.kind==='added') {
        if(before!=='')throw new Error(fail)
        verifyChain(root,parts,fail)
        unlinkSync(join(root,file.path))
      } else {
        if(!file.beforeSha256||sha(before)!==file.beforeSha256)throw new Error(fail)
        atomicReplace(root,file.path,Buffer.from(before,'utf8'),mode,fail)
      }
      if(hunks)lines.logAllReverted(id,artifact.sha256,file.path,hunks)
      store.addEvent(id,'system',(file.kind==='added'?`已撤销 ${file.path}：这一轮新建的文件已删除。`:`已撤销 ${file.path} 的改动，恢复成这一轮开始前的内容。`)+(merged?`${MERGED_NOTE}。`:''))
      ctx.hub.touched(id)
      return {path:file.path,restored:file.kind==='added'?'removed' as const:'content' as const}
    },
    reviewComment:lines.reviewComment,
    sendReviewComments:lines.sendReviewComments,
    revertReviewHunk:lines.revertReviewHunk,
  }
}
