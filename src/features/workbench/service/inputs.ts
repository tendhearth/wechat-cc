/**
 * inputs 域:主人的补充 —— 排空(drain)一个内部动作,以及
 * submitInput / withdrawInput / resolveAnswer / resolvePermission 四个入口。
 * 从 service.ts 逐字搬来(spec 2026-09-27-workbench-service-split §3 第 8 项)。
 *
 * 依赖都在构造时显式传进来:lifecycle 的三个计时动作、admission / attachments / view 的查询,
 * 以及落库记账那三个(pending-inputs.ts)。以前 lifecycle 也要 holdInputs / hasUndeliveredInput,
 * 两头互相要只能晚绑定;那三个只认 ctx,搬出去之后这里只依赖 lifecycle,lifecycle 不依赖这里。
 * holdInputs / hasUndeliveredInput / settleRuntimeInput 仍从这里带出去(调用方看到的形状不变)。
 *
 * drainInputs 要 execute.start(把排队的补充当一轮新的派出去),而 execute 在这里之上 ——
 * 它只被 execute 收尾时调,所以由 execute 调下来时把 start 当参数带下来,不存成域的依赖。
 * autoContinueBlocked 在 state 上,与 execute 共享同一个 Set。
 */
import { canonicalProject } from '../../../adapters/workbench/artifacts'
import { takeBaselineFor } from './artifacts'
import { assertNotRewindBlocked } from '../../../adapters/store/workbench/rewind-store'
import { normalizeInputRequestId, sameAttachments, type LiveInput } from '../../../adapters/store/workbench/live-inputs'
import type { AgentExecutionChoice } from '../../../ports/agent-provider'
import type { StoredTask } from '../../../adapters/store/workbench/store'
import type { Attachment } from '../../../adapters/workbench/attachments'
import type { AcceptedNativeResume } from '../../../adapters/workbench/native-adoption'
import type { ArtifactSelection } from '../handoff'
import type { PermissionDecision } from '../../../adapters/workbench/permissions'
import { checkedText } from './checked-text'
import { directoryIdentity } from './directory-identity'
import type { ServiceCtx } from './ctx'
import type { AcceptedContinuation } from './state'
import type { InputMaterials, WorkbenchTaskView } from './types'
import type { AdmissionDomain } from './admission'
import type { AttachmentsDomain } from './attachments'
import type { ViewDomain } from './view'
import type { LifecycleDomain } from './lifecycle'
import type { PendingInputs } from './pending-inputs'
import { decideCall } from '../../../lib/network-gate'
import { liveRunTarget } from './call-target'

/** drainInputs 派发用的 start:签名是 execute.start 的前缀(这里用不到后两个参数)。 */
export type StartRun = (
  task:StoredTask,
  text:string,
  acceptedDirectoryIdentity:string,
  acceptedContinuation?:AcceptedContinuation,
  nativeResume?:AcceptedNativeResume,
  handoffArtifacts?:ArtifactSelection[],
  handoffId?:string,
  queuedInputId?:string,
  attachments?:Attachment[],
  draftId?:string,
  executionChoice?:AgentExecutionChoice,
) => WorkbenchTaskView

export interface InputsDomains {
  admission: Pick<AdmissionDomain,'continuation'|'requireInput'>
  attachments: Pick<AttachmentsDomain,'selectAttachments'|'continuationAttachmentScope'>
  view: Pick<ViewDomain,'inputMode'>
  lifecycle: Pick<LifecycleDomain,'armIdleClose'|'cancelIdleClose'|'settleAfterDecision'>
  pending: PendingInputs
}

export function makeInputsDomain(ctx:ServiceCtx, domains:InputsDomains) {
  const { store, state } = ctx
  const { continuation, requireInput } = domains.admission
  const { selectAttachments, continuationAttachmentScope } = domains.attachments
  const { inputMode } = domains.view
  const { armIdleClose, cancelIdleClose, settleAfterDecision } = domains.lifecycle
  const { holdInputs, hasUndeliveredInput, settleRuntimeInput } = domains.pending
  /** Read one durable receipt without loading a timeline or touching its task. */
  function inputReceipt(id:string,requestId:string):LiveInput|null {
    if(!/^[a-f0-9]{8}$/.test(id))throw Error('invalid_matter_id')
    const key=normalizeInputRequestId(requestId),owner=ctx.deps.ownerChatId()
    if(!owner)return null
    let task:ReturnType<typeof store.get>
    try{task=store.get(id)}catch(error){if(error instanceof Error&&error.message==='not_found')return null;throw error}
    // Matter/task are one-to-one. Check ownership and linkage before looking up
    // a globally unique request UUID, then reject any cross-task receipt.
    if(task.ownerChatId!==owner||store.taskMatterId(id)!==id)return null
    const input=store.liveInputs.get(key)
    return input?.id===key&&input.taskId===id?input:null
  }
  function drainInputs(id:string,expectedDirectoryIdentity:string,start:StartRun){
    if(state.autoContinueBlocked.has(id))return
    const next=store.liveInputs.next(id);if(!next)return
    try{
      const task=store.get(id),decision=continuation(task)
      if(decision.mode!=='resume')throw Error('原会话需要你确认恢复方式，补充尚未发送。')
      const path=canonicalProject(task.path);if(path!==task.path||directoryIdentity(path)!==expectedDirectoryIdentity)throw Error('invalid_path')
      store.liveInputs.set(next.id,'sending');ctx.hub.bumped(id)
      const execution=next.execution??store.execution.run(id,next.runId)?.choice??store.execution.choice(id)
      requireInput(task.providerId,next.attachments??[],execution,true)
      start(task,next.text,expectedDirectoryIdentity,{mode:'resume',sessionId:task.sessionId!},undefined,undefined,undefined,next.id,next.attachments,undefined,execution)
    }catch(error){holdInputs(id,error instanceof Error?error.message:'input_not_delivered')}
  }

  function resolveAnswer(id:string,requestId:string,answers:unknown){
    const running=state.runsByTask.get(id)
    if(!running||running.cancelled||running.finishing||!running.questions.resolve(requestId,answers))throw Error('question_stale')
    ctx.hub.bumped(id)
    // 回合早就静下来、只差这一个待决请求时,不会再有事件把落定叫起来 —— 拍完板自己补一次。
    settleAfterDecision(running)
  }
  function withdrawInput(id:string,requestId:string){
    const input=store.liveInputs.get(requestId)
    if(!input||input.taskId!==id||input.status!=='pending')throw Error('input_stale')
    store.liveInputs.set(requestId,'withdrawn')
    ctx.hub.bumped(id)
  }
  async function submitInput(id:string,input:{runId:string;requestId:string;text:string}&InputMaterials,attachmentPolicy?:'owner'){
    assertNotRewindBlocked(store.rewinds,id)   // 回退停住的事不收补充(评审 #433-4)
    ctx.ensureAccepting()
    if(Object.hasOwn(input,'execution'))throw Error('invalid_execution')
    const attachments=selectAttachments(input,id,attachmentPolicy),text=checkedText(input.text,attachments)
    if(state.autoContinueBlocked.has(id))throw Error('input_storage_unavailable')
    const requestId=normalizeInputRequestId(input.requestId)
    const prior=store.liveInputs.get(requestId)
    if(prior){if(prior.taskId!==id||prior.runId!==input.runId||prior.text!==text||!sameAttachments(prior.attachments,attachments))throw Error('input_conflict');return prior}
    const running=state.runsByTask.get(id)
    if(!running||running.identity!==input.runId||running.cancelled||running.finishing||running.uncertain)throw Error('input_stale')
    if(running.delivering)throw Error('input_delivery_busy')
    // 网络闸门(守护 v2):补充一投进去执行者就会调模型 —— 按**这条在用的会话实际连到的目标**判
    // (评审 #193:不是任务记录的模型、也不是此刻的配置);需要保护且不安全才不投。
    if(ctx.deps.networkGate&&!(await decideCall(ctx.deps.networkGate,liveRunTarget(running,ctx.deps.registry.get(running.task.providerId)?.provider))).allowed)throw Error('network_unprotected')
    if(store.liveInputs.count(id)>=10)throw Error('input_limit')
    requireInput(running.task.providerId,attachments,running.execution)
    // 一句补充就是一下互动:先把自动收工的计时取消掉,免得话在路上会话被关了。这一下要在
    // **入口**做,不能放进下面那个分支 —— `isReplied` 不看 `inputMode`,一条安静的运行若 runtime
    // 报 `input:'queue'`,补充会存下来等着,而计时还武装着:让位到点就把会话关了,主人收到的
    // 是「补充尚未发送」(评审 2026-09-21 修复轮 #1)。
    cancelIdleClose(running)
    if(running.session?.workbenchRuntime&&inputMode(running)!=='queue'){
      // 上一轮的快照还在截就等它截完,别把这一轮的改动算进上一轮。
      if(running.reviewCapture)await running.reviewCapture.catch(()=>{})
      // 续接 = 新一轮差异的起点:重新取基线。回合中间补一句话时上一轮还没截过快照
      // (基线还没被消费)—— 那一份要留着,起点提交不动,否则这条 run 的代码变更会丢。
      if(!running.reviewBaseline){try{running.reviewBaseline=await takeBaselineFor(ctx,running)}catch{/* 没基线就没有这一轮的代码对比,其他成果照收 */}}
      // 上面两处 await 可能等十几秒。这期间一轮自动续作可以正常收尾(新不变式下那是合法工作),
      // `settleQuiet` 就会重新武装让位计时;计时到点 `closeForIdle` 把会话收工、文件夹交给 B。
      // 所以醒过来必须把入口那道守卫再跑一遍,否则这句话会投给一条已经关掉的会话 —— 坏的那头是
      // 原生进程还没死,于是在一个正在移交的文件夹里开始写,两个写手同处一个目录。
      // (BASE 靠 `acquireTurnLease` 里的 `alive()` 挡这一下,那个函数这一轮删掉了。)
      if(state.runsByTask.get(id)!==running||running.cancelled||running.finishing||running.uncertain)throw Error('input_stale')
    }
    let saved:LiveInput
    try{
      saved=store.atomic(()=>{
        store.attachments.bind(attachments.map(a=>a.id),id,input.draftId,attachmentPolicy?continuationAttachmentScope(id,attachments):undefined)
        return store.liveInputs.add({id:requestId,taskId:id,runId:input.runId,text,attachments,execution:running.execution})
      })
    }catch(error){
      // 这一句没存下来就没有人会去写文件夹:会话还安静着,把自动收工的计时重新起上,
      // 别让一句存不下来的补充把文件夹永久锁住。
      armIdleClose(running)
      throw error
    }
    const runtime=running.session?.workbenchRuntime
    if(runtime){
      if(inputMode(running)==='queue')return saved
      store.liveInputs.set(saved.id,'sending');ctx.hub.bumped(id)
      ;(running.runtimeInputs??=new Map()).set(saved.id,saved)
      try{
        if(canonicalProject(running.path)!==running.path||directoryIdentity(running.path)!==running.directoryIdentity)throw Error('invalid_path')
        const material=store.attachments.prepare(id,attachments,running.path,ctx.stateDir)
        running.interactionAt=Date.now()
        // 主人续接 = 新一轮的可靠起点(评审修复轮 1):这个同步点不依赖快照观察,
        // 「投给 runtime 了」这件事本身就是新一轮开始的证据,回报去重键(reportOnce)
        // 靠它才不会因为快照从未被看见处于「忙碌」而永久锁死。
        running.turnSeq++
        // Replay acknowledgement may wait behind an autonomous native turn.
        // The HTTP receipt is already durable; never wait here or auto-resend.
        void runtime.submit(saved.id,text,material).then(
          ()=>settleRuntimeInput(running,saved),
          error=>{settleRuntimeInput(running,saved,error??new Error('input_not_delivered'));armIdleClose(running)},
        )
      }catch(error){settleRuntimeInput(running,saved,error??new Error('input_not_delivered'));armIdleClose(running)}
      return store.liveInputs.get(saved.id)!
    }
    if(!running.session?.steer)return saved
    running.delivering=true;store.liveInputs.set(saved.id,'sending');ctx.hub.bumped(id)
    try{
      if(canonicalProject(running.path)!==running.path||directoryIdentity(running.path)!==running.directoryIdentity)throw Error('invalid_path')
      const material=store.attachments.prepare(id,attachments,running.path,ctx.stateDir)
      await running.session.steer(text,material)
      running.interactionAt=Date.now()
      store.liveInputs.set(saved.id,'delivered');ctx.hub.bumped(id)
      store.addEvent(id,'user',text,null,running.identity,attachments);ctx.hub.touched(id)
    }catch(error){store.liveInputs.set(saved.id,'held',`未确认执行者收到，请检查当前对话后再决定是否重发。${error instanceof Error?' '+error.message:''}`);ctx.hub.bumped(id)}
    finally{running.delivering=false}
    return store.liveInputs.get(saved.id)!
  }
  function resolvePermission(id:string,requestId:string,decision:PermissionDecision):void {
    store.get(id)
    if (decision!=='allow' && decision!=='deny') throw new Error('invalid_decision')
    const running=state.runsByTask.get(id)
    if (!running || !running.permissions.resolve(requestId,decision)) throw new Error('permission_stale')
    ctx.hub.bumped(id)
    // 同 resolveAnswer:静默期里拍的板,得由拍板这一下把落定补上。
    settleAfterDecision(running)
  }

  return { inputReceipt,holdInputs,hasUndeliveredInput,drainInputs,settleRuntimeInput, submitInput,withdrawInput,resolveAnswer,resolvePermission }
}
export type InputsDomain = ReturnType<typeof makeInputsDomain>
