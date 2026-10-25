/**
 * 主人补充的落库记账:持有(hold)、「还有没投出去的吗」、投递结果落定(settle)。
 *
 * 原来在 inputs 域里,可 lifecycle 也要用(取消时 hold、空闲收工前问 hasUndeliveredInput),
 * 而 inputs 反过来要 lifecycle 的计时动作 —— 两个域互相要,只能靠晚绑定。
 * 这三个函数只认 ctx(store + state),不碰任何别的域,搬到这里之后 lifecycle 和 inputs 都依赖它,
 * 彼此之间只剩 inputs → lifecycle 一个方向。execute 收尾也直接用它。
 */
import { sameAttachments, type LiveInput } from '../../../adapters/store/workbench/live-inputs'
import type { ServiceCtx } from './ctx'
import type { Active } from './state'

const INPUT_UNCONFIRMED='未确认执行者收到，请检查当前对话后再决定是否重发。'

export function makePendingInputs(ctx:ServiceCtx) {
  const { store, state } = ctx
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

  return { holdInputs, hasUndeliveredInput, settleRuntimeInput }
}
export type PendingInputs = ReturnType<typeof makePendingInputs>
