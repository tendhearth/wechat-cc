/**
 * lifecycle + settle 域:文件夹租约、空闲自动收工、回报 / 回忆去重、安静落定、占用释放、不确定退出、派发泵、取消,
 * 以及 setArchived / cancel / shutdown 三个入口。
 * 从 service.ts 逐字搬来(spec 2026-09-27-workbench-service-split §3 第 9 项);只认 ctx。
 * 这是 spec §1 说的那个环(pump → execute → settleQuiet → armIdleClose → closeForIdle → cancelRun → pump)
 * 完整经 ctx.actions 走的地方:execute 是真晚绑定,其余是别的域的查询/动作,都经 act() 在调用时取。
 * quiet 是 isReplied 的别名(原文 `const quiet=isReplied`),这里写成经 act() 取的同义包装。
 */
import { findPathBlocker } from '../scheduler'
import { publicTask, TERMINAL_TASK_STATUSES } from '../store'
import type { Active } from './state'
import type { WorkbenchTaskView } from './types'
import type { ServiceCtx } from './ctx'
import { liveRunTarget } from './call-target'
import type { CallTarget } from '../../../lib/network-gate'

/** 桌面 / 手机 / 微信同一句状态(主人 2026-10-03)。 */
export const NETWORK_SUSPENDED_LABEL='已暂停(网络未受保护)'

export function makeLifecycleDomain(ctx:ServiceCtx) {
  const { store, state } = ctx
  const act=()=>ctx.actions.deref('lifecycle')
  function revokeCredentials(running:Active) {
    if (!running.credentialsMinted || running.credentialsRevoked) return
    running.credentialsRevoked=true
    try { ctx.deps.revokeSessionToken?.(`workbench/${running.taskId}`) } catch { /* token expiry remains fail closed */ }
  }
  /**
   * 一个文件夹,同时只有一个**还能写它**的会话:占用从派发开始,到那个会话被关闭为止。
   * 「还能写」是能力不是行为 —— 一条保留下来的原生会话随时会被后台通知唤醒、自己又动手
   * (`claude-workbench-runtime` 里 `retained` 是黏性的,`foreground` 能从 idle 自己翻回 running,
   * 没有任何事件预告「我要开始写了」)。所以不存在「答复即释放」:2026-09-15 起的那套
   * 「答复即释放 + 续接再申请」以及 2026-09-21 早上为维持它而加的回合代数 / fail-closed
   * 都是在用事后观察逼近一个本来不成立的等式,这一轮整套删掉
   * (docs/superpowers/specs/2026-09-21-one-folder-one-session-design.md)。
   *
   * 文件夹让出来只有三条路:执行者自己收工(不保留会话的,流结束即结算)、主人收工、
   * **空闲自动收工**(下面的计时器)。
   */
  /** 会话安静:本轮做完、没有后台子任务在写、也没有待决权限/提问 —— 只差主人下一句话。
   *  空闲自动收工的判据就是它。 */
  const quiet=(running:Active)=>act().isReplied(running)
  // setTimeout 的合法上限是 2³¹−1 毫秒(约 24.8 天);超界的值 Node/浏览器会静默钳成 1ms 立刻触发
  // (TimeoutOverflowWarning),把「几乎不自动关」反转成「立刻收工」。这里在旋钮里就封顶,
  // 「很大的数」的实际效果因此是「最多约 24.8 天不收工」,不是真的永不武装。
  const MAX_TIMEOUT_MS=2_147_483_647
  const msKnob=(value:number|(()=>number)|undefined,fallback:number):number=>{
    let raw:unknown
    try { raw=typeof value==='function'?value():value } catch { return fallback }
    return typeof raw==='number'&&Number.isFinite(raw)&&raw>=0?Math.min(raw,MAX_TIMEOUT_MS):fallback
  }
  const handoffGraceMs=()=>msKnob(ctx.deps.handoffGraceMs,15_000)
  const retainedIdleMs=()=>msKnob(ctx.deps.retainedIdleCloseMs,600_000)
  /**
   * 会话安静下来就起一个计时器,到点关掉会话、让出文件夹。两档:有人在等这个文件夹 ⇒ 短让位;
   * 没人等 ⇒ 长空闲(别让一个闲着的原生进程占着资源)。已经排好的短让位不会被长空闲推迟。
   */
  function armIdleClose(running:Active):void {
    // 网络守护冻住期间不武装:到点去关一棵冻住的树,只会把「在等网络」判成收工(放开时 settleAfterDecision 再评估)。
    if (!quiet(running)||running.finishing||running.cancelled||running.networkSuspended||act().hasUndeliveredInput(running)) return
    const wanted=state.queue.some(item=>item.state==='queued'&&!!findPathBlocker(item,[running]))
    const ms=wanted?handoffGraceMs():retainedIdleMs()
    const at=Date.now()+ms
    const existing=running.idleClose
    if (existing&&existing.at<=at) return
    if (existing) clearTimeout(existing.timer)
    running.idleClose={timer:setTimeout(()=>closeForIdle(running),ms),at,reason:wanted?'handoff':'idle'}
  }
  function cancelIdleClose(running:Active):void {
    const armed=running.idleClose
    if (!armed) return
    running.idleClose=undefined
    clearTimeout(armed.timer)
  }
  /** 到点:再确认一遍还安静、文件夹还是它的、没在收尾,然后按「收工」关掉会话(答复早已交付,
   *  所以终态记 completed,等同主人点「结束后台会话」)。 */
  function closeForIdle(running:Active):void {
    const armed=running.idleClose
    running.idleClose=undefined
    if (!armed) return
    // 武装点已经拦过未投递的补充,这里再看一眼只是把「落笔前复查一遍」补全。
    if (!quiet(running)||state.reservations.get(running.identity)!==running||running.finishing||running.cancelled||act().hasUndeliveredInput(running)) return
    const next=state.queue.find(item=>item.state==='queued'&&!!findPathBlocker(item,[running]))
    const seconds=Math.round((armed.reason==='handoff'?handoffGraceMs():retainedIdleMs())/1000)
    const text=next
      ? `空闲 ${seconds} 秒后自动收工，文件夹让给「${next.title.replace(/[\r\n]+/g,' ')}」；要接着说直接发下一句，会按原会话恢复。`
      : `空闲 ${seconds} 秒后自动收工，释放文件夹；要接着说直接发下一句，会按原会话恢复。`
    try { store.addEvent(running.taskId,'system',text);ctx.hub.touched(running.taskId) } catch { /* 收工照走 */ }
    running.closedWhileReplied=true
    try { cancelRun(running) } catch { /* 已经在收尾的路上,留给 execute 的 finally */ }
  }
  /**
   * 回报入队,按「这是第几轮」去重(评审修复轮 1)。不进 matterSync —— 那个包装
   * 故意吞掉所有异常,回报挂进去会把"从来没报成功过"伪装成"偶尔漏一条"
   * (2026-09 的教训)。去重键是 `turnSeq`(见 Active 字段注释),不是布尔:
   * 布尔只能在「观察到静下来又动起来」那一刻复位,而这件事本身可能被漏看
   * (回合可能在探测器读到忙碌快照之前就已经又静下来),漏看 = 永久锁死不再报。
   * `turnSeq` 在更早、更可靠的同步点(`submitInput` 实际投递)就已经推进,不依赖
   * 「有没有被看见」。调用点:`settleQuiet`(答复)与终态收工(评审 #3,非
   * retained 执行者永远不经过 `settleQuiet`)都调它,序号相同则第二次是no-op。
   */
  /**
   * `body`(终审后修复第二轮 Important②b,可选,默认不传):非 retained
   * 执行者终态那一拍会传 `terminalReportBody(running)`,把
   * `stageFinishedNotice` 原本会发的正文并进回报文案。`settleQuiet` 那
   * 处调用(retained 执行者)不传——那条路没有通知被压,不需要额外正
   * 文,回报只是"事情有进展,看这里"的一句指路。
   */
  function reportOnce(running:Active,body?:string):void {
    if (running.reportedTurn===running.turnSeq) return
    running.reportedTurn=running.turnSeq
    try { ctx.deps.reports?.enqueue(running.taskId,running.turnSeq,body) } catch (err) { ctx.log?.('MATTER_REPORT',`enqueue failed for ${running.taskId}: ${err instanceof Error?err.message:err}`) }
  }
  /**
   * 回忆触发,按「这是第几轮」去重(task-5,fix round 1:与 `reportOnce` 同一套道理——
   * settleQuiet 会因为转移探测器与显式 `result` 分支各调一次而在同一个 `turnSeq` 上触发
   * 两次,不挡的话同一次答复会喂两次便宜模型、可能写两条几乎一样的回忆)。`turns` 就是
   * 调用这一刻的 `turnSeq`——它只活在这个运行时结构里,不落盘,daemon 侧的
   * RecollectSink 事后查不到,只能在这里现读现传。
   *
   * try/catch 是 fix round 2(复审新 Important ②):跟 `reportOnce` 同一套
   * 道理——`maybeTrigger` 内部的同步段(读 sqlite、读 companion config、
   * `crossedOvernight` 对非法时间戳可能抛 RangeError)任何一次抛出,若不
   * 在这里接住,会穿出两处调用点(`settleQuiet` 自己没有 try/catch;终态
   * 提交那处虽然外层有 try/catch,但那个 catch 是"never unlock an
   * uncertain writer",会把 `matterSync`/`reportOnce`/`publishFinishedNotices`
   * 一起吞掉,爆炸半径远大于只丢一次回忆判断)。概率低,但代价是这一轮
   * matter 永远到不了 replied、直接变 done,`captureCodeChanges`/
   * `armIdleClose` 全被跳过——跟 `reportOnce` 当初要挡的是同一类风险。
   */
  function recollectOnce(running:Active):void {
    if (running.recollectedTurn===running.turnSeq) return
    running.recollectedTurn=running.turnSeq
    try { ctx.deps.recollect?.maybeTrigger(running.taskId,running.turnSeq) } catch (err) { ctx.log?.('MATTER_RECOLLECT',`maybeTrigger failed for ${running.taskId}: ${err instanceof Error?err.message:err}`) }
  }
  /**
   * 本回合安静下来:登记成果(评审 2026-09-16:会话保留时这条 run 不会结算,`collect` 也就不会跑,
   * 成果得等主人「取消」才看得见)、把 matter 标成已答复、起空闲自动收工的计时。
   * 还在等主人拍板就只收成果、不计时 —— 那不叫安静。重复调用无害:收集自己去重,计时不会被推迟。
   */
  function settleQuiet(running:Active):void {
    const snapshot=act().runtimeSnapshot(running)
    // 与「该暂停了」的判据同义:回合真的停下来了才登记,否则会把半成品当成固定版本的成果发布出去。
    if (!snapshot?.retained||snapshot.foreground!=='idle'||snapshot.backgroundCount!==0) return
    act().collectTurnArtifacts(running)
    if (!quiet(running)) return
    act().matterSync(m=>m.setStatus(running.taskId,'replied'))
    reportOnce(running)
    // 回忆(task-5,fix round 3,评审必判①):不在这里调 recollectOnce 了——
    // settleQuiet 每次安静都触发一次,而持久去重(journal.hasRecollection)
    // 是"按 matter 只给一条",两者天生冲突:matter 隔夜第一次静下来就够格
    // (overnight),凭标题写一句空话,之后主人打回好几次的「波折」反而全被
    // 已经写过的那条挡住——留下的恰好是最没内容的那条,跟"最该记住的是波
    // 折"这条设计取向正相反。只在终态(下面那处 recollectOnce)触发:那时
    // turnSeq 才是这个 run 真实的轮数,"一件事一段记述"与"最该记住的是波
    // 折"只有写在结局时才同时成立。代价是回忆延迟到 idle-close(最长十分
    // 钟级),接受。
    // 差异边界 = 回合边界:这一轮的代码变更现在就截(以前这一步挂在「答复即释放」后面,
    // 那条路没了)。续接会先 await 这份在途的快照再取新基线,所以不会把下一轮的改动算进来。
    void act().captureCodeChanges(running).catch(()=>{})
    armIdleClose(running)
  }
  /**
   * 拍完板重新评估一次安静:请求**自己超时**(权限 5 分钟)那一下既没有事件也不走 resolvePermission,
   * 会话早就静下来的话没有人会回来起计时(终审 I4)。先取消再重新评估,幂等。
   */
  function settleAfterDecision(running:Active):void {
    if (running.cancelled||running.finishing) return
    cancelIdleClose(running)
    settleQuiet(running)
  }
  function releaseReservation(running:Active) {
    if (state.reservations.get(running.identity) === running) state.reservations.delete(running.identity)
    if (state.runsByTask.get(running.taskId) === running) state.runsByTask.delete(running.taskId)
    state.runningText.delete(running.identity)
    const release=running.releaseBusy; running.releaseBusy=undefined
    try { release?.() } catch { /* busy registry releases are best effort and idempotent */ }
    if (!state.stopping) pump()
  }
  async function confirmLateClose(running:Active,capture:boolean) {
    if (!running.uncertain) return
    if (capture) await act().collect(running)
    try { store.clearWriterError(running.taskId) } catch { /* keep the persistent guard if storage is unavailable */ }
    running.uncertain=false
    running.state='active'
    if (running.publicFinished) releaseReservation(running)
  }
  function markUncertain(running:Active) {
    running.uncertain=true
    running.state='uncertain'
    // 这条 run 的占用在结算时本该还回去(execute 的 finally),但它没能确认退出 —— 重新挂回去,
    // 之后到来的同文件夹任务按 writer_not_closed 等待,直到 confirmLateClose。
    state.reservations.set(running.identity,running)
  }
  function pump() {
    if (state.stopping) return
    const launch:Active[]=[]
    for (const running of state.queue) {
      if (running.state !== 'queued') continue
      const earlier=state.queue.filter(item => item.order < running.order && item.state === 'queued')
      const blocker=findPathBlocker(running,[...act().held(),...earlier])
      if (blocker) {
        // 「有人来等这个文件夹了」的唯一入口:挡路的那条会话若已经安静,就按短让位重排它的
        // 自动收工(armIdleClose 自己判安静,不安静就什么都不做)。
        const holder=state.runsByTask.get(blocker.taskId)
        if (holder&&state.reservations.get(holder.identity)===holder) armIdleClose(holder)
        continue
      }
      running.state='active'; state.reservations.set(running.identity,running); launch.push(running)
    }
    for (const running of launch) state.queue.splice(state.queue.indexOf(running),1)
    for (const running of launch) {
      void Promise.resolve().then(() => act().execute(running.task,state.runningText.get(running.identity)!,running)).catch(() => {
        if (running.publicFinished) return
        try { running.questions.close(); running.permissions.rejectAll(running.cancelled ? 'cancelled' : 'ended'); ctx.hub.bumped(running.taskId) } catch { /* fail closed */ }
        revokeCredentials(running)
        if (running.session) markUncertain(running)
        running.publicFinished=true; running.resolveDone()
        if (!running.uncertain) releaseReservation(running)
      })
    }
  }
  function cancelRun(running:Active):void {
    cancelIdleClose(running)
    running.questions.close();ctx.hub.bumped(running.taskId);act().holdInputs(running.taskId,'任务已停止，补充尚未发送。')
    if (running.state==='queued') {
      running.cancelled=true; running.permissions.rejectAll('cancelled'); ctx.hub.bumped(running.taskId); running.signalStop()
      const index=state.queue.indexOf(running); if (index>=0) state.queue.splice(index,1)
      state.runningText.delete(running.identity)
      try {
        store.atomic(()=>{store.update(running.taskId,'cancelled');act().stageFinishedNotice(running,'cancelled')})
        ctx.hub.touched(running.taskId)
        act().matterSync(m=>m.setStatus(running.taskId,'done'))
        act().publishFinishedNotices()
      } catch { /* in-memory cancellation still must settle */ }
      running.publicFinished=true; running.resolveDone()
      if (state.runsByTask.get(running.taskId)===running) state.runsByTask.delete(running.taskId)
      if (!state.stopping) pump()
      return
    }
    if (running.state==='uncertain') return
    if (!running.cancelled) {
      if (act().isReplied(running)) running.closedWhileReplied=true
      running.cancelled=true
      // 冻住的树要停(主人取消 / 暂停到顶 / daemon 关):不放开、直接整棵杀掉 —— 放开那一下它就会
      // 接着用不受保护的网络。之后的 cancel() / close() 不再指望进程配合。
      if (running.networkSuspended) {
        running.networkSuspended=undefined
        try { running.session?.suspension?.terminate() } catch { /* close 兜底 */ }
        try { running.permissions.resume() } catch { /* 下面 rejectAll 照样收掉 */ }
      }
      running.permissions.rejectAll('cancelled'); ctx.hub.bumped(running.taskId); revokeCredentials(running); running.signalStop()
      try { store.update(running.taskId,'cancelling'); ctx.hub.touched(running.taskId) } catch { /* stop the writer even when persistence is unavailable */ }
      try { if (running.session?.cancel) void running.session.cancel().catch(() => {}) }
      catch { try { store.addEvent(running.taskId,'system','已请求停止，正在等待执行程序退出。');ctx.hub.touched(running.taskId) } catch { /* cancellation remains active */ } }
    }
  }
  /**
   * 网络守护「暂停在跑的任务」(主人 2026-10-03):probe 来源连续两次不安全 ⇒ **冻住**需要保护的执行者
   * (SIGSTOP 整棵进程树),不停。`select` 返回这条 run 的说明 = 需要保护;null = 不需要保护,不动。
   *
   * 冻得住的(会话实现了 suspension、且这一下真的冻住了):记 networkSuspended,daemon 侧为它起的计时器
   * 一律停表 —— 回合看门狗按「在等」算(execute.ts)、批准期限停表、空闲收工撤掉不武装;时间线记一句、
   * 订了微信提醒的发一条「已暂停(网络未受保护)」。
   * 冻不住的(执行者没实现 / 沙盒里没验证过能接上:agy、Cursor ACP、openai API;win32;会话还没起来):
   * 退回原来的停法(#191 那一套:记一句、按取消停下,之后照常可以「继续」)。排队的不动 —— 轮到它时闸门会按调用拦。
   */
  function suspendForNetwork(select:(run:{providerId:string;model:string|null;target:CallTarget})=>string|null):{suspended:number;stopped:number} {
    let suspended=0,stopped=0
    for (const running of [...state.runsByTask.values()]) {
      if (running.cancelled||running.finishing||running.state!=='active'||running.networkSuspended) continue
      let message:string|null
      try { message=select({providerId:running.task.providerId,model:running.execution.model,target:liveRunTarget(running,ctx.deps.registry.get(running.task.providerId)?.provider)}) } catch { message=null }
      if (message===null) continue
      let frozen=false
      try { frozen=!!running.session?.suspension?.suspend() } catch { frozen=false }
      if (frozen) {
        running.networkSuspended={since:Date.now()}
        cancelIdleClose(running)
        try { running.permissions.pause() } catch { /* 期限照走也只是拒掉那一张卡 */ }
        const text=`${NETWORK_SUSPENDED_LABEL}：${message}恢复后自动继续。`
        try { store.addEvent(running.taskId,'system',text,null,running.identity); ctx.hub.touched(running.taskId) } catch { /* 冻住照样生效 */ }
        try { act().enqueueNotice?.(running.task,running.identity,'interrupted',`${running.title.replace(/[\r\n]+/g,' ')} · ${running.taskId}\n${running.task.providerId} · ${NETWORK_SUSPENDED_LABEL}\n\n${message}恢复后自动继续。\n\n查看：任务 ${running.taskId}`,`network-suspend-${running.networkSuspended.since}`) } catch { /* 提醒失败不影响暂停 */ }
        ctx.hub.bumped(running.taskId)
        suspended++
        continue
      }
      try { store.addEvent(running.taskId,'system',`网络未受保护：${message}这个执行者暂停不了，已停止本轮，恢复后可以继续。`); ctx.hub.touched(running.taskId) } catch { /* 停仍然要停 */ }
      try { cancelRun(running); stopped++ } catch { /* 下一个照停 */ }
    }
    return {suspended,stopped}
  }
  /** 网络恢复(probe 读到安全,或改用 bx):放开冻住的树,计时器从这一刻接着走。返回放开了几个。 */
  function resumeFromNetwork():number {
    let n=0
    for (const running of [...state.runsByTask.values()]) {
      if (!running.networkSuspended) continue
      running.networkSuspended=undefined
      try { running.session?.suspension?.resume() } catch { /* 放不开的会由它自己的错误收尾 */ }
      // 回合看门狗从放开这一刻重新算(collectWorkbenchTurn 看的是 max(起点, interactionAt))。
      running.interactionAt=Date.now()
      try { running.permissions.resume() } catch { /* best effort */ }
      try { store.addEvent(running.taskId,'system','网络恢复，已继续。',null,running.identity); ctx.hub.touched(running.taskId) } catch { /* 放开照样生效 */ }
      ctx.hub.bumped(running.taskId)
      settleAfterDecision(running)
      n++
    }
    return n
  }
  /** 暂停到顶(guard.json max_suspend_minutes,缺省 30 分钟)还没恢复:按收工停下(冻住的树直接杀,不放开),终态通知用 `message`。 */
  function stopSuspendedForNetwork(message:string):number {
    let n=0
    for (const running of [...state.runsByTask.values()]) {
      if (!running.networkSuspended) continue
      running.stopNotice=message
      try { store.addEvent(running.taskId,'system',message,null,running.identity); ctx.hub.touched(running.taskId) } catch { /* 停仍然要停 */ }
      try { cancelRun(running); n++ } catch { /* 下一个照停 */ }
    }
    return n
  }
  /** 此刻被网络守护冻住的任务(health / `guard status` / 手机)。 */
  function networkSuspended():Array<{taskId:string;title:string;providerId:string;since:number}> {
    return [...state.runsByTask.values()].flatMap(r=>r.networkSuspended?[{taskId:r.taskId,title:r.title,providerId:r.task.providerId,since:r.networkSuspended.since}]:[])
  }
  function setArchived(id:string,archived:boolean):WorkbenchTaskView {
    if(typeof archived!=='boolean')throw new Error('invalid_request')
    const task=store.get(id)
    if(archived && !act().taskView(publicTask(task)).canArchive)throw new Error('workbench_busy')
    const view=act().taskView(publicTask(store.setArchived(id,archived)))
    // store.setArchived 是裸 UPDATE,不像别的写点那样自带 bump —— archivedAt 在 detail 里能看见,补一下。
    ctx.hub.bumped(id)
    act().matterSync(m=>m.setStatus(id,archived?'archived':view.status==='interrupted'?'open':TERMINAL_TASK_STATUSES.includes(view.status)?'done':view.phase==='replied'?'replied':'open'))
    return view
  }
  async function cancel(id:string,expectedRunId?:string):Promise<WorkbenchTaskView> {
    const running=state.runsByTask.get(id)
    if(expectedRunId!==undefined&&running?.identity!==expectedRunId)throw new Error('control_stale')
    // cancelRun 落库时自己 touched;没有 running(任务不在跑)时这里兜底一下,
    // 停止请求本身也算一次「详情可能变了」。
    if (running) cancelRun(running)
    else ctx.hub.bumped(id)
    return act().taskView(publicTask(store.get(id)))
  }
  function shutdown():Promise<void> {
    if (state.shutdownPromise) return state.shutdownPromise
    state.stopping=true
    state.shutdownPromise=(async () => {
      const snapshot=[...state.runsByTask.values()]
      for (const running of snapshot) {
        try { cancelRun(running) }
        catch {
          running.cancelled=true
          try { running.permissions.rejectAll('cancelled'); ctx.hub.bumped(running.taskId) } catch { /* fail closed */ }
          revokeCredentials(running); running.signalStop()
          try { if (running.session?.cancel) void running.session.cancel().catch(() => {}) } catch { /* close still follows */ }
        }
      }
      await Promise.allSettled(snapshot.map(running => running.done))
      while(state.collections.size)await Promise.allSettled([...state.collections])
      state.shutdownComplete=true
      for (const running of [...state.runsByTask.values()]) releaseReservation(running)
      ctx.hub.dispose()
    })()
    return state.shutdownPromise
  }

  return { revokeCredentials,quiet,handoffGraceMs,retainedIdleMs,armIdleClose,cancelIdleClose,closeForIdle,reportOnce,recollectOnce,settleQuiet,settleAfterDecision,releaseReservation,confirmLateClose,markUncertain,pump,cancelRun,suspendForNetwork,resumeFromNetwork,stopSuspendedForNetwork,networkSuspended, setArchived,cancel,shutdown }
}
export type LifecycleDomain = ReturnType<typeof makeLifecycleDomain>
