/**
 * execute 域:一条 run 的完整生命周期(派发 → 事件流 → 结算 → 终态),以及创建入口 create / continueTask / createWechat。
 * 从 service.ts 逐字搬来(spec 2026-09-27-workbench-service-split §3 第 10 项);spec §4:execute 跨九个域是事实,不再往下切。
 * 跨域依赖用「已建好的域对象显式注入」(domains),工厂顶部解构成与 service.ts 同名的局部量,函数体只做机械替换(opts.x → ctx.deps.x、touched → ctx.hub.touched 等);
 * 真正需要晚绑定的只有 lifecycle.pump → ctx.actions.execute(那头由 lifecycle 走 Ref)。
 */
import { randomUUID } from 'node:crypto'
import type { AgentEvent, AgentSession, AgentExecutionChoice } from '../../agent-provider'
import type { MatterStore } from '../../matters/store'
import { classifyProviderError } from '../../provider-quota'
import { decideCall, isNetworkUnprotectedError } from '../../../lib/network-gate'
import { providerCallTarget } from '../../provider-registry'
import { liveRunTarget } from './call-target'
import { TIER_PROFILES, sessionAuthEnv } from '../../user-tier'
import { canonicalProject, outputDirectory } from '../artifacts'
import type { Attachment } from '../attachments'
import type { CreationReceipt } from '../creation-receipts'
import { makeDeltaCoalescer } from '../delta-coalescer'
import { CodexExecutionError } from '../codex-execution-error'
import { executionFailureMessage, normalizeExecutionChoice, PROVIDER_EXECUTION_CHOICE, sameExecutionChoice, taskErrorForProviderCode } from '../execution-settings'
import { isProviderErrorCode, providerErrorCodeOf } from '../../../lib/provider-error-code'
import { isUnattendedExecutor } from '../executor-capabilities'
import { captureGitBaseline } from '../git-review'
import { handoffArtifactText, type ArtifactSelection } from '../handoff'
import { normalizeInputRequestId, sameAttachments } from '../live-inputs'
import type { AcceptedNativeResume } from '../native-adoption'
import { makeRunPermissions, WORKBENCH_PERMISSION_TIMEOUT_MS } from '../permissions'
import { publicTask, type StoredTask, type TaskStatus } from '../store'
import type { EntryContext } from '../task-entry'
import { makeRunUserInput } from '../user-input'
import type { CreateWechatTask } from '../wechat-types'
import { checkedText } from './checked-text'
import { directoryIdentity } from './directory-identity'
import type { ServiceCtx } from './ctx'
import type { Active, AcceptedContinuation } from './state'
import type { CreateTask, InputMaterials, WorkbenchTaskView } from './types'
import type { AdmissionDomain } from './admission'
import type { AttachmentsDomain } from './attachments'
import type { QuotaDomain } from './quota'
import type { ViewDomain } from './view'
import type { NativeDomain } from './native'
import type { InputsDomain } from './inputs'
import type { LifecycleDomain } from './lifecycle'
import type { NoticesDomain } from './notices'
import type { ArtifactsDomain } from './artifacts'

const RECOVERY_MESSAGE='原执行会话暂时无法恢复。请打开桌面工作台，查看恢复选项并确认是否带此前记录重新开始。'

/** Cancellation must clear the idle timer even if a broken adapter leaves next() pending. */
async function collectWorkbenchTurn(events: AsyncIterable<AgentEvent>, stop: Promise<null>, timeoutMs: number, observe: (event: AgentEvent) => void, waiting:()=>boolean=()=>false,interactionAt:()=>number=()=>0,begin?:()=>void) {
  const iterator=events[Symbol.asyncIterator]()
  let result: Extract<AgentEvent,{kind:'result'}> | undefined
  let error: string | undefined
  let errorCode: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // Install the lifetime consumer before native start can publish any events.
    begin?.()
    for (;;) {
      let startedAt=Date.now(),paused=waiting()
      const next=iterator.next(),idle=Symbol('idle')
      const step=await (async()=>{
        for(;;){
          const nowPaused=waiting()
          if(nowPaused||paused)startedAt=Date.now()
          paused=nowPaused
          const value=await Promise.race([next,stop,new Promise<typeof idle>(resolve=>{timer=setTimeout(()=>resolve(idle),paused?timeoutMs:Math.max(1,timeoutMs-(Date.now()-Math.max(startedAt,interactionAt()))))})])
          if(timer){clearTimeout(timer);timer=undefined}
          if(value!==idle)return value
          if(paused)continue
          if(!waiting()&&Date.now()-Math.max(startedAt,interactionAt())>=timeoutMs)throw Error('turn_timeout')
        }
      })()
      if (timer) { clearTimeout(timer); timer=undefined }
      if (!step) return null
      if (step.done) return { result,error,errorCode }
      observe(step.value)
      if (step.value.kind==='result') result=step.value
      if (step.value.kind==='error') { error=step.value.message; errorCode=step.value.code }
    }
  } finally {
    if (timer) clearTimeout(timer)
    void Promise.resolve(iterator.return?.()).catch(() => {})
  }
}

export interface ExecuteDomains {
  admission: AdmissionDomain; attachments: AttachmentsDomain; quota: QuotaDomain; view: ViewDomain; native: NativeDomain
  inputs: InputsDomain; lifecycle: LifecycleDomain; notices: NoticesDomain; artifacts: ArtifactsDomain
}

export function makeExecuteDomain(ctx:ServiceCtx, domains:ExecuteDomains) {
  const { store, state } = ctx
  const {runsByTask,queue,runningText}=state
  const {requireInput,canResume,continuation,provider}=domains.admission
  const {selectAttachments,combinedAttachments,continuationAttachmentScope}=domains.attachments
  const {quota}=domains.quota
  const {taskView,runtimeSnapshot,projects}=domains.view
  const {validateNativeDecision}=domains.native
  const {holdInputs,drainInputs,settleRuntimeInput}=domains.inputs
  const {revokeCredentials,cancelIdleClose,reportOnce,recollectOnce,settleQuiet,settleAfterDecision,releaseReservation,confirmLateClose,markUncertain,pump}=domains.lifecycle
  const {requestNotice,terminalReportBody,stageFinishedNotice,publishFinishedNotices}=domains.notices
  const {collect,retakeBaseline}=domains.artifacts
  async function execute(task:StoredTask,text:string,running:Active) {
    const sessionKey=`workbench/${task.id}`
    let finalStatus:TaskStatus='failed'
    let finalError:string|null=null
    let spawning:Promise<AgentSession>|undefined
    let spawnRejected=false
    let accepted=false
    try {
      requireInput(task.providerId,running.attachments,running.execution,running.continuation.mode==='resume')
      running.releaseBusy=ctx.deps.holdBusy?.(sessionKey)
      if (canonicalProject(task.path) !== running.path || directoryIdentity(running.path) !== running.directoryIdentity) throw new Error('invalid_path')
      if(ctx.deps.executionConflict?.(task.path,task.providerId,task.sessionId))throw new Error('native_session_busy')
      const acceptedContinuation=running.continuation
      let resume:string|undefined,history=''
      if (acceptedContinuation.mode==='resume') {
        const current=store.get(task.id)
        if (current.sessionId!==acceptedContinuation.sessionId || !canResume(current)) throw new Error('restart_confirmation_required')
        resume=acceptedContinuation.sessionId
      } else if (acceptedContinuation.mode==='restart') {
        // Approval belongs to this immutable preview, never a newly sliced queue-time history.
        history=acceptedContinuation.preview.context
        store.addEvent(task.id,'system','用户已确认带此前记录重新开始；原任务对话和成果继续保留。')
        store.session(task.id,null)
        ctx.hub.touched(task.id)
      }
      const directory=outputDirectory(running.path,task.id)
      const instructions=[
        `你是 CC 的工作助手。当前任务编号 ${task.id}，任务：${task.title}。`,
        `本任务工作目录：${running.path}。成果目录：${directory}。`,
        '只根据当前任务、选定文件夹和本任务历史工作，不读取个人陪伴记忆或其他任务。',
        '保留原始输入，除非用户明确要求修改。项目代码、配置及用户指定位置的文件，应在项目中的指定位置创建或修改，不要迁移到成果目录。',
        '未指定保存位置的报告、图片等独立交付物放入上述成果目录，CC 会保存快照供用户查看；项目改动通过代码差异查看，不复制整份项目到成果目录。',
        '最后分别说明改动或交付文件的位置、实际完成的验证和未完成的验证。执行者结束回复不代表验证通过；工具失败或检查未运行时明确说明，不声称已验收。',
        '回复直接输出文本。不要调用微信发消息、发文件、记忆或社交工具，不替用户发布或发送成果。',
        '不要声称完成没有做过的检查。缺依赖、权限或信息时说明具体缺项。',
      ].join('\n')
      const reviewStop=new AbortController()
      void running.stop.then(()=>reviewStop.abort())
      if(running.cancelled){finalStatus='cancelled';return}
      running.reviewBaseline=await captureGitBaseline(running.path,{},reviewStop.signal)
      if(running.cancelled){finalStatus='cancelled';return}
      if(canonicalProject(running.path)!==running.path || directoryIdentity(running.path)!==running.directoryIdentity)throw new Error('invalid_path')
      if(running.nativeResume)await validateNativeDecision(store.get(task.id),running.nativeResume,true)
      for(const ref of running.handoffArtifacts??[])handoffArtifactText(store,ref,ref.taskId,ctx.stateDir)
      if(running.cancelled){finalStatus='cancelled';return}
      if(ctx.deps.executionConflict?.(task.path,task.providerId,task.sessionId))throw new Error('native_session_busy')
      const entry=requireInput(task.providerId,running.attachments,running.execution,running.continuation.mode==='resume')
      // 网络闸门(守护 v2;评审 #193 按实际目标判):起执行者之前问执行者「这次 spawn 实际会连到哪里」
      // (它用的端点 + 模型,不是此刻的配置);需要保护且不安全才不 spawn,任务以 network_unprotected 失败。
      // 不需要保护的执行者(Cursor auto、国内 / 自建网关)照常起。会话起来以后、发第一轮之前还会再判一次。
      if(ctx.deps.networkGate&&!(await decideCall(ctx.deps.networkGate,providerCallTarget(entry.provider,task.providerId,'spawn',{execution:{...running.execution},...(resume?{resumeSessionId:resume}:{})}))).allowed)throw new Error('network_unprotected')
      if(running.cancelled){finalStatus='cancelled';return}
      const token=ctx.deps.mintSessionToken?.(sessionKey)
      running.credentialsMinted=!!ctx.deps.mintSessionToken
      if (running.cancelled) revokeCredentials(running)
      store.update(task.id,running.cancelled ? 'cancelling' : 'running');ctx.hub.touched(task.id)
      if (running.cancelled) { finalStatus='cancelled'; return }
      spawning=entry.provider.spawn({alias:`workbench:${task.id}`,path:running.path},{
        workbenchTimeline:true,
        workbenchLifecycle:true,
        execution:{...running.execution},
        reportExecution:value=>{
          if(runsByTask.get(task.id)!==running||running.cancelled||running.finishing)return
          if(resume&&value.sessionId&&value.sessionId!==resume)throw Error('native_session_identity_mismatch')
          store.execution.observe(task.id,running.identity,value)
          ctx.hub.bumped(task.id)
        },
        reportNotice:message=>{
          if(runsByTask.get(task.id)!==running||running.cancelled||running.finishing)return
          const notice=message.trim().slice(0,2000)
          if(notice){store.addEvent(task.id,'system',notice,null,running.identity);ctx.hub.touched(task.id)}
        },
        tierProfile:TIER_PROFILES.trusted,permissionMode:isUnattendedExecutor(entry.opts.workbench)?'dangerously':'strict',chatId:task.ownerChatId ?? `workbench:${task.id}`,
        ...(resume ? {resumeSessionId:resume} : {}),mcpEnv:sessionAuthEnv('trusted',token),appendInstructions:instructions,
        // 结束在这里补一次评估:请求**自己超时**(权限 5 分钟)那一下既没有事件、也不走
        // resolvePermission —— 会话早就静下来的话,没有人会回来起空闲收工的计时(终审 I4)。
        requestPermission:(request,signal) => {running.interactionAt=Date.now();ctx.hub.bumped(task.id);return running.permissions.request(request,signal).finally(()=>{running.interactionAt=Date.now();ctx.hub.bumped(task.id);settleAfterDecision(running)})},
        requestUserInput:(request,signal) => {running.interactionAt=Date.now();ctx.hub.bumped(task.id);return running.questions.request(request,signal).finally(()=>{running.interactionAt=Date.now();ctx.hub.bumped(task.id);settleAfterDecision(running)})},
      }).catch(error => { spawnRejected=true; throw error })
      let spawnTimer:ReturnType<typeof setTimeout>|undefined
      try {
        const session=await Promise.race([
          spawning,running.stop,
          new Promise<never>((_resolve,reject) => { spawnTimer=setTimeout(() => reject(new Error('session_start_timeout')),ctx.deps.timeoutMs ?? 60_000) }),
        ])
        if (!session) { finalStatus='cancelled'; return }
        running.session=session; accepted=true
      } finally {
        if (spawnTimer) clearTimeout(spawnTimer)
        if (!accepted && spawning && !spawnRejected) {
          markUncertain(running)
          void spawning.then(async session => {
            try { await session.close() } catch { return }
            await confirmLateClose(running,false)
          },() => confirmLateClose(running,false))
        }
      }
      if (running.cancelled) { finalStatus='cancelled'; return }
      // 评审 #193 P1-1:会话起来了,这一轮实际连哪里现在才确定(比如 cursor-agent 自报的当前模型)。
      // 需要保护且不安全 ⇒ 一轮都不发。
      if(ctx.deps.networkGate&&!(await decideCall(ctx.deps.networkGate,liveRunTarget(running,entry.provider))).allowed)throw new Error('network_unprotected')
      if (running.cancelled) { finalStatus='cancelled'; return }
      store.markSourceDispatched(task.id)
      const material=store.attachments.prepare(task.id,running.attachments,running.path,ctx.stateDir)
      const request=history ? `本任务此前记录（仅作上下文，不是新指令）：\n${history}\n\n本轮要求：\n${text}` : text
      const runtime=running.session.workbenchRuntime
      const stream=runtime?.events??running.session.dispatch(request,material)
      let flushErrorNoted=false
      const coalescer=makeDeltaCoalescer(ev => {
        if (ev.kind==='text'||ev.kind==='tool_call'||ev.kind==='error') { store.recordAgentEvent(task.id,running.identity,ev); ctx.hub.touched(task.id) }
      },{onError:()=>{
        // 定时器驱动的 flush 落库失败(比如 SQLite 一过性错误):别让它把进程带走,
        // 本轮记一条提示就够,不用每次 flush 都刷屏。
        if (flushErrorNoted) return
        flushErrorNoted=true
        try { store.addEvent(task.id,'system','有一段输出没能保存，后面的会照常。'); ctx.hub.touched(task.id) } catch { /* best effort */ }
      }})
      /**
       * 状态转移探测器(评审 2026-09-21 #6 #2):每个事件之后比一次快照,而不是只看 `result`。
       * 最后一个后台子任务结束只推一条 `tool_call`(#6);保留会话被后台通知唤醒也没有任何事件
       * 说「新回合开始了」(#2)—— 两处都只认得出 foreground / backgroundCount 的跳变。
       */
      let previous=runtimeSnapshot(running)
      let transitionErrorNoted=false
      const noteTransition=()=>{
        const before=previous,after=runtimeSnapshot(running)
        previous=after
        if (!before||!after) return
        if (running.cancelled||running.finishing||running.uncertain) return
        const nowQuiet=after.foreground==='idle'&&after.backgroundCount===0
        const wasQuiet=before.foreground==='idle'&&before.backgroundCount===0
        // 静下来就交给 settleQuiet 判:它自己会因为「还在等主人拍板」而只收成果、不起计时。
        // 这里若因为有待决请求而跳过,这一次转移就被吃掉了 —— 之后 wasQuiet 一直是 true,
        // 再没有人回来收尾(评审 2026-09-21 #6 续:后台问题活过了父回合的答复)。
        if (nowQuiet&&!wasQuiet) { settleQuiet(running); return }
        // 又动起来了(自己被后台通知唤醒也算):不再安静就不再计时。文件夹本来就是它的,
        // 它想写就写 —— 没有什么要 fail-closed 的。
        if (!nowQuiet&&wasQuiet) {
          cancelIdleClose(running)
          // 自己醒来这条路唯一能推进 turnSeq 的地方(评审修复轮 1)——没有比这更早的信号
          // 了,所以是尽力而为:一段自动续作连着抖好几次 quiet↔busy 时,这里会跟着抖好几
          // 次(每次都算「新一轮」),多出来的入队调用在 outbox 那一层按 matter 合并,不在
          // 这里想办法压 —— 这里的职责只是「不要漏成永久锁死」,不是「精确数出真实回合数」。
          running.turnSeq++
          // 上一轮安静时 `captureCodeChanges` 已经把基线消费掉了,而取基线只有两个入口:起步和
          // 主人续接(`submitInput`)。自己醒来这条路没有入口 —— BASE 是靠 `onAutonomousStart`
          // → `beginTurn` 重取的,那两个函数这一轮删了。不补的话「自己醒来干的这一轮」永远生不出
          // 代码变更,而新不变式下这种活是合法的、它的差异比以前更重要(修复轮 #3)。
          if (!running.reviewBaseline) void retakeBaseline(running)
        }
      }
      let summary
      try {
        summary=await collectWorkbenchTurn(stream,running.stop,ctx.deps.timeoutMs ?? 10*60_000,
          ev => {
            if (running.cancelled) return
            if(running.queuedInputId&&['text','tool_call','result'].includes(ev.kind)){store.liveInputs.set(running.queuedInputId,'delivered');ctx.hub.bumped(task.id)}
            if ((ev.kind==='init'||(runtime&&ev.kind==='result')) && ev.sessionId) {matterSync(m=>m.addSession(task.id,task.providerId,ev.sessionId!,'main'));if(resume&&ev.sessionId!==resume)throw new Error('native_session_identity_mismatch');store.session(task.id,ev.sessionId);if(running.handoffId){const peer=store.recordHandoffNative(running.handoffId,ev.sessionId);if(peer)ctx.hub.touched(peer.sourceTaskId)}ctx.hub.touched(task.id)}
            coalescer.push(ev)
            // 额度/限流在错误到达时就登记(评审 #5:只在结算时看,保留会话永远等不到结算);
            // 任何一个成功回合(result)即视为这家恢复。
            if (ev.kind==='error') quota.note(task.providerId,ev.message,ev.code)
            if (ev.kind==='result') quota.clear(task.providerId)
            if (ev.kind==='result') settleQuiet(running)
            // observe 是**故意**会往外抛的(身份不符那条),所以探测器自己抛出会把整轮带走。
            // 落定漏一次会被下一个事件补上,抛出去却不可逆 —— 吞掉,只记一次(终审 M5)。
            try { noteTransition() } catch {
              if (!transitionErrorNoted) {
                transitionErrorNoted=true
                try { store.addEvent(task.id,'system','本轮的状态跟踪出过一次错；收尾会在后面的事件里补上。');ctx.hub.touched(task.id) } catch { /* best effort */ }
              }
            }
          },()=>{
            const snapshot=runtimeSnapshot(running)
            return running.questions.pending().length>0||running.permissions.pending().length>0||!!(snapshot?.retained&&snapshot.foreground==='idle'&&snapshot.backgroundCount===0)
          },()=>running.interactionAt,runtime?()=>runtime.start(request,material):undefined)
      } finally { coalescer.dispose() }
      if (!summary) { finalStatus='cancelled'; return }
      if (summary.result?.sessionId) {if(resume&&summary.result.sessionId!==resume)throw new Error('native_session_identity_mismatch');store.session(task.id,summary.result.sessionId);if(running.handoffId){const peer=store.recordHandoffNative(running.handoffId,summary.result.sessionId);if(peer)ctx.hub.touched(peer.sourceTaskId)}ctx.hub.touched(task.id)}
      if (running.cancelled) finalStatus='cancelled'
      else if (summary.error || !summary.result || runtime?.snapshot().retained) {
        // An old foreground result cannot turn an unexpected retained EOF into success.
        const raw=summary.error ?? (runtime?.snapshot().retained?'background_runtime_ended':'stream_ended_without_result')
        // Native model and guard refusals keep their specific meaning. Every provider code
        // is authoritative; only uncoded legacy errors may infer quota from text.
        const modelRejected=summary.errorCode==='execution_model_unsupported'
        const networkRefused=summary.errorCode==='network_unprotected'
        const providerCode=isProviderErrorCode(summary.errorCode)?summary.errorCode:undefined
        const quotaKind=providerCode?(providerCode==='quota'?'quota':providerCode==='rate_limited'?'rate_limit':null):!summary.errorCode&&summary.error?classifyProviderError(summary.error):null
        const error=modelRejected?'execution_model_unsupported':networkRefused?'network_unprotected':taskErrorForProviderCode(providerCode,raw)??(quotaKind==='quota'?'provider_quota_exhausted':quotaKind==='rate_limit'?'provider_rate_limited':raw)
        if(quotaKind)quota.note(task.providerId,summary.error!,providerCode)
        finalStatus='failed'; finalError=error
        const coded=error!==raw&&!!summary.error
        if(!modelRejected&&!networkRefused)store.addEvent(task.id,'error',error==='background_runtime_ended'?'后台执行会话意外结束；对话已保留，请检查后再继续。':coded?`${executionFailureMessage(error)}\n原文：${summary.error!.trim().slice(0,200)}`:executionFailureMessage(error))
        ctx.hub.touched(task.id)
      } else { finalStatus='completed'; quota.clear(task.providerId) }
    } catch (error) {
      const thrown=isNetworkUnprotectedError(error)?'network_unprotected':error instanceof CodexExecutionError?error.code:error instanceof Error?error.message:'task_failed'
      const message=thrown==='network_unprotected'||error instanceof CodexExecutionError?thrown:taskErrorForProviderCode(providerErrorCodeOf(error),thrown)??thrown
      finalStatus=running.cancelled ? 'cancelled' : 'failed'; finalError=running.cancelled ? null : message
      if (!running.cancelled) { store.addEvent(task.id,'error',error instanceof CodexExecutionError?error.message:message==='restart_confirmation_required' ? RECOVERY_MESSAGE : executionFailureMessage(message)); ctx.hub.touched(task.id) }
    } finally {
      cancelIdleClose(running)
      running.finishing=true;running.questions.close();ctx.hub.bumped(task.id)
      for(const input of running.runtimeInputs?.values()??[])settleRuntimeInput(running,input,new Error('runtime_closed_before_input_acknowledgement'))
      running.permissions.rejectAll(running.cancelled ? 'cancelled' : 'ended');ctx.hub.bumped(task.id)
      let closePromise:Promise<void>|undefined
      let closeTimer:ReturnType<typeof setTimeout>|undefined
      if (running.session) {
        try {
          closePromise=Promise.resolve(running.session.close())
          await Promise.race([closePromise,new Promise<never>((_resolve,reject) => { closeTimer=setTimeout(() => reject(new Error('close_timeout')),ctx.deps.closeTimeoutMs ?? 3000) })])
        } catch {
          markUncertain(running); finalStatus='interrupted'; finalError='writer_not_closed'
          try { store.addEvent(task.id,'system','执行程序未确认退出，此文件夹内的新任务将等待。请检查后台进程或重启服务。');ctx.hub.touched(task.id) } catch { /* final status write below may still succeed */ }
          if (closePromise) void closePromise.then(() => confirmLateClose(running,true),() => {})
        } finally { if (closeTimer) clearTimeout(closeTimer) }
      }
      if (!running.uncertain) await collect(running)
      revokeCredentials(running)
      if (running.uncertain) { finalStatus='interrupted'; finalError='writer_not_closed' }
      let terminalCommitted=false
      try {
        const status=running.cancelled&&!running.uncertain?(running.closedWhileReplied?'completed':'cancelled'):finalStatus
        // 会不会真的在这一拍入队回报,两个条件都要成立(终审后修复第二轮
        // Important②a,判据比"这一轮有没有出生地"更紧):①这一轮有出生地
        // (跟 renderReport 自己的判据同一条)②reportOnce 这一拍真的会执
        // 行、不是因为 reportedTurn===turnSeq 而 no-op——retained 执行者
        // 到这里之前已经在 settleQuiet 报过这一轮,这里的 reportOnce 调用
        // 只是 no-op,不存在"同一拍双发",stageFinishedNotice 的通知不该
        // 被压(上一版漏了这一条,把 retained 执行者也误伤了)。
        let willReport=false
        try {
          willReport=status==='completed'
            &&running.reportedTurn!==running.turnSeq
            &&!!ctx.deps.matters?.get(task.id)?.originMatterId
        } catch (err) {
          // 读不到出生地(比如 matters.get 抛错)就当这一轮不会报处理,默认
          // 「不压」——两个方向的代价不对称:多一条通知是噪音,两条都不
          // 发是主人什么都收不到(终审后修复第二轮 Important①)。
          ctx.log?.('MATTER_REPORT',`willReport probe failed for ${task.id}: ${err instanceof Error?err.message:err}`)
          willReport=false
        }
        // 终审后修复第二轮 Important②b:压掉 stageFinishedNotice 的 completed
        // 通知时,把它原本会发的正文(terminalReportBody)并进回报文案——
        // 不然"压通知"就变成了"主人这一轮的答案从此要自己回一句「任务
        // <id>」才能看到",那正是这个功能存在的理由(spec:交给 CC 之后能
        // 放心离开、回来接得上)的反面。这也顺带补上了第 6 项对非 retained
        // 执行者的缺口——它们的 turnSeq 恒为 0(见下面 recollectOnce 之后
        // 的调用点、report.ts 的 renderReport 文档注释),「第 N 轮」这几
        // 个字对它们本来就区分不开相邻两轮,真正让文案不同的是这里并进去
        // 的正文(每轮答复内容通常不同)。
        const body=willReport?terminalReportBody(running):undefined
        store.atomic(()=>{
          store.finishRunActivities(task.id,running.identity,running.cancelled&&!running.uncertain?'cancelled':'interrupted')
          store.update(task.id,status,finalError)
          stageFinishedNotice(running,status,finalError,willReport)
        })
        ctx.hub.touched(task.id)
        terminalCommitted=true
        matterSync(m=>m.setStatus(task.id,status==='interrupted'?'open':'done'))
        // 非 retained 的执行者永远不经过 settleQuiet(isReplied 要求 snapshot.retained),
        // 只走这条终态路径 —— 不在这里也调一次 reportOnce,那类执行者的任务永远不回报
        // (评审修复轮 1 ③)。turnSeq 去重保证 settleQuiet 已经报过这一轮时这里是 no-op。
        // 只在 'completed' 时报(评审修复轮 2 ②):'failed'/'cancelled' 也会落到这条终态
        // 路径,而 renderReport 只看出生地、不看结果——报出去就是把一件失败或被叫停的事
        // 说成「已答复」,跟 stageFinishedNotice 给 failed/额度耗尽的既有文案("这一轮
        // 需要处理"/问"交给 X 继续?")直接打架。失败/取消不经这里回报,不代表主人收不
        // 到通知——stageFinishedNotice 走的是另一条既有的完成通知路径,不受这里影响。
        if (status==='completed') reportOnce(running,body)
        // 回忆(task-5,fix round 3,评审必判①):这是唯一的触发点(round 2
        // 还有 settleQuiet 那一处,这一轮去掉了——见 settleQuiet 里的注
        // 释)。这里的 turnSeq 是这个 run 真实的总轮数,"一件事一段记述"与
        // "最该记住的是波折"只有写在结局时才同时成立。跟 reportOnce 不
        // 同,不继承 `status==='completed'` 那道门:spec 的回忆判据恰恰是
        // "反复失败、被打回、隔夜才通的才记得",继承那道门会把最该被记住
        // 的那类事正好挡掉。被主人当场取消的事 turnSeq 还是初始值、当天
        // 创建,门槛(turns/overnight/returned)自己会挡住,不用在这里特
        // 判 cancelled。
        //
        // 但**排除 'interrupted'**(fix round 3 M5/I1 同根):这个状态是
        // "执行程序没确认退出,不确定它是不是还活着"——matterSync 上面那
        // 一行把 matter 设回 'open',故事没完。若在这里也调 recollectOnce
        // 并真写了一条,后面这件事真的收尾时会被持久去重(journal.
        // hasRecollection)挡住,永久用掉它唯一那次机会,记下的还是当下这
        // 个"不确定"状态而不是真正的结局。排除后 hasRecollection 仍是
        // false——这个 matter 之后无论是被继续(比如 restart_required 那
        // 条续接路径,service.continueTask)还是干脆没人再碰,都不会被这
        // 一次 interrupted"用掉"配额;等它真的收尾(哪怕是后来某一次新的
        // run 的终态),recollectOnce 会在那时才第一次真正评估。
        if (status!=='interrupted') recollectOnce(running)
        publishFinishedNotices()
      } catch { /* never unlock an uncertain writer for a status failure */ }
      running.publicFinished=true; running.resolveDone()
      if (!running.uncertain) releaseReservation(running)
      if(terminalCommitted&&finalStatus==='completed'&&!running.cancelled&&!running.uncertain&&!state.stopping)drainInputs(task.id,running.directoryIdentity)
      else holdInputs(task.id,'任务已停止或未正常完成；这条补充尚未发送。')
    }
  }



  function start(task:StoredTask,text:string,acceptedDirectoryIdentity:string,acceptedContinuation:AcceptedContinuation={mode:'new'},nativeResume?:AcceptedNativeResume,handoffArtifacts?:ArtifactSelection[],handoffId?:string,queuedInputId?:string,attachments:Attachment[]=[],draftId?:string,executionChoice?:AgentExecutionChoice,acceptance?:{persist:(runId:string)=>void;activate:(fn:()=>void)=>void;scope?:{ownerKey:string}},attachmentPolicy?:'owner'):WorkbenchTaskView {
    if (runsByTask.has(task.id)) throw new Error('workbench_busy')
    if(ctx.deps.executionConflict?.(task.path,task.providerId,task.sessionId))throw new Error('native_session_busy')
    if([...runsByTask.values()].some(run=>task.sessionId&&run.task.providerId===task.providerId&&run.task.sessionId===task.sessionId))throw new Error('native_session_busy')
    const runId=randomUUID()
    const execution=normalizeExecutionChoice(executionChoice,store.execution.choice(task.id))
    const dispatchAttachments=combinedAttachments(attachments,acceptedContinuation.mode==='restart'?acceptedContinuation.preview.attachments:[])
    requireInput(task.providerId,dispatchAttachments,execution,acceptedContinuation.mode==='resume')
    // addRunEvent 自己 touched:权限/提问审计在 atomic 块外单独发生,不能漏。
    // 事务里面(下面 store.atomic 块内)绝不能用它——半路抛错时 bump 跟着回滚,但 touched 已经
    // 把 hub 拱到了那个从没真正落库的 seq,之后 wait 会把这个"幻影 seq"当成已经发生过的事,
    // 一路卡到超时才被 store.version 兜底纠正(纠正见下面 changes.wait);直接调 store.addEvent
    // 就不会发布这个未提交的信号,提交后的 ctx.hub.touched(task.id)(atomic 块外)会把真实 seq 发出去。
    const addRunEvent=(kind:'user'|'system',text:string)=>{const id=store.addEvent(task.id,kind,text,null,runId);ctx.hub.touched(task.id);return id}
    const handoffPeer=store.atomic(()=>{
      store.execution.accept(task.id,runId,execution)
      const bound=store.attachments.bind(attachments.map(a=>a.id),task.id,draftId,attachmentPolicy?continuationAttachmentScope(task.id,attachments):acceptance?.scope)
      if(!sameAttachments(bound,attachments))throw Error('invalid_attachment_changed')
      // A queued receipt keeps the ORIGINAL accepted run, even when this is a new dispatch run.
      if(queuedInputId&&!store.liveInputs.get(queuedInputId)){
        store.liveInputs.add({id:queuedInputId,taskId:task.id,runId,text,attachments,execution})
        store.liveInputs.set(queuedInputId,'sending')
      }
      if(nativeResume)store.addEvent(task.id,'system',`用户声明原 ${task.providerId} 执行程序已关闭，选择${nativeResume.mode==='native_resume'?'恢复原会话':'带已确认的记录新开一轮'}。原会话：${nativeResume.nativeId}。`,null,runId)
      const requestEventId=store.addEvent(task.id,'user',text,null,runId,attachments)
      const peer=handoffId?store.recordHandoffEvent(handoffId,requestEventId):null
      store.update(task.id,'queued')
      acceptance?.persist(runId)
      return peer
    })
    // recordHandoffEvent 同时 bump 了交接的另一头(source 任务),不发它那边就看不到这条请求已挂上。
    let signalStop!:()=>void,resolveDone!:()=>void
    const stop=new Promise<null>(resolve => { signalStop=() => resolve(null) })
    const done=new Promise<void>(resolve => { resolveDone=resolve })
    const permissions=makeRunPermissions({
      taskId:task.id,timeoutMs:ctx.deps.permissionTimeoutMs ?? WORKBENCH_PERMISSION_TIMEOUT_MS,
      audit:event => {
        if(event.type==='request'){
          addRunEvent('system',`权限请求：${event.permission.tool} · ${event.permission.description} · ${event.permission.id}`)
          requestNotice(task,runId,'permission',event.permission.id,`${event.permission.tool} · ${event.permission.description}`)
        }else addRunEvent('system',`权限结果：${event.permission.tool} · ${event.outcome} · ${event.permission.id}`)
      },
    })
    const questions=makeRunUserInput({taskId:task.id,audit:event=>{
      if(event.type==='request'){
        addRunEvent('system',`执行者提问：${JSON.stringify(event.request)}`)
        requestNotice(task,runId,'question',event.request.id,event.request.questions.map(q=>q.question).join('\n'))
      }
      else if(event.type==='answer')addRunEvent('user',`回答执行者的问题：\n${event.request.questions.map(q=>`${q.question}\n${event.answers?.[q.id]?.join('、')??''}`).join('\n\n')}`)
      else addRunEvent('system',`问题已结束，未提交回答：${event.request.id}`)
    }})
    const running:Active={
      execution,
      attachments:dispatchAttachments,
      interactionAt:Date.now(),questions,queuedInputId,handoffId,handoffArtifacts,nativeResume,continuation:acceptedContinuation,identity:runId,taskId:task.id,title:task.title,path:task.path,order:++state.order,state:'queued',task,directoryIdentity:acceptedDirectoryIdentity,
      cancelled:false,done,resolveDone,stop,signalStop,permissions,publicFinished:false,uncertain:false,artifactsCollected:false,turnSeq:0,reportedTurn:-1,recollectedTurn:-1,credentialsMinted:false,credentialsRevoked:false,
    }
    const activate=()=>{if(handoffPeer)ctx.hub.touched(handoffPeer.sourceTaskId);ctx.hub.touched(task.id);runsByTask.set(task.id,running);runningText.set(running.identity,text);queue.push(running);pump()}
    if(acceptance)acceptance.activate(activate);else activate()
    return taskView(publicTask({...task,status:'queued',error:null}))
  }

  /** matter 同步永不打断任务本身:登记失败只是少一条索引,任务照跑。 */
  function matterSync(fn:(m:MatterStore)=>void):void { if(!ctx.deps.matters)return; try{fn(ctx.deps.matters)}catch{/* 见上 */} }
  /** 出生地也不能打断创建:没有 matter store、或那个 chat 的 matter 建不出来,就没有出生地,任务照建。
   *  但「算出生地时出错」不能悄悄退化成「这件事本来就没有出生地」——没接 matters 是老接线的正常状态、
   *  不留痕;`ensureChat` 真的抛错则是信号,留一条能查到的痕迹(评审 2026-09-23 修复轮 1)。 */
  function safeOriginMatterId(ownerChatId:string):string|null {
    if(!ctx.deps.matters)return null
    try{return ctx.deps.matters.ensureChat(ownerChatId).id}
    catch(err){ctx.log?.('MATTER_ORIGIN',`ensureChat failed for ${ownerChatId}: ${err instanceof Error?err.message:err} — origin left null, task still created`);return null}
  }
  function createTask(input:CreateTask,onAccepted?:(task:StoredTask,runId:string)=>void,origin?:{matterId:string|null;messageId:string|null},entry?:{context:EntryContext;workspaceKind:'managed'|'project';fromChat:boolean;materials:Attachment[];beforeCreate:()=>void;verifyDirectory:(path:string,identity:string)=>void}):WorkbenchTaskView {
    ctx.ensureAccepting()
    const execution=normalizeExecutionChoice(input.execution,PROVIDER_EXECUTION_CHOICE)
    const attachments=entry?entry.materials:selectAttachments(input)
    const checked=checkedText(input.text,attachments),text=entry?input.text:checked
    requireInput(input.providerId,attachments,execution)
    if(input.title!==undefined&&(typeof input.title!=='string'||!input.title.trim()||input.title.length>120))throw Error('invalid_title')
    const path=canonicalProject(input.path),acceptedDirectoryIdentity=directoryIdentity(path)
    entry?.verifyDirectory(path,acceptedDirectoryIdentity)
    if(ctx.deps.executionConflict?.(path,input.providerId,null))throw Error('native_session_busy')
    let activate:()=>void=()=>{}
    const accepted=store.atomic(()=>{
      entry?.beforeCreate()
      const task=store.create({title:input.title?.trim()??(text.slice(0,40)||attachments[0]!.name.slice(0,40)),path,providerId:input.providerId,ownerChatId:entry?.context.ownerKey??ctx.deps.ownerChatId(),workspaceKind:entry?.workspaceKind,registerProject:entry?.workspaceKind!=='managed'})
      if(entry){
        const m=ctx.deps.matters;if(!m)throw Error('entry_not_wired')
        const chat=entry.fromChat?m.ensureChat(entry.context.ownerKey):null
        if(chat&&chat.ownerChatId!==entry.context.ownerKey)throw Error('invalid_entry_owner')
        m.create({id:task.id,kind:'task',title:task.title,projectPath:path,ownerChatId:entry.context.ownerKey,originMatterId:chat?.id??null,originMessageId:null})
        m.linkTask(task.id)
        if(store.taskMatterId(task.id)!==task.id)throw Error('entry_matter_link_failed')
        m.bind(task.id,entry.context.surface,entry.context.ownerKey)
      }else matterSync(m=>{m.create({id:task.id,kind:'task',title:task.title,projectPath:path,ownerChatId:task.ownerChatId??null,originMatterId:origin?.matterId??null,originMessageId:origin?.messageId??null});m.linkTask(task.id);if(task.ownerChatId)m.bind(task.id,'wechat',task.ownerChatId)})
      return start(task,text,acceptedDirectoryIdentity,undefined,undefined,undefined,undefined,undefined,attachments,input.draftId,execution,{
        persist:runId=>onAccepted?.(task,runId),activate:fn=>{activate=fn},scope:entry?.context,
      })
    },!!entry)
    // An accepted in-memory run must never outlive a rolled-back creation transaction.
    activate()
    return accepted
  }
  function createWechat(input:CreateWechatTask):CreationReceipt {
    ctx.ensureAccepting()
    if(!input.ownerChatId||ctx.deps.ownerChatId()!==input.ownerChatId||!input.accountId?.trim())throw Error('invalid_wechat_identity')
    const id=normalizeInputRequestId(input.requestId)
    if(!/^[a-f0-9]{64}$/.test(input.commandHash))throw Error('invalid_request')
    // Replay accepted identity before consulting configuration or a directory that may have moved.
    const prior=store.creationReceipts.get(id)
    if(prior){
      if(prior.ownerChatId!==input.ownerChatId||prior.accountId!==input.accountId||prior.commandHash!==input.commandHash)throw Error('creation_conflict')
      if(store.get(prior.taskId).ownerChatId!==input.ownerChatId)throw Error('invalid_wechat_identity')
      return prior
    }
    const project=projects().find(project=>project.id===input.projectId)
    if(!project)throw Error('project_stale')
    const providerId=input.providerId??project.providerId
    if(!providerId)throw Error('unavailable_provider')
    let receipt!:CreationReceipt
    createTask({path:project.path,providerId,text:input.text},(task,runId)=>{
      store.wechatNotifications.watch(task.id,input.ownerChatId,input.accountId,true)
      receipt=store.creationReceipts.add({id,accountId:input.accountId,ownerChatId:input.ownerChatId,commandHash:input.commandHash,projectId:input.projectId,path:task.path,providerId:task.providerId,taskId:task.id,runId,
        reply:`已接下这件事 · ${task.id}\n${task.providerId} · ${task.path}\n\n${task.title}\n\n完成或需要你处理时，会在这里提醒。\n查看：任务 ${task.id}\n补充：任务 ${task.id} 补充 <要求>\n关闭提醒：任务 ${task.id} 静音`,
      })
    },{matterId:safeOriginMatterId(input.ownerChatId),messageId:input.originMessageId??null})
    return receipt
  }
  // 不标 async:内部 wechatControl(见文件末尾)按同步 Actions 接口拿它,标了 async 会把
  // 返回类型变成 Promise 而破坏那个结构化类型;外部调用方(HTTP 长轮询、测试)照样能 await 一个普通值。
  function create(input:CreateTask):WorkbenchTaskView {
    return createTask(input)
  }
  function continueTask(id:string,text:string,options?:{restartToken?:string;inputRequestId?:string}&InputMaterials,attachmentPolicy?:'owner'):WorkbenchTaskView {
    ctx.ensureAccepting()
    const attachments=selectAttachments(options,id,attachmentPolicy)
    const inputRequestId=options?.inputRequestId===undefined?undefined:normalizeInputRequestId(options.inputRequestId)
    if(inputRequestId!==undefined){
      const prior=store.liveInputs.get(inputRequestId)
      if(prior){
        if(prior.taskId!==id||prior.text!==checkedText(text,attachments)||!sameAttachments(prior.attachments,attachments))throw Error('input_conflict')
        // An omitted retry keeps its ORIGINAL choice, never later task defaults.
        const original=prior.execution??store.execution.run(id,prior.runId)?.choice
        if(options?.execution!==undefined&&(!original||!sameExecutionChoice(normalizeExecutionChoice(options.execution,original),original)))throw Error('input_conflict')
        return taskView(publicTask(store.get(id)))
      }
    }
    if (runsByTask.has(id)) throw new Error('workbench_busy')
    const task=store.get(id)
    const execution=normalizeExecutionChoice(options?.execution,store.execution.choice(id))
    if(store.source(id)?.firstDispatchedAt===null)throw new Error('external_close_confirmation_required')
    if(task.archivedAt!==null)throw new Error('workbench_archived')
    provider(task.providerId)
    if (canonicalProject(task.path)!==task.path) throw new Error('invalid_path')
    const request=checkedText(text,attachments),acceptedDirectoryIdentity=directoryIdentity(task.path)
    const restartToken=options?.restartToken
    if (restartToken!==undefined && (typeof restartToken!=='string' || !/^[a-f0-9]{64}$/.test(restartToken))) throw new Error('invalid_request')
    const decision=continuation(task,execution)
    if (restartToken!==undefined && (decision.mode!=='restart_required' || restartToken!==decision.restart.token)) throw new Error('restart_confirmation_stale')
    if (decision.mode==='restart_required' && restartToken===undefined) throw new Error('restart_confirmation_required')
    const accepted:AcceptedContinuation=decision.mode==='restart_required'
      ? {mode:'restart',preview:decision.restart}
      : decision.mode==='resume' ? {mode:'resume',sessionId:task.sessionId!} : {mode:'new'}
    try{return start(task,request,acceptedDirectoryIdentity,accepted,undefined,undefined,undefined,inputRequestId,attachments,options?.draftId,execution,undefined,attachmentPolicy)}
    catch(error){
      if(inputRequestId&&store.liveInputs.get(inputRequestId))try{store.liveInputs.set(inputRequestId,'held','本轮未确认开始，补充内容已保留。');ctx.hub.bumped(id)}catch{state.autoContinueBlocked.add(id)}
      throw error
    }
  }

  return { execute,start,matterSync,safeOriginMatterId,createTask, create,continueTask,createWechat }
}
export type ExecuteDomain = ReturnType<typeof makeExecuteDomain>
