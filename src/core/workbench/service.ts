import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import type { AgentEvent, AgentSession } from '../agent-provider'
import type { ProviderRegistry } from '../provider-registry'
import { TIER_PROFILES, sessionAuthEnv } from '../user-tier'
import { canonicalProject, collectArtifacts, outputDirectory, readArtifactSnapshot, saveArtifactSnapshot } from './artifacts'
import { captureGitBaseline, finishGitReview, serializeGitReview, GIT_REVIEW_MIME, type GitBaseline } from './git-review'
import { decodeNativeHistoryKey, normalizeHistoryList, normalizeHistoryRead, type NativeHistoryReader, type NativeHistoryProvider, type NativeHistoryListInput, type NativeHistoryReadInput } from './native-history'
import {readNativeImport,nativeImportInput,publicSource,pageInput,nativeResumeToken,snapshotHash,type ImportPage,type NativeImportInput,type NativeResumeDecision,type AcceptedNativeResume} from './native-adoption'
import {historyDeadline} from './native-history'
import {handoffToken,handoffTokenHash,validateHandoffInput,handoffArtifactText,handoffContext,type HandoffInput,type HandoffPreview,type ArtifactSelection} from './handoff'
import {pathsConflict} from './scheduler'
import { restartPreview, type Continuation, type RestartPreview } from './continuation'
import { makeRunPermissions, type PermissionDecision, type RunPermissions, WORKBENCH_PERMISSION_TIMEOUT_MS } from './permissions'
import { findPathBlocker, type PathReservation, type WaitingFor } from './scheduler'
import { publicTask, TERMINAL_TASK_STATUSES, type WorkbenchListQuery, type StoredTask, type Task, type TaskStatus, type WorkbenchStore } from './store'

interface Options {
  store: WorkbenchStore
  registry: ProviderRegistry
  stateDir: string
  ownerChatId: () => string | null
  defaultProvider?: string
  executionConflict?:(path:string,providerId:string,nativeId:string|null)=>boolean
  nativeHistory?:Partial<Record<NativeHistoryProvider,NativeHistoryReader>>
  mintSessionToken?: (sessionKey: string) => string
  revokeSessionToken?: (sessionKey: string) => void
  holdBusy?: (label: string) => () => void
  timeoutMs?: number
  closeTimeoutMs?: number
  permissionTimeoutMs?: number
}
type AcceptedContinuation = { mode: 'new' } | { mode: 'resume'; sessionId: string } | { mode: 'restart'; preview: RestartPreview }
interface Active extends PathReservation {
  handoffId?:string
  handoffArtifacts?:ArtifactSelection[]
  nativeResume?:AcceptedNativeResume
  reviewBaseline?: GitBaseline
  continuation: AcceptedContinuation
  task: StoredTask
  directoryIdentity: string
  cancelled: boolean
  session?: AgentSession
  done: Promise<void>
  resolveDone: () => void
  stop: Promise<null>
  signalStop: () => void
  permissions: RunPermissions
  releaseBusy?: () => void
  publicFinished: boolean
  uncertain: boolean
  artifactsCollected: boolean
  collection?:Promise<void>
  credentialsMinted: boolean
  credentialsRevoked: boolean
}
export interface CreateTask { title?: string; path: string; providerId: string; text: string }
export interface WorkbenchTaskView extends Task { importedOnly?:boolean; canArchive:boolean; waitingFor: WaitingFor | null; pendingPermissionCount?: number }

function checkedText(text: string): string {
  if (typeof text !== 'string' || !text.trim() || text.length > 20_000) throw new Error('invalid_text')
  return text.trim()
}
function directoryIdentity(path:string):string {
  const stat=statSync(path,{bigint:true})
  if (!stat.isDirectory()) throw new Error('invalid_path')
  return `${stat.dev}:${stat.ino}`
}
const RECOVERY_MESSAGE='原执行会话暂时无法恢复。请打开桌面工作台，查看恢复选项并确认是否带此前记录重新开始。'
const SUPPORTED = ['claude','codex']
const STATUS_NAMES: Record<string,string> = {
  queued:'准备开始',running:'正在处理',cancelling:'正在停止',completed:'这一轮已完成',failed:'需要处理',cancelled:'已停止',interrupted:'已中断',
}

/** Cancellation must clear the idle timer even if a broken adapter leaves next() pending. */
async function collectWorkbenchTurn(events: AsyncIterable<AgentEvent>, stop: Promise<null>, timeoutMs: number, observe: (event: AgentEvent) => void) {
  const iterator=events[Symbol.asyncIterator]()
  let result: Extract<AgentEvent,{kind:'result'}> | undefined
  let error: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    for (;;) {
      const step=await Promise.race([
        iterator.next(),stop,
        new Promise<never>((_resolve,reject) => { timer=setTimeout(() => reject(new Error('turn_timeout')),timeoutMs) }),
      ])
      if (timer) { clearTimeout(timer); timer=undefined }
      if (!step) return null
      if (step.done) return { result,error }
      observe(step.value)
      if (step.value.kind==='result') result=step.value
      if (step.value.kind==='error') error=step.value.message
    }
  } finally {
    if (timer) clearTimeout(timer)
    void Promise.resolve(iterator.return?.()).catch(() => {})
  }
}

export function makeWorkbenchService(opts: Options) {
  const { store } = opts
  const runsByTask=new Map<string,Active>()
  const reservations=new Map<string,Active>()
  const queue:Active[]=[]
  const runningText=new Map<string,string>()
  const collections=new Set<Promise<void>>()
  const nativeDecisions=new Map<string,AcceptedNativeResume>()
  const handoffDecisions=new Map<string,{preview:HandoffPreview;sourceVersion:string;targetVersion:string|null;directoryIdentity:string;expiresAt:number}>()
  let order=0
  let stopping=false
  let shutdownComplete=false
  let shutdownPromise:Promise<void> | undefined
  store.recover()

  function provider(id: string) {
    const entry = SUPPORTED.includes(id) ? opts.registry.get(id) : null
    if (!entry) throw new Error('unavailable_provider')
    return entry
  }
  function canResume(task:StoredTask):boolean {
    try { return !!task.sessionId && !!provider(task.providerId).opts.canResume(task.path,task.sessionId) }
    catch { return false }
  }
  function continuation(task:StoredTask):Continuation {
    const events=store.events(task.id)
    if (!events.some(event => event.kind==='user' || event.kind==='text')) return {mode:'new'}
    if (canResume(task)) return {mode:'resume'}
    return {mode:'restart_required',restart:restartPreview(task,events)}
  }
  function taskVersion(task:StoredTask){return snapshotHash(JSON.stringify({updatedAt:task.updatedAt,status:task.status,sessionId:task.sessionId,events:store.events(task.id),source:store.source(task.id)?.firstDispatchedAt}))}
  function nativeReader(id:string){const reader=opts.nativeHistory?.[id as NativeHistoryProvider];if(!reader)throw new Error('native_history_unsupported');return reader}
  async function currentNativePages(task:StoredTask,pages:ImportPage[]) {
    const call=historyDeadline(),key=Buffer.from(JSON.stringify({v:1,providerId:task.providerId,nativeId:store.source(task.id)!.nativeId})).toString('base64url')
    const current:ImportPage[]=[]
    for(const page of pages){
      const preview=await call(()=>nativeReader(task.providerId).read(key,pageInput(page)))
      if(preview.session.key!==key||preview.session.cwd!==task.path)throw new Error('native_history_changed')
      if(preview.session.remote||preview.session.observedState==='active'||opts.executionConflict?.(task.path,task.providerId,store.source(task.id)!.nativeId))throw new Error('native_session_busy')
      current.push({...page,sourceFingerprint:preview.sourceFingerprint})
    }
    return current
  }
  async function validateNativeDecision(task:StoredTask,decision:AcceptedNativeResume,dispatch=false) {
    if(decision.taskId!==task.id||decision.sourceId!==store.source(task.id)?.id||decision.expiresAt<Date.now()||(!dispatch&&decision.taskVersion!==taskVersion(task)))throw new Error('external_close_confirmation_stale')
    if(directoryIdentity(task.path)!==decision.directoryIdentity||canonicalProject(task.path)!==task.path)throw new Error('invalid_path')
    if(opts.executionConflict?.(task.path,task.providerId,decision.nativeId))throw new Error('native_session_busy')
    if(decision.mode==='native_resume'){
      if(task.sessionId!==decision.nativeId||!canResume(task))throw new Error('restart_confirmation_required')
      const current=await currentNativePages(task,decision.pages)
      if(JSON.stringify(current)!==JSON.stringify(decision.pages))throw new Error('external_close_confirmation_stale')
    }
  }
  function ensureAccepting() {
    if (stopping) throw new Error('workbench_stopping')
  }
  function waitingFor(running:Active):WaitingFor|null {
    if (running.state !== 'queued') return null
    const earlier=queue.filter(item => item.order < running.order && item.state === 'queued')
    return findPathBlocker(running,[...reservations.values(),...earlier])
  }
  function taskView(task:Task, includePermissions=false):WorkbenchTaskView {
    const running=runsByTask.get(task.id)
    return {
      ...task,
      ...(!running&&TERMINAL_TASK_STATUSES.includes(task.status)&&store.source(task.id)?.firstDispatchedAt===null?{importedOnly:true}:{}),
      canArchive:TERMINAL_TASK_STATUSES.includes(task.status) && !running && task.error!=='writer_not_closed',
      waitingFor:running ? waitingFor(running) : null,
      ...(includePermissions ? { pendingPermissionCount:running?.permissions.pending().length ?? 0 } : {}),
    }
  }
  function collect(running:Active):Promise<void> {
    if(running.collection)return running.collection
    if(shutdownComplete)return Promise.resolve()
    const pending=captureOutputs(running)
    running.collection=pending;collections.add(pending)
    void pending.then(()=>collections.delete(pending),()=>collections.delete(pending))
    return pending
  }
  async function captureOutputs(running:Active) {
    if (running.artifactsCollected || shutdownComplete) return
    running.artifactsCollected=true
    try {
      if (canonicalProject(running.path) !== running.path || directoryIdentity(running.path) !== running.directoryIdentity) throw new Error('invalid_path')
      if(running.reviewBaseline && running.session) {
        try {
          const report=await finishGitReview(running.reviewBaseline)
          if(shutdownComplete)return
          if(canonicalProject(running.path)!==running.path || directoryIdentity(running.path)!==running.directoryIdentity)throw new Error('invalid_path')
          if(report)saveArtifactSnapshot(store,running.taskId,{name:`代码变更-${running.identity.slice(0,8)}.json`,mime:GIT_REVIEW_MIME,bytes:serializeGitReview(report)},opts.stateDir)
        } catch { store.addEvent(running.taskId,'system','代码对比未能保存；其他成果仍会单独收集。') }
      }
      if(canonicalProject(running.path)!==running.path || directoryIdentity(running.path)!==running.directoryIdentity)throw new Error('invalid_path')
      for (const warning of collectArtifacts(store,running.taskId,running.path,opts.stateDir)) store.addEvent(running.taskId,'system',warning)
    }
    catch { try { store.addEvent(running.taskId,'system','本轮成果目录无法读取，请检查文件夹权限或是否被移动。') } catch { /* storage is already unavailable */ } }
  }
  function revokeCredentials(running:Active) {
    if (!running.credentialsMinted || running.credentialsRevoked) return
    running.credentialsRevoked=true
    try { opts.revokeSessionToken?.(`workbench/${running.taskId}`) } catch { /* token expiry remains fail closed */ }
  }
  function releaseReservation(running:Active) {
    if (reservations.get(running.identity) === running) reservations.delete(running.identity)
    if (runsByTask.get(running.taskId) === running) runsByTask.delete(running.taskId)
    runningText.delete(running.identity)
    const release=running.releaseBusy; running.releaseBusy=undefined
    try { release?.() } catch { /* busy registry releases are best effort and idempotent */ }
    if (!stopping) pump()
  }
  async function confirmLateClose(running:Active,capture:boolean) {
    if (!running.uncertain) return
    if (capture) await collect(running)
    try { store.clearWriterError(running.taskId) } catch { /* keep the persistent guard if storage is unavailable */ }
    running.uncertain=false
    running.state='active'
    if (running.publicFinished) releaseReservation(running)
  }
  function markUncertain(running:Active) {
    running.uncertain=true
    running.state='uncertain'
  }

  async function execute(task:StoredTask,text:string,running:Active) {
    const sessionKey=`workbench/${task.id}`
    let finalStatus:TaskStatus='failed'
    let finalError:string|null=null
    let spawning:Promise<AgentSession>|undefined
    let spawnRejected=false
    let accepted=false
    try {
      running.releaseBusy=opts.holdBusy?.(sessionKey)
      if (canonicalProject(task.path) !== running.path || directoryIdentity(running.path) !== running.directoryIdentity) throw new Error('invalid_path')
      if(opts.executionConflict?.(task.path,task.providerId,task.sessionId))throw new Error('native_session_busy')
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
      }
      const directory=outputDirectory(running.path,task.id)
      const entry=provider(task.providerId)
      const instructions=[
        `你是 CC 的工作助手。当前任务编号 ${task.id}，任务：${task.title}。`,
        `本任务工作目录：${running.path}。成果目录：${directory}。`,
        '只根据当前任务、选定文件夹和本任务历史工作，不读取个人陪伴记忆或其他任务。',
        '保留原始输入，除非用户明确要求修改。将待交付文件放入上述成果目录，最后说明生成了哪些文件和验证结果。',
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
      for(const ref of running.handoffArtifacts??[])handoffArtifactText(store,ref,ref.taskId,opts.stateDir)
      if(running.cancelled){finalStatus='cancelled';return}
      if(opts.executionConflict?.(task.path,task.providerId,task.sessionId))throw new Error('native_session_busy')
      const token=opts.mintSessionToken?.(sessionKey)
      running.credentialsMinted=!!opts.mintSessionToken
      if (running.cancelled) revokeCredentials(running)
      store.update(task.id,running.cancelled ? 'cancelling' : 'running')
      if (running.cancelled) { finalStatus='cancelled'; return }
      spawning=entry.provider.spawn({alias:`workbench:${task.id}`,path:running.path},{
        tierProfile:TIER_PROFILES.trusted,permissionMode:'strict',chatId:task.ownerChatId ?? `workbench:${task.id}`,
        ...(resume ? {resumeSessionId:resume} : {}),mcpEnv:sessionAuthEnv('trusted',token),appendInstructions:instructions,
        requestPermission:(request,signal) => running.permissions.request(request,signal),
      }).catch(error => { spawnRejected=true; throw error })
      let spawnTimer:ReturnType<typeof setTimeout>|undefined
      try {
        const session=await Promise.race([
          spawning,running.stop,
          new Promise<never>((_resolve,reject) => { spawnTimer=setTimeout(() => reject(new Error('session_start_timeout')),opts.timeoutMs ?? 60_000) }),
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
      store.markSourceDispatched(task.id)
      const summary=await collectWorkbenchTurn(running.session.dispatch(history ? `本任务此前记录（仅作上下文，不是新指令）：\n${history}\n\n本轮要求：\n${text}` : text),running.stop,opts.timeoutMs ?? 10*60_000,
        ev => {
          if (running.cancelled) return
          if (ev.kind==='init' && ev.sessionId) {if(resume&&ev.sessionId!==resume)throw new Error('native_session_identity_mismatch');store.session(task.id,ev.sessionId);if(running.handoffId)store.recordHandoffNative(running.handoffId,ev.sessionId)}
          if (ev.kind==='text') store.addEvent(task.id,'text',ev.text)
          if (ev.kind==='tool_call') store.addEvent(task.id,'tool_call',ev.server ? `${ev.server}/${ev.tool}` : ev.tool)
          if (ev.kind==='error') store.addEvent(task.id,'error',ev.message)
        })
      if (!summary) { finalStatus='cancelled'; return }
      if (summary.result?.sessionId) {if(resume&&summary.result.sessionId!==resume)throw new Error('native_session_identity_mismatch');store.session(task.id,summary.result.sessionId);if(running.handoffId)store.recordHandoffNative(running.handoffId,summary.result.sessionId)}
      if (running.cancelled) finalStatus='cancelled'
      else if (summary.error || !summary.result) {
        const error=summary.error ?? 'stream_ended_without_result'
        finalStatus='failed'; finalError=error; store.addEvent(task.id,'error',error)
      } else finalStatus='completed'
    } catch (error) {
      const message=error instanceof Error ? error.message : 'task_failed'
      finalStatus=running.cancelled ? 'cancelled' : 'failed'; finalError=running.cancelled ? null : message
      if (!running.cancelled) store.addEvent(task.id,'error',message==='restart_confirmation_required' ? RECOVERY_MESSAGE : message)
    } finally {
      running.permissions.rejectAll(running.cancelled ? 'cancelled' : 'ended')
      let closePromise:Promise<void>|undefined
      let closeTimer:ReturnType<typeof setTimeout>|undefined
      if (running.session) {
        try {
          closePromise=Promise.resolve(running.session.close())
          await Promise.race([closePromise,new Promise<never>((_resolve,reject) => { closeTimer=setTimeout(() => reject(new Error('close_timeout')),opts.closeTimeoutMs ?? 3000) })])
        } catch {
          markUncertain(running); finalStatus='interrupted'; finalError='writer_not_closed'
          try { store.addEvent(task.id,'system','执行程序未确认退出，此文件夹内的新任务将等待。请检查后台进程或重启服务。') } catch { /* final status write below may still succeed */ }
          if (closePromise) void closePromise.then(() => confirmLateClose(running,true),() => {})
        } finally { if (closeTimer) clearTimeout(closeTimer) }
      }
      if (!running.uncertain) await collect(running)
      revokeCredentials(running)
      if (running.uncertain) { finalStatus='interrupted'; finalError='writer_not_closed' }
      try { store.update(task.id,running.cancelled && !running.uncertain ? 'cancelled' : finalStatus,finalError) } catch { /* never unlock an uncertain writer for a status failure */ }
      running.publicFinished=true; running.resolveDone()
      if (!running.uncertain) releaseReservation(running)
    }
  }

  function pump() {
    if (stopping) return
    const launch:Active[]=[]
    for (const running of queue) {
      if (running.state !== 'queued') continue
      const earlier=queue.filter(item => item.order < running.order && item.state === 'queued')
      if (findPathBlocker(running,[...reservations.values(),...earlier])) continue
      running.state='active'; reservations.set(running.identity,running); launch.push(running)
    }
    for (const running of launch) queue.splice(queue.indexOf(running),1)
    for (const running of launch) {
      void Promise.resolve().then(() => execute(running.task,runningText.get(running.identity)!,running)).catch(() => {
        if (running.publicFinished) return
        try { running.permissions.rejectAll(running.cancelled ? 'cancelled' : 'ended') } catch { /* fail closed */ }
        revokeCredentials(running)
        if (running.session) markUncertain(running)
        running.publicFinished=true; running.resolveDone()
        if (!running.uncertain) releaseReservation(running)
      })
    }
  }

  function start(task:StoredTask,text:string,acceptedDirectoryIdentity:string,acceptedContinuation:AcceptedContinuation={mode:'new'},nativeResume?:AcceptedNativeResume,handoffArtifacts?:ArtifactSelection[],handoffId?:string):WorkbenchTaskView {
    if (runsByTask.has(task.id)) throw new Error('workbench_busy')
    if(opts.executionConflict?.(task.path,task.providerId,task.sessionId))throw new Error('native_session_busy')
    if([...runsByTask.values()].some(run=>task.sessionId&&run.task.providerId===task.providerId&&run.task.sessionId===task.sessionId))throw new Error('native_session_busy')
    if(nativeResume)store.addEvent(task.id,'system',`用户声明原 ${task.providerId} 执行程序已关闭，选择${nativeResume.mode==='native_resume'?'恢复原会话':'带已确认的记录新开一轮'}。原会话：${nativeResume.nativeId}。`)
    const requestEventId=store.addEvent(task.id,'user',text)
    if(handoffId)store.recordHandoffEvent(handoffId,requestEventId)
    store.update(task.id,'queued')
    let signalStop!:()=>void,resolveDone!:()=>void
    const stop=new Promise<null>(resolve => { signalStop=() => resolve(null) })
    const done=new Promise<void>(resolve => { resolveDone=resolve })
    const permissions=makeRunPermissions({
      taskId:task.id,timeoutMs:opts.permissionTimeoutMs ?? WORKBENCH_PERMISSION_TIMEOUT_MS,
      audit:event => event.type==='request'
        ? store.addEvent(task.id,'system',`权限请求：${event.permission.tool} · ${event.permission.description} · ${event.permission.id}`)
        : store.addEvent(task.id,'system',`权限结果：${event.permission.tool} · ${event.outcome} · ${event.permission.id}`),
    })
    const running:Active={
      handoffId,handoffArtifacts,nativeResume,continuation:acceptedContinuation,identity:randomUUID(),taskId:task.id,title:task.title,path:task.path,order:++order,state:'queued',task,directoryIdentity:acceptedDirectoryIdentity,
      cancelled:false,done,resolveDone,stop,signalStop,permissions,publicFinished:false,uncertain:false,artifactsCollected:false,credentialsMinted:false,credentialsRevoked:false,
    }
    runsByTask.set(task.id,running); runningText.set(running.identity,text); queue.push(running); pump()
    return taskView(publicTask({...task,status:'queued',error:null}))
  }

  function cancelRun(running:Active):void {
    if (running.state==='queued') {
      running.cancelled=true; running.permissions.rejectAll('cancelled'); running.signalStop()
      const index=queue.indexOf(running); if (index>=0) queue.splice(index,1)
      runningText.delete(running.identity)
      try { store.update(running.taskId,'cancelled') } catch { /* in-memory cancellation still must settle */ }
      running.publicFinished=true; running.resolveDone()
      if (runsByTask.get(running.taskId)===running) runsByTask.delete(running.taskId)
      if (!stopping) pump()
      return
    }
    if (running.state==='uncertain') return
    if (!running.cancelled) {
      running.cancelled=true; running.permissions.rejectAll('cancelled'); revokeCredentials(running); running.signalStop()
      try { store.update(running.taskId,'cancelling') } catch { /* stop the writer even when persistence is unavailable */ }
      try { if (running.session?.cancel) void running.session.cancel().catch(() => {}) }
      catch { try { store.addEvent(running.taskId,'system','已请求停止，正在等待执行程序退出。') } catch { /* cancellation remains active */ } }
    }
  }

  const service={
    async previewHandoff(raw:HandoffInput):Promise<HandoffPreview> {
      ensureAccepting()
      const input=validateHandoffInput(raw),source=store.get(input.sourceTaskId),version=taskVersion(source)
      provider(input.targetProviderId)
      if(source.providerId===input.targetProviderId)throw new Error('invalid_request')
      if(canonicalProject(source.path)!==source.path)throw new Error('invalid_path')
      const identity=directoryIdentity(source.path)
      let artifacts=input.artifacts,target:StoredTask|null=null,targetContinuation:Continuation|undefined,nativeResume:NativeResumeDecision|undefined
      if(input.purpose==='revision') {
        target=store.get(input.targetTaskId!)
        if(target.archivedAt!==null)throw new Error('workbench_archived')
        if(runsByTask.has(target.id)||!TERMINAL_TASK_STATUSES.includes(target.status)||target.error==='writer_not_closed')throw new Error('workbench_busy')
        if(target.providerId!==input.targetProviderId||target.path!==source.path)throw new Error('invalid_handoff_target')
        const origin=store.handoffs(source.id).find(h=>h.purpose==='review'&&h.sourceTaskId===target!.id&&h.targetTaskId===source.id)
        const event=store.events(source.id).find(e=>e.id===input.quote!.eventId&&e.kind==='text')
        if(!origin||!event?.text.includes(input.quote!.text))throw new Error('invalid_handoff_quote')
        artifacts=origin.artifacts
        targetContinuation=continuation(target)
        if(store.source(target.id)?.firstDispatchedAt===null)nativeResume=await service.prepareNativeResume(target.id,targetContinuation.mode==='restart_required'?'fresh_context':'native_resume')
      }
      const files=artifacts.map(a=>handoffArtifactText(store,a,target?.id??source.id,opts.stateDir))
      const packet=handoffContext(input,source,store.events(source.id),files)
      ensureAccepting()
      if(taskVersion(store.get(source.id))!==version)throw new Error('handoff_changed')
      const preview:HandoffPreview={token:handoffToken(),sourceTaskId:source.id,targetTaskId:target?.id??null,targetProviderId:input.targetProviderId,purpose:input.purpose,request:input.request,...packet,artifacts,quote:input.quote??null,...(targetContinuation?{targetContinuation}:{}),...(nativeResume?{nativeResume}:{})}
      for(const [token,d] of handoffDecisions)if(d.expiresAt<Date.now()||d.preview.sourceTaskId===source.id)handoffDecisions.delete(token)
      if(handoffDecisions.size>=100)handoffDecisions.delete(handoffDecisions.keys().next().value!)
      handoffDecisions.set(preview.token,{preview:structuredClone(preview),sourceVersion:version,targetVersion:target?taskVersion(target):null,directoryIdentity:identity,expiresAt:Date.now()+5*60_000})
      return preview
    },
    async handoff(input:{token:string;restartToken?:string;sourceClosedToken?:string}) {
      ensureAccepting()
      if(!input||typeof input.token!=='string'||! /^[a-f0-9]{64}$/.test(input.token))throw new Error('invalid_request')
      for(const optional of [input.restartToken,input.sourceClosedToken])if(optional!==undefined&&(typeof optional!=='string'||! /^[a-f0-9]{64}$/.test(optional)))throw new Error('invalid_request')
      const hash=handoffTokenHash(input.token),previous=store.handoffByToken(hash)
      if(previous)return{task:taskView(publicTask(store.get(previous.targetTaskId))),handoffId:previous.id,sourceTaskId:previous.sourceTaskId}
      const decision=handoffDecisions.get(input.token)
      if(!decision||decision.expiresAt<Date.now())throw new Error('handoff_changed')
      const p=decision.preview,source=store.get(p.sourceTaskId),target=p.targetTaskId?store.get(p.targetTaskId):null
      const assertCurrent=()=>{
        ensureAccepting()
        if(handoffDecisions.get(input.token)!==decision||decision.expiresAt<Date.now()||taskVersion(store.get(source.id))!==decision.sourceVersion||(target&&taskVersion(store.get(target.id))!==decision.targetVersion))throw new Error('handoff_changed')
        if(canonicalProject(source.path)!==source.path||directoryIdentity(source.path)!==decision.directoryIdentity)throw new Error('invalid_path')
        if(target?.archivedAt!=null)throw new Error('workbench_archived')
        if(target&&(runsByTask.has(target.id)||!TERMINAL_TASK_STATUSES.includes(target.status)||target.error==='writer_not_closed'))throw new Error('workbench_busy')
        if(opts.executionConflict?.(source.path,p.targetProviderId,target?.sessionId??null))throw new Error('native_session_busy')
      }
      assertCurrent();provider(p.targetProviderId)
      for(const ref of p.artifacts)handoffArtifactText(store,ref,target?.id??source.id,opts.stateDir)
      let accepted:AcceptedContinuation={mode:'new'},native:AcceptedNativeResume|undefined
      if(target){
        const current=continuation(target)
        if(current.mode==='restart_required'){
          if(!input.restartToken)throw new Error('restart_confirmation_required')
          if(input.restartToken!==current.restart.token||p.targetContinuation?.mode!=='restart_required'||input.restartToken!==p.targetContinuation.restart.token)throw new Error('restart_confirmation_stale')
          accepted={mode:'restart',preview:current.restart}
        }else{
          if(input.restartToken!==undefined)throw new Error('restart_confirmation_stale')
          accepted=current.mode==='resume'?{mode:'resume',sessionId:target.sessionId!}:{mode:'new'}
        }
        if(store.source(target.id)?.firstDispatchedAt===null){
          native=input.sourceClosedToken?nativeDecisions.get(input.sourceClosedToken):undefined
          if(!native||input.sourceClosedToken!==p.nativeResume?.token)throw new Error('external_close_confirmation_required')
          await validateNativeDecision(target,native)
          assertCurrent()
          if(nativeDecisions.get(native.token)!==native)throw new Error('external_close_confirmation_stale')
        }
      }
      const packetJson=JSON.stringify({context:p.context,request:p.request,artifacts:p.artifacts,quote:p.quote,truncated:p.truncated,continuation:accepted})
      const record=store.createHandoff({id:randomUUID(),sourceTaskId:source.id,targetTaskId:target?.id??null,targetProviderId:p.targetProviderId,path:source.path,title:`检查 · ${source.title}`.slice(0,120),ownerChatId:source.ownerChatId,purpose:p.purpose,request:p.request,packetSha256:snapshotHash(packetJson),packetJson,artifactRefsJson:JSON.stringify(p.artifacts),quoteJson:p.quote?JSON.stringify(p.quote):null,sourceNativeId:source.sessionId,tokenHash:hash})
      handoffDecisions.delete(input.token)
      if(native)nativeDecisions.delete(native.token)
      let task:WorkbenchTaskView
      try{task=start(store.get(record.targetTaskId),p.context,decision.directoryIdentity,accepted,native,p.artifacts,record.id)}
      catch(error){
        if(!target)store.update(record.targetTaskId,'failed',error instanceof Error?error.message:'task_failed')
        store.addEvent(record.targetTaskId,'system','交接已记录，但本轮未启动。请查看任务状态，手动决定是否继续。')
        throw error
      }
      return{task,handoffId:record.id,sourceTaskId:source.id}
    },
    handoffRecord(taskId:string,id:string){
      const record=store.handoffRecord(taskId,id)
      if(snapshotHash(record.packetJson)!==record.packetSha256)throw new Error('artifact_changed')
      return{id:record.id,sourceTaskId:record.sourceTaskId,targetTaskId:record.targetTaskId,createdAt:record.createdAt,sourceNativeId:record.sourceNativeId,targetNativeId:record.targetNativeId,packetSha256:record.packetSha256,packet:JSON.parse(record.packetJson) as {context:string;request:string;truncated:boolean;artifacts:ArtifactSelection[];continuation:AcceptedContinuation}}
    },
    conflictsExternal(path:string,providerId:string,nativeId:string|null):boolean {
      let canonical:string
      try{canonical=canonicalProject(path)}catch{return true}
      if(nativeId&&(store.sourceByIdentity(providerId,nativeId)||store.taskByNativeIdentity(providerId,nativeId)))return true
      return [...runsByTask.values()].some(run=>pathsConflict(run.path,canonical))
    },
    async importNativeHistory(raw:NativeImportInput) {
      ensureAccepting()
      const input=nativeImportInput(raw),{providerId,nativeId}=decodeNativeHistoryKey(input.key)
      const existing=store.sourceByIdentity(providerId,nativeId)
      if(existing)return{task:taskView(publicTask(store.get(existing.taskId))),source:publicSource(existing),created:false}
      const managed=store.taskByNativeIdentity(providerId,nativeId)
      if(managed)throw new Error('native_session_already_managed')
      const read=await readNativeImport(nativeReader(providerId),input)
      ensureAccepting()
      if(!read.session.cwd)throw new Error('invalid_path')
      const path=canonicalProject(read.session.cwd)
      if(path!==read.session.cwd)throw new Error('invalid_path')
      const result=store.importSource({providerId,nativeId,cwd:path,title:read.session.title.slice(0,120),ownerChatId:opts.ownerChatId(),messages:read.messages,snapshotJson:read.snapshotJson,snapshotSha256:read.snapshotSha256,pagesJson:read.pagesJson,observedFingerprint:read.observedFingerprint,truncated:read.truncated})
      return{...result,task:taskView(publicTask(result.task))}
    },
    async prepareNativeResume(id:string,mode:'native_resume'|'fresh_context'='native_resume'):Promise<NativeResumeDecision> {
      ensureAccepting()
      const task=store.get(id),source=store.source(id)
      if(!source||source.firstDispatchedAt!==null)throw new Error('invalid_request')
      if(mode!=='native_resume'&&mode!=='fresh_context')throw new Error('invalid_request')
      if(runsByTask.has(id)||task.archivedAt!==null)throw new Error('workbench_busy')
      provider(task.providerId)
      const identity=directoryIdentity(task.path),version=taskVersion(task),pages=JSON.parse(source.pagesJson) as ImportPage[]
      if(opts.executionConflict?.(task.path,task.providerId,source.nativeId))throw new Error('native_session_busy')
      const current=mode==='native_resume'?await currentNativePages(task,pages):pages
      if(mode==='native_resume'&&!canResume(task))throw new Error('restart_confirmation_required')
      const recovery=continuation(task)
      if(mode==='fresh_context'&&recovery.mode!=='restart_required')throw new Error('invalid_request')
      ensureAccepting()
      if(taskVersion(store.get(id))!==version||runsByTask.has(id))throw new Error('external_close_confirmation_stale')
      const preview=restartPreview(task,store.events(id))
      const decision:AcceptedNativeResume={token:nativeResumeToken(),taskId:id,sourceId:source.id,providerId:source.providerId,nativeId:source.nativeId,path:task.path,mode,expiresAt:Date.now()+5*60_000,context:mode==='fresh_context'?preview.context:'',truncated:source.truncated,changedSinceImport:JSON.stringify(current)!==JSON.stringify(pages),pages:current,taskVersion:version,directoryIdentity:identity,...(mode==='fresh_context'?{restartToken:preview.token}:{})}
      for(const [token,value] of nativeDecisions)if(value.expiresAt<Date.now()||value.taskId===id)nativeDecisions.delete(token)
      if(nativeDecisions.size>=100)nativeDecisions.delete(nativeDecisions.keys().next().value!)
      nativeDecisions.set(decision.token,decision)
      const {pages:_pages,taskVersion:_version,directoryIdentity:_identity,restartToken:_restart,...result}=decision;return result
    },
    async continueNativeTask(id:string,text:string,sourceClosedToken:string,restartToken?:string):Promise<WorkbenchTaskView> {
      ensureAccepting();const task=store.get(id),decision=nativeDecisions.get(sourceClosedToken),request=checkedText(text)
      if(!decision)throw new Error('external_close_confirmation_stale')
      if(runsByTask.has(id)||task.archivedAt!==null)throw new Error('workbench_busy')
      await validateNativeDecision(task,decision)
      ensureAccepting()
      if(taskVersion(store.get(id))!==decision.taskVersion||runsByTask.has(id)||nativeDecisions.get(sourceClosedToken)!==decision)throw new Error('external_close_confirmation_stale')
      const accepted:AcceptedContinuation=decision.mode==='native_resume'?{mode:'resume',sessionId:decision.nativeId}:{mode:'restart',preview:restartPreview(task,store.events(id))}
      if(accepted.mode==='restart'&&(restartToken!==accepted.preview.token||restartToken!==decision.restartToken))throw new Error('restart_confirmation_stale')
      nativeDecisions.delete(sourceClosedToken)
      return start(task,request,decision.directoryIdentity,accepted,decision)
    },
    async listNativeHistory(providerId:NativeHistoryProvider,input:NativeHistoryListInput) {
      const reader=opts.nativeHistory?.[providerId]
      if(!reader)throw new Error('native_history_unsupported')
      return reader.list(normalizeHistoryList(input))
    },
    async readNativeHistory(key:string,input:NativeHistoryReadInput) {
      const {providerId}=decodeNativeHistoryKey(key),reader=opts.nativeHistory?.[providerId]
      if(!reader)throw new Error('native_history_unsupported')
      const preview=await reader.read(key,normalizeHistoryRead(input)),{nativeId}=decodeNativeHistoryKey(key)
      const managedTaskId=store.sourceByIdentity(providerId,nativeId)?.taskId??store.taskByNativeIdentity(providerId,nativeId)?.id
      return {...preview,...(managedTaskId?{managedTaskId}:{})}
    },
    list(query:WorkbenchListQuery={}) {
      const providers=SUPPORTED.flatMap(id => { const p=opts.registry.get(id); return p ? [{id,displayName:p.opts.displayName}] : [] })
      const result=store.listPage(query)
      const projectProviders=Object.fromEntries([...new Set(result.tasks.map(task=>task.path))].map(path=>[path,store.projectProvider(path)]))
      return {tasks:result.tasks.map(task => taskView(task,true)),page:result.page,projectProviders,providers,historyProviders:Object.keys(opts.nativeHistory??{}),defaultProvider:providers.find(p=>p.id===opts.defaultProvider)?.id ?? providers[0]?.id ?? null,canWechat:!!opts.ownerChatId()}
    },
    detail(id:string) {
      const detail=store.detail(id),running=runsByTask.get(id)
      return {...detail,task:taskView(detail.task),permissions:running?.permissions.pending() ?? [],...(!running ? {continuation:continuation(store.get(id)),...(store.source(id)?.firstDispatchedAt===null?{requiresExternalClose:true}:{})} : {})}
    },
    create(input:CreateTask):WorkbenchTaskView {
      ensureAccepting()
      const text=checkedText(input.text); provider(input.providerId)
      if (input.title!==undefined && (typeof input.title!=='string' || !input.title.trim() || input.title.length>120)) throw new Error('invalid_title')
      const path=canonicalProject(input.path)
      const acceptedDirectoryIdentity=directoryIdentity(path)
      if(opts.executionConflict?.(path,input.providerId,null))throw new Error('native_session_busy')
      return start(store.create({title:input.title?.trim() ?? text.slice(0,40),path,providerId:input.providerId,ownerChatId:opts.ownerChatId()}),text,acceptedDirectoryIdentity)
    },
    continueTask(id:string,text:string,options?:{restartToken?:string}):WorkbenchTaskView {
      ensureAccepting()
      if (runsByTask.has(id)) throw new Error('workbench_busy')
      const task=store.get(id)
      if(store.source(id)?.firstDispatchedAt===null)throw new Error('external_close_confirmation_required')
      if(task.archivedAt!==null)throw new Error('workbench_archived')
      provider(task.providerId)
      if (canonicalProject(task.path)!==task.path) throw new Error('invalid_path')
      const request=checkedText(text),acceptedDirectoryIdentity=directoryIdentity(task.path)
      const restartToken=options?.restartToken
      if (restartToken!==undefined && (typeof restartToken!=='string' || !/^[a-f0-9]{64}$/.test(restartToken))) throw new Error('invalid_request')
      const decision=continuation(task)
      if (restartToken!==undefined && (decision.mode!=='restart_required' || restartToken!==decision.restart.token)) throw new Error('restart_confirmation_stale')
      if (decision.mode==='restart_required' && restartToken===undefined) throw new Error('restart_confirmation_required')
      const accepted:AcceptedContinuation=decision.mode==='restart_required'
        ? {mode:'restart',preview:decision.restart}
        : decision.mode==='resume' ? {mode:'resume',sessionId:task.sessionId!} : {mode:'new'}
      return start(task,request,acceptedDirectoryIdentity,accepted)
    },
    setArchived(id:string,archived:boolean):WorkbenchTaskView {
      if(typeof archived!=='boolean')throw new Error('invalid_request')
      const task=store.get(id)
      if(archived && !taskView(publicTask(task)).canArchive)throw new Error('workbench_busy')
      return taskView(publicTask(store.setArchived(id,archived)))
    },
    async cancel(id:string):Promise<WorkbenchTaskView> {
      const running=runsByTask.get(id)
      if (running) cancelRun(running)
      return taskView(publicTask(store.get(id)))
    },
    artifact(id:string,artifactId:string) {
      const a=store.artifact(id,artifactId),bytes=readArtifactSnapshot(a.storagePath,opts.stateDir,a.sha256)
      return {name:a.name,mime:a.mime,size:bytes.length,sha256:a.sha256,contentBase64:bytes.toString('base64')}
    },
    approve(id:string,artifactId:string,sha256:string) { service.artifact(id,artifactId); store.approve(id,artifactId,sha256) },
    resolvePermission(id:string,requestId:string,decision:PermissionDecision):void {
      store.get(id)
      if (decision!=='allow' && decision!=='deny') throw new Error('invalid_decision')
      const running=runsByTask.get(id)
      if (!running || !running.permissions.resolve(requestId,decision)) throw new Error('permission_stale')
    },
    async handleWechat(chatId:string,text:string):Promise<string|null> {
      if (!opts.ownerChatId() || chatId!==opts.ownerChatId()) return null
      const m=/^(?:任务|\/task)\s+([a-f0-9]{8})(?:\s+([\s\S]+))?$/i.exec(text.trim())
      if (!m) return null
      const id=m[1]!.toLowerCase(); let task:StoredTask
      try { task=store.get(id) } catch { return '没有找到这个任务，请在桌面工作台核对编号。' }
      if (task.ownerChatId!==chatId) return '没有找到这个任务，请在桌面工作台核对编号。'
      const followup=m[2]?.trim()
      try {
        if (followup==='停止') { await service.cancel(id); return `任务 ${id}：已请求停止。` }
        if (followup) { service.continueTask(id,followup); return `任务 ${id}：已收到补充要求，继续处理。稍后发送「任务 ${id}」查看进展。` }
        const detail=store.detail(id),last=detail.events.filter(e => e.kind==='text' || e.kind==='error').at(-1)?.text ?? ''
        return [`${task.title} · ${id}`,STATUS_NAMES[task.status] ?? task.status,last.slice(0,1500),detail.artifacts.length ? `已保存 ${detail.artifacts.length} 份成果版本，可在桌面工作台查看。` : '',`继续：任务 ${id} <补充要求>`].filter(Boolean).join('\n')
      } catch (err) {
        const code=(err as Error).message
        if (code==='workbench_archived') return '这项任务已归档。请在桌面工作台恢复任务后再继续。'
        if (code==='restart_confirmation_required' || code==='restart_confirmation_stale') return RECOVERY_MESSAGE
        return code==='workbench_busy' ? '这项任务正在处理，请等待完成或先停止它。' : '暂时无法继续，请在桌面工作台查看任务状态。'
      }
    },
    shutdown():Promise<void> {
      if (shutdownPromise) return shutdownPromise
      stopping=true
      shutdownPromise=(async () => {
        const snapshot=[...runsByTask.values()]
        for (const running of snapshot) {
          try { cancelRun(running) }
          catch {
            running.cancelled=true
            try { running.permissions.rejectAll('cancelled') } catch { /* fail closed */ }
            revokeCredentials(running); running.signalStop()
            try { if (running.session?.cancel) void running.session.cancel().catch(() => {}) } catch { /* close still follows */ }
          }
        }
        await Promise.allSettled(snapshot.map(running => running.done))
        while(collections.size)await Promise.allSettled([...collections])
        shutdownComplete=true
        for (const running of [...runsByTask.values()]) releaseReservation(running)
      })()
      return shutdownPromise
    },
  }
  return service
}
export type WorkbenchService=ReturnType<typeof makeWorkbenchService>
