/**
 * review 域:逐文件标记(接受 / 打回)与「打回 = 续接要求 + 标记」。
 * 从 service.ts 逐字搬来(spec 2026-09-27-workbench-service-split §3 第 1 项);只认 ctx,
 * 续接与投递走 ctx.actions 晚绑定。
 */
import { randomUUID } from 'node:crypto'
import { readArtifactSnapshot } from '../artifacts'
import { GIT_REVIEW_MIME, reverseApplyDiff, type GitReview, type ReviewFile } from '../git-review'
import { closeSync, constants, fsyncSync, lstatSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { openAnchored, verifyChain } from '../anchored-fs'
import { readAnchoredRegular } from '../artifacts'
import { pathsConflict } from '../scheduler'
import { normalizeInputRequestId, type LiveInput } from '../live-inputs'
import { composeReturnText, derivedReturnRequestId, parseGitReviewSnapshot, type ReviewTurn } from '../review'
import type { ReviewMark } from '../review-marks'
import type { ServiceCtx } from './ctx'
import type { WorkbenchTaskView } from './types'

export interface ReviewDomain {
  reviewList(id:string):ReviewTurn[]
  markReviewFile(id:string,input:{artifactId:string;path:string;mark:'accepted'|'returned';comment?:string}):ReviewMark
  returnReviewFiles(id:string,input:{artifactId:string;paths:string[];comment:string;inputRequestId?:string;restartToken?:string}):WorkbenchTaskView|Promise<LiveInput>
  /** 把一个文件恢复成这一轮开始前的样子(2026-10-06,对标 Codex 的逐文件撤销)。见实现处的门。 */
  revertReviewFile(id:string,input:{artifactId:string;path:string}):{path:string;restored:'content'|'removed'}
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
    reviewList(id:string):ReviewTurn[] {
      store.get(id)
      const marks=new Map<string,ReviewMark>()
      for(const mark of store.reviewMarks.list(id))marks.set(`${mark.artifactSha256}\0${mark.path}`,mark)
      return store.artifacts(id).filter(a=>a.mime===GIT_REVIEW_MIME).map(a=>{
        const head={artifactId:a.id,sha256:a.sha256,name:a.name,createdAt:a.createdAt}
        const review=readReviewSnapshot(a)
        if(!review)return {...head,status:'unavailable' as const,headBefore:null,headAfter:null,preexistingPaths:[],notes:['快照无法读取或已损坏'],files:[]}
        return {...head,status:review.status,headBefore:review.headBefore,headAfter:review.headAfter,preexistingPaths:review.preexistingPaths,notes:review.notes,
          files:review.files.map(file=>{
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
      const task=store.get(id)
      const {review}=reviewTarget(id,input.artifactId)
      const file=markableFile(review,input.path)
      if(!file.diff)throw new Error('review_revert_unavailable')
      if(task.error==='writer_not_closed')throw new Error('workbench_busy')
      for(const holder of [...ctx.state.reservations.values(),...ctx.state.writerOrphans.values()])if(pathsConflict(holder.path,task.path))throw new Error('workbench_busy')
      const parts=file.path.split('/')
      const fail='review_revert_unavailable'
      const sha=(text:string)=>createHash('sha256').update(text).digest('hex')
      let current:string|null=null,mode=0o644
      try {
        const st=lstatSync(join(task.path,file.path))
        if(!st.isFile())throw new Error(fail)
        mode=st.mode&0o777
        current=readAnchoredRegular(task.path,file.path).toString('utf8')
      } catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error(error instanceof Error&&error.message===fail?fail:'review_file_changed') }
      if(file.kind==='deleted'?current!==null:current===null||!file.afterSha256||sha(current)!==file.afterSha256)throw new Error('review_file_changed')
      const before=reverseApplyDiff(current??'',file.diff)
      if(before===null)throw new Error('review_file_changed')
      verifyChain(task.path,parts.slice(0,-1),fail,{leafDirectory:true})
      if(file.kind==='added') {
        if(before!=='')throw new Error(fail)
        verifyChain(task.path,parts,fail)
        unlinkSync(join(task.path,file.path))
      } else {
        if(!file.beforeSha256||sha(before)!==file.beforeSha256)throw new Error(fail)
        const tmpParts=[...parts.slice(0,-1),`.${parts.at(-1)}.cc-revert-${randomUUID().slice(0,8)}`]
        const fd=openAnchored(task.path,tmpParts,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,mode,fail)
        try { const bytes=Buffer.from(before,'utf8'); let at=0; while(at<bytes.length)at+=writeSync(fd,bytes,at); fsyncSync(fd) } finally { closeSync(fd) }
        try { verifyChain(task.path,parts.slice(0,-1),fail,{leafDirectory:true}); renameSync(join(task.path,...tmpParts),join(task.path,...parts)) }
        catch(error) { try{unlinkSync(join(task.path,...tmpParts))}catch{ /* best-effort */ }; throw error }
      }
      store.addEvent(id,'system',file.kind==='added'?`已撤销 ${file.path}：这一轮新建的文件已删除。`:`已撤销 ${file.path} 的改动，恢复成这一轮开始前的内容。`)
      ctx.hub.touched(id)
      return {path:file.path,restored:file.kind==='added'?'removed' as const:'content' as const}
    },
  }
}
