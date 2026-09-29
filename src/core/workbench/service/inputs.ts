/**
 * inputs 域:主人的补充 —— 持有(hold)/ 排空(drain)/ 结算(settle)三个内部动作,以及
 * submitInput / withdrawInput / resolveAnswer / resolvePermission 四个入口。
 * 从 service.ts 逐字搬来(spec 2026-09-27-workbench-service-split §3 第 8 项);只认 ctx。
 * 与 lifecycle 互调:这里要 cancelIdleClose / armIdleClose / settleAfterDecision,经 act()=ctx.actions.deref('inputs') 在调用时取;
 * 反过来 lifecycle / execute 要的 holdInputs / drainInputs / settleRuntimeInput / hasUndeliveredInput 由 service.ts 解构。
 * autoContinueBlocked 在 state 上,与 execute 共享同一个 Set。
 */
import { canonicalProject } from '../artifacts'
import { captureGitBaseline } from '../git-review'
import { normalizeInputRequestId, sameAttachments, type LiveInput } from '../live-inputs'
import type { PermissionDecision } from '../permissions'
import { checkedText } from './checked-text'
import { directoryIdentity } from './directory-identity'
import type { ServiceCtx } from './ctx'
import type { Active } from './state'
import type { InputMaterials } from './types'

const INPUT_UNCONFIRMED='未确认执行者收到，请检查当前对话后再决定是否重发。'

export function makeInputsDomain(ctx:ServiceCtx) {
  const { store, state } = ctx
  const act=()=>ctx.actions.deref('inputs')
  function holdInputs(id:string,error:string){
    state.autoContinueBlocked.add(id)
    try{
      store.atomic(()=>{
        // A native send awaiting acknowledgement is ambiguous, even after stop.
        for(const saved of state.runsByTask.get(id)?.runtimeInputs?.values()??[]){
          const current=store.liveInputs.get(saved.id)
          if(current?.status==='sending'&&current.taskId===saved.taskId&&current.runId===saved.runId&&current.text===saved.text&&sameAttachments(current.attachments,saved.attachments))store.liveInputs.set(saved.id,'held',INPUT_UNCONFIRMED)
        }
        store.liveInputs.hold(id,error)
      })
      ctx.hub.bumped(id)
      state.autoContinueBlocked.delete(id)
    }catch{/* Stop must not depend on a successful disk write. */}
  }
  /**
   * 主人已经交上来、还没投给执行者的补充(`pending` / `sending` —— 和 `holdInputs` / `recover`
   * 盯的是同一批)。有这种补充就不能自动收工:收工走的是 `cancelRun`,结算时 `running.cancelled`
   * 让这批补充走 `holdInputs` 而不是 `drainInputs`,主人刚打的那句话被文件夹移交盖成
   * 「补充尚未发送」(评审修复轮 #6 —— 和修复轮 #1 是同一个失败形状,只是触发者换成了
   * 「之后才来的等待者把短让位重新武装起来」)。
   * 读不出来就当有:宁可文件夹多占一会儿,也不能把主人的话弄丢。
   */
  function hasUndeliveredInput(running:Active):boolean {
    try { return store.liveInputs.count(running.taskId)>0 } catch { return true }
  }
  function drainInputs(id:string,expectedDirectoryIdentity:string){
    if(state.autoContinueBlocked.has(id))return
    const next=store.liveInputs.next(id);if(!next)return
    try{
      const task=store.get(id),decision=act().continuation(task)
      if(decision.mode!=='resume')throw Error('原会话需要你确认恢复方式，补充尚未发送。')
      const path=canonicalProject(task.path);if(path!==task.path||directoryIdentity(path)!==expectedDirectoryIdentity)throw Error('invalid_path')
      store.liveInputs.set(next.id,'sending');ctx.hub.bumped(id)
      const execution=next.execution??store.execution.run(id,next.runId)?.choice??store.execution.choice(id)
      act().requireInput(task.providerId,next.attachments??[],execution,true)
      act().start(task,next.text,expectedDirectoryIdentity,{mode:'resume',sessionId:task.sessionId!},undefined,undefined,undefined,next.id,next.attachments,undefined,execution)
    }catch(error){holdInputs(id,error instanceof Error?error.message:'input_not_delivered')}
  }

  function settleRuntimeInput(running:Active,saved:LiveInput,error?:unknown) {
    if(state.shutdownComplete){running.runtimeInputs?.delete(saved.id);return}
    try {
      // held-only 落库不会自己 bump(store.addEvent 才会);两条分支分别记账,没写就不吵。
      let changed:'held'|'delivered'|null=null
      store.atomic(()=>{
        const current=store.liveInputs.get(saved.id)
        if(!current||current.taskId!==saved.taskId||current.runId!==saved.runId||current.text!==saved.text||!sameAttachments(current.attachments,saved.attachments))return
        if(error!==undefined){
          // Stop/recovery may already have held it. Never revive an old send.
          if(current.status==='sending'){store.liveInputs.set(saved.id,'held',`${INPUT_UNCONFIRMED}${error instanceof Error?' '+error.message:''}`);changed='held'}
          return
        }
        if(current.status!=='sending'&&current.status!=='held')return
        // A late positive native acknowledgement is truthful only for this receipt.
        store.liveInputs.set(saved.id,'delivered')
        store.addEvent(saved.taskId,'user',saved.text,null,saved.runId,saved.attachments)
        changed='delivered'
      })
      if(changed==='held')ctx.hub.bumped(saved.taskId)
      else if(changed==='delivered')ctx.hub.touched(saved.taskId)
      // Keep delivery uncertainty tracked if the durable transition failed.
      running.runtimeInputs?.delete(saved.id)
      if(state.runsByTask.get(saved.taskId)===running&&!running.cancelled&&!running.finishing)running.interactionAt=Date.now()
    }catch{state.autoContinueBlocked.add(saved.taskId)}
  }
  function resolveAnswer(id:string,requestId:string,answers:unknown){
    const running=state.runsByTask.get(id)
    if(!running||running.cancelled||running.finishing||!running.questions.resolve(requestId,answers))throw Error('question_stale')
    ctx.hub.bumped(id)
    // 回合早就静下来、只差这一个待决请求时,不会再有事件把落定叫起来 —— 拍完板自己补一次。
    act().settleAfterDecision(running)
  }
  function withdrawInput(id:string,requestId:string){
    const input=store.liveInputs.get(requestId)
    if(!input||input.taskId!==id||input.status!=='pending')throw Error('input_stale')
    store.liveInputs.set(requestId,'withdrawn')
    ctx.hub.bumped(id)
  }
  async function submitInput(id:string,input:{runId:string;requestId:string;text:string}&InputMaterials,attachmentPolicy?:'owner'){
    ctx.ensureAccepting()
    if(Object.hasOwn(input,'execution'))throw Error('invalid_execution')
    const attachments=act().selectAttachments(input,id,attachmentPolicy),text=checkedText(input.text,attachments)
    if(state.autoContinueBlocked.has(id))throw Error('input_storage_unavailable')
    const requestId=normalizeInputRequestId(input.requestId)
    const prior=store.liveInputs.get(requestId)
    if(prior){if(prior.taskId!==id||prior.runId!==input.runId||prior.text!==text||!sameAttachments(prior.attachments,attachments))throw Error('input_conflict');return prior}
    const running=state.runsByTask.get(id)
    if(!running||running.identity!==input.runId||running.cancelled||running.finishing||running.uncertain)throw Error('input_stale')
    if(running.delivering)throw Error('input_delivery_busy')
    if(store.liveInputs.count(id)>=10)throw Error('input_limit')
    act().requireInput(running.task.providerId,attachments,running.execution)
    // 一句补充就是一下互动:先把自动收工的计时取消掉,免得话在路上会话被关了。这一下要在
    // **入口**做,不能放进下面那个分支 —— `isReplied` 不看 `inputMode`,一条安静的运行若 runtime
    // 报 `input:'queue'`,补充会存下来等着,而计时还武装着:让位到点就把会话关了,主人收到的
    // 是「补充尚未发送」(评审 2026-09-21 修复轮 #1)。
    act().cancelIdleClose(running)
    if(running.session?.workbenchRuntime&&act().inputMode(running)!=='queue'){
      // 上一轮的快照还在截就等它截完,别把这一轮的改动算进上一轮。
      if(running.reviewCapture)await running.reviewCapture.catch(()=>{})
      // 续接 = 新一轮差异的起点:重新取基线。回合中间补一句话时上一轮还没截过快照
      // (基线还没被消费)—— 那一份要留着,起点提交不动,否则这条 run 的代码变更会丢。
      if(!running.reviewBaseline){try{running.reviewBaseline=await captureGitBaseline(running.path,{})}catch{/* 没基线就没有这一轮的代码对比,其他成果照收 */}}
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
        store.attachments.bind(attachments.map(a=>a.id),id,input.draftId,attachmentPolicy?act().continuationAttachmentScope(id,attachments):undefined)
        return store.liveInputs.add({id:requestId,taskId:id,runId:input.runId,text,attachments,execution:running.execution})
      })
    }catch(error){
      // 这一句没存下来就没有人会去写文件夹:会话还安静着,把自动收工的计时重新起上,
      // 别让一句存不下来的补充把文件夹永久锁住。
      act().armIdleClose(running)
      throw error
    }
    const runtime=running.session?.workbenchRuntime
    if(runtime){
      if(act().inputMode(running)==='queue')return saved
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
          error=>{settleRuntimeInput(running,saved,error??new Error('input_not_delivered'));act().armIdleClose(running)},
        )
      }catch(error){settleRuntimeInput(running,saved,error??new Error('input_not_delivered'));act().armIdleClose(running)}
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
    act().settleAfterDecision(running)
  }

  return { holdInputs,hasUndeliveredInput,drainInputs,settleRuntimeInput, submitInput,withdrawInput,resolveAnswer,resolvePermission }
}
export type InputsDomain = ReturnType<typeof makeInputsDomain>
