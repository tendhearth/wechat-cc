/**
 * notices 域:微信提醒的入队 / 终态通知 / 唤醒,成果投递,订阅开关。
 * 从 service.ts 逐字搬来(spec 2026-09-27-workbench-service-split §3 第 4 项);只认 ctx。
 * 跨域两处走 ctx.actions 晚绑定:终态文案要 quota 域的 fallbackExecutor,成果投递要 service.artifact。
 * stageFinishedNotice 由 execute / cancelRun 在 store.atomic 里同步调用 —— 这里不许变成 async。
 */
import { executionFailureMessage } from '../execution-settings'
import { normalizeInputRequestId } from '../live-inputs'
import { WORKBENCH_PERMISSION_TIMEOUT_MS } from '../permissions'
import { providerDisplayName } from '../../provider-display-names'
import { TERMINAL_TASK_STATUSES, type StoredTask, type TaskStatus } from '../store'
import type { WechatNoticeKind, WechatNotificationNotice, WechatNotificationSubscription } from '../wechat-notifications'
import type { ArtifactDeliveryReceipt } from '../artifact-deliveries'
import type { SendWechatArtifact } from '../wechat-types'
import type { Active } from './state'
import type { ServiceCtx } from './ctx'

/** 由 provider 结构化码而来的失败(execution-settings.taskErrorForProviderCode):通知里说原因。 */
const PROVIDER_FAILURE_NOTICE=new Set(['provider_auth_expired','provider_auth_rejected','provider_network','provider_server_error','provider_invalid_request'])

export interface NoticesDomain {
  wakeNotices(context?:{ownerChatId:string;accountId:string}): void
  enqueueNotice(task:StoredTask,runId:string,kind:WechatNoticeKind,text:string,requestId?:string|null): void
  requestNotice(task:StoredTask,runId:string,kind:'permission'|'question',id:string,label:string): void
  terminalReportBody(running:Active): string|undefined
  stageFinishedNotice(running:Active,status:TaskStatus,error?:string|null,suppressCompleted?:boolean): void
  publishFinishedNotices(): void
  setArtifactDelivery(deliver:((id:string)=>Promise<ArtifactDeliveryReceipt>)|undefined): void
  artifactDeliveryEligible(receipt:ArtifactDeliveryReceipt): boolean
  deliverWechatArtifact(input:SendWechatArtifact): Promise<ArtifactDeliveryReceipt>
  setNotificationWake(wake:(context?:{ownerChatId:string;accountId:string})=>Promise<void>): void
  contextAvailable(ownerChatId:string,accountId:string): void
  notificationEligible(notice:WechatNotificationNotice): boolean
  setWechatWatch(id:string,accountId:string,enabled:boolean): WechatNotificationSubscription
}

export function makeNoticesDomain(ctx:ServiceCtx):NoticesDomain {
  const { store, state } = ctx
  const wakeNotices=(context?:{ownerChatId:string;accountId:string})=>queueMicrotask(()=>{if(!state.stopping)void state.noticeWake(context).catch(()=>{})})
  function enqueueNotice(task:StoredTask,runId:string,kind:WechatNoticeKind,text:string,requestId:string|null=null){
    try{
      const watch=store.wechatNotifications.subscription(task.id)
      if(!watch?.enabled||watch.ownerChatId!==task.ownerChatId||watch.ownerChatId!==ctx.deps.ownerChatId())return
      store.wechatNotifications.enqueue({taskId:task.id,runId,ownerChatId:watch.ownerChatId,accountId:watch.accountId,kind,requestId,text:text.slice(0,4000)})
      wakeNotices()
    }catch{
      // A notification failure must not deny a valid permission or terminate execution.
      try{store.addEvent(task.id,'system','微信提醒未能保存；任务仍可在工作台查看。',null,runId);ctx.hub.touched(task.id)}catch{}
    }
  }
  function requestNotice(task:StoredTask,runId:string,kind:'permission'|'question',id:string,label:string){
    enqueueNotice(task,runId,kind,`${task.title.replace(/[\r\n]+/g,' ')} · ${task.id}\n${task.providerId} · ${kind==='permission'?'需要你批准':'需要你回答'}\n\n${label.slice(0,600)}\n\n查看：任务 ${task.id} ${kind==='permission'?'权限':'问题'} ${id}`,id)
  }
  /**
   * 终审后修复第二轮 Important②b:非 retained 执行者 completed 终态时,
   * `stageFinishedNotice` 的 completed 通知被压掉——被压掉的正文必须并
   * 进回报文案,否则等于用"去噪"换掉了"主人被动收到答案"这件事(spec 开
   * 头那句:交给 CC 之后能放心离开、回来接得上)。这里读的是跟
   * `stageFinishedNotice` 同一份数据(这一轮最后一条文本事件 + 保存的成
   * 果文件名),但故意**不是**同一个函数——`stageFinishedNotice` 还有
   * failed 时改写额度耗尽文案那一支,那部分只在通知里有意义,不该混进
   * 回报文案。
   */
  function terminalReportBody(running:Active):string|undefined {
    const reply=store.events(running.taskId).filter(e=>e.runId===running.identity&&e.kind==='text').at(-1)?.text
    const artifacts=store.artifacts(running.taskId).slice(0,5)
    const parts=[reply?reply.slice(0,1800):undefined,artifacts.length?'已保存成果：'+artifacts.map(a=>a.name).join('、').slice(0,500):undefined].filter((s):s is string=>!!s)
    return parts.length?parts.join('\n\n'):undefined
  }
  /**
   * `suppressCompleted`(终审 Important,终审后修复第二轮 Important②改
   * 过一次判据):非 retained 执行者(agy/cursor/openai/gemini)不经过
   * settleQuiet,这个函数与 `reportOnce` 同在终态那个 try 里、同一拍触
   * 发——不挡的话 completed 那一刻两条都发主人 chat:先「…这一轮已完
   * 成…查看:任务 xxx」,紧跟「…已答复。累计生成了 N 份成果。看:… 接
   * 着说:…」,同一件事说了两遍(spec 已定 #1「再报一次是噪音」的理由原
   * 样适用,只是这次是两条不同措辞的消息同时发,不是同一条重发)。
   *
   * 判据不是"这一轮有没有出生地"那么简单(终审后修复第二轮 Important②a
   * 改正:上一版这么写,把 retained 执行者也误伤了——retained 执行者到
   * 这里之前已经在 `settleQuiet` 报过这一轮,这里的 `reportOnce` 调用因
   * `reportedTurn===turnSeq` 本来就是 no-op,根本不存在"同一拍双发",通
   * 知却照样被压掉了)。真正的判据是调用点算出来的 `willReport`——"这
   * 一拍 `reportOnce` 真的会入队"(有出生地 **且** 不是因为
   * `reportedTurn===turnSeq` 而 no-op),只在这个条件成立时才压。
   *
   * 压的时候留的不是"信息更丰富"的空话(上一版这么写,但回报模板只有
   * `标题 · 已答复(第N轮)。看:… · 接着说:…`,没有正文——那句理由是假
   * 的,终审后修复第二轮 Important②b 点名的说谎注释,已改正)。真正的
   * 理由是:调用点把这一轮的答复正文 + 成果文件名(`terminalReportBody`,
   * 跟这个函数原来自己读的是同一份数据)并进了回报文案里再传给
   * `reportOnce`——压的是通知外壳,正文本身**没有**被丢掉,只是换了个
   * 地方送达。桌面亲手派的任务没有出生地、`reportOnce` 什么都不会发,那
   * 种情况必须继续留着这条通知,不能无条件压。
   */
  function stageFinishedNotice(running:Active,status:TaskStatus,error:string|null=null,suppressCompleted=false){
    if(!TERMINAL_TASK_STATUSES.includes(status))return
    if(status==='completed'&&suppressCompleted)return
    const watch=store.wechatNotifications.subscription(running.taskId)
    if(!watch?.enabled||watch.ownerChatId!==running.task.ownerChatId||watch.ownerChatId!==ctx.deps.ownerChatId())return
    let reply=store.events(running.taskId).filter(e=>e.runId===running.identity&&e.kind==='text').at(-1)?.text
    const label={completed:'这一轮已完成',failed:'这一轮需要处理',interrupted:'这一轮已中断',cancelled:'这一轮已停止'}[status as 'completed'|'failed'|'interrupted'|'cancelled']
    if(status==='failed'&&(error==='provider_quota_exhausted'||error==='provider_rate_limited')){
      const code=error,other=ctx.actions.deref('notices').fallbackExecutor(running.task.providerId)
      reply=`${executionFailureMessage(code)}${other?`\n交给 ${providerDisplayName(other)} 继续？回「是」我就把这件事交给它。`:''}`
    }else if(status==='failed'&&error&&PROVIDER_FAILURE_NOTICE.has(error)){
      // 认证 / 网络 / 服务端:微信里说老实的原因,而不是最后一段(可能是半截的)回复正文。
      reply=executionFailureMessage(error)
    }
    const artifacts=store.artifacts(running.taskId).slice(0,5)
    const text=`${running.title.replace(/[\r\n]+/g,' ')} · ${running.taskId}\n${running.task.providerId} · ${label}\n\n${reply?reply.slice(0,1800)+'\n\n':''}${artifacts.length?'已保存成果：'+artifacts.map(a=>a.name).join('、').slice(0,500)+'\n\n':''}查看：任务 ${running.taskId}\n结果：任务 ${running.taskId} 结果`
    // Persist the frozen result in the same transaction as the terminal task status.
    store.wechatNotifications.stage({taskId:running.taskId,runId:running.identity,ownerChatId:watch.ownerChatId,accountId:watch.accountId,kind:status as WechatNoticeKind,text:text.slice(0,4000)})
  }
  function publishFinishedNotices(){
    try{store.wechatNotifications.materializeIntents()}catch{/* The durable intent remains available to the worker or next startup. */}
    wakeNotices()
  }

  return {
    wakeNotices,enqueueNotice,requestNotice,terminalReportBody,stageFinishedNotice,publishFinishedNotices,
    setArtifactDelivery(deliver:((id:string)=>Promise<ArtifactDeliveryReceipt>)|undefined){state.artifactDelivery=deliver},
    artifactDeliveryEligible(receipt:ArtifactDeliveryReceipt):boolean{
      return !state.stopping&&receipt.ownerChatId===ctx.deps.ownerChatId()&&store.get(receipt.taskId).ownerChatId===receipt.ownerChatId
    },
    async deliverWechatArtifact(input:SendWechatArtifact):Promise<ArtifactDeliveryReceipt>{
      ctx.ensureAccepting()
      if(!input.ownerChatId||input.ownerChatId!==ctx.deps.ownerChatId()||!input.accountId?.trim()||store.get(input.taskId).ownerChatId!==input.ownerChatId)throw Error('invalid_wechat_identity')
      const id=normalizeInputRequestId(input.requestId)
      if(!/^[a-f0-9]{64}$/.test(input.commandHash))throw Error('invalid_request')
      if(store.controlReceipts.get(id)||store.liveInputs.get(id)||store.creationReceipts.get(id))throw Error('artifact_delivery_conflict')
      const prior=store.artifactDeliveries.get(id)
      if(prior){
        if(prior.taskId!==input.taskId||prior.artifactId!==input.artifactId||prior.ownerChatId!==input.ownerChatId||prior.accountId!==input.accountId||prior.commandHash!==input.commandHash)throw Error('artifact_delivery_conflict')
        if(prior.status==='accepted'||prior.status==='unknown'||prior.status==='blocked')return prior
      }
      if(!state.artifactDelivery)throw Error('artifact_transport_unavailable')
      if(!prior){
        const artifact=ctx.actions.deref('notices').artifact(input.taskId,input.artifactId)
        store.artifactDeliveries.reserve({id,commandHash:input.commandHash,taskId:input.taskId,artifactId:input.artifactId,ownerChatId:input.ownerChatId,accountId:input.accountId,artifactSha256:artifact.sha256,name:artifact.name,mime:artifact.mime,size:artifact.size})
      }
      return state.artifactDelivery(id)
    },
    setNotificationWake(wake:(context?:{ownerChatId:string;accountId:string})=>Promise<void>){state.noticeWake=wake},
    contextAvailable(ownerChatId:string,accountId:string){if(ownerChatId===ctx.deps.ownerChatId())wakeNotices({ownerChatId,accountId})},
    notificationEligible(notice:WechatNotificationNotice):boolean {
      const task=store.get(notice.taskId),watch=store.wechatNotifications.subscription(notice.taskId)
      if(!watch?.enabled||ctx.deps.ownerChatId()!==notice.ownerChatId||task.ownerChatId!==notice.ownerChatId||watch.ownerChatId!==notice.ownerChatId||watch.accountId!==notice.accountId||watch.generation!==notice.subscriptionGeneration)return false
      if(notice.kind!=='permission'&&notice.kind!=='question')return true
      const run=ctx.state.runsByTask.get(notice.taskId)
      if(!run||run.identity!==notice.runId||run.cancelled||run.finishing||run.uncertain)return false
      return notice.kind==='permission'
        ?run.permissions.pending().some(p=>p.id===notice.requestId&&Date.now()<p.createdAt+(ctx.deps.permissionTimeoutMs??WORKBENCH_PERMISSION_TIMEOUT_MS))
        :run.questions.pending().some(q=>q.id===notice.requestId)
    },
    setWechatWatch(id:string,accountId:string,enabled:boolean){
      const task=store.get(id)
      if(!task.ownerChatId||task.ownerChatId!==ctx.deps.ownerChatId()||!accountId?.trim())throw Error('invalid_wechat_identity')
      const watch=store.wechatNotifications.watch(id,task.ownerChatId,accountId,enabled)
      const run=ctx.state.runsByTask.get(id)
      if(enabled&&run){
        for(const p of run.permissions.pending())requestNotice(task,run.identity,'permission',p.id,`${p.tool} · ${p.description}`)
        for(const q of run.questions.pending())requestNotice(task,run.identity,'question',q.id,q.questions.map(q=>q.question).join('\n'))
      }
      wakeNotices();return watch
    },
  }
}
