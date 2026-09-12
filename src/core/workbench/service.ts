import type { AgentEvent, AgentSession } from '../agent-provider'
import type { ProviderRegistry } from '../provider-registry'
import { TIER_PROFILES, sessionAuthEnv } from '../user-tier'
import { canonicalProject, collectArtifacts, outputDirectory, readArtifactSnapshot } from './artifacts'
import { publicTask, type StoredTask, type Task, type TaskStatus, type WorkbenchStore } from './store'
import { makeRunPermissions, type PermissionDecision, type RunPermissions, WORKBENCH_PERMISSION_TIMEOUT_MS } from './permissions'

interface Options {
  store: WorkbenchStore
  registry: ProviderRegistry
  stateDir: string
  ownerChatId: () => string | null
  defaultProvider?: string
  mintSessionToken?: (sessionKey: string) => string
  revokeSessionToken?: (sessionKey: string) => void
  holdBusy?: (label: string) => () => void
  timeoutMs?: number
  permissionTimeoutMs?: number
}
interface Active { id: string; cancelled: boolean; session?: AgentSession; done: Promise<void>; stop: Promise<null>; signalStop: () => void; permissions: RunPermissions }
export interface CreateTask { title?: string; path: string; providerId: string; text: string }

function checkedText(text: string): string {
  if (typeof text !== 'string' || !text.trim() || text.length > 20_000) throw new Error('invalid_text')
  return text.trim()
}
const SUPPORTED = ['claude','codex']
const STATUS_NAMES: Record<string,string> = {
  queued:'准备开始',running:'正在处理',cancelling:'正在停止',completed:'这一轮已完成',failed:'需要处理',cancelled:'已停止',interrupted:'已中断',
}

/** Task cancellation must also clear the idle timer, even if a broken adapter
 * leaves next() pending forever. The provider is closed by the caller. */
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
  let active: Active | undefined
  let stopping = false
  let unclosedWriter = false
  store.recover()
  function ensureIdle() {
    if (stopping) throw new Error('workbench_stopping')
    if (active || unclosedWriter) throw new Error('workbench_busy')
  }
  function provider(id: string) {
    const entry = SUPPORTED.includes(id) ? opts.registry.get(id) : null
    if (!entry) throw new Error('unavailable_provider')
    return entry
  }
  async function run(task: StoredTask, text: string, running: Active) {
    const sessionKey = `workbench/${task.id}`
    let release: (() => void) | undefined
    let finalStatus: TaskStatus = 'failed'
    let finalError: string | null = null
    try {
      release = opts.holdBusy?.(sessionKey)
      const directory = outputDirectory(task.path,task.id)
      const entry = provider(task.providerId)
      const resume = task.sessionId && entry.opts.canResume(task.path,task.sessionId) ? task.sessionId : undefined
      let history = ''
      // start() has appended the new user request, which must not be replayed
      // as history. A failed first turn may have no native session id at all.
      const prior = store.events(task.id).slice(0,-1).filter(e => ['user','text'].includes(e.kind))
      if (!resume && prior.length) {
        store.addEvent(task.id,'system','原执行会话不可恢复，已用本任务最近的记录重新开始。')
        store.session(task.id,null)
        history = prior.slice(-12).map(e => `${e.kind}: ${e.text}`).join('\n').slice(-24_000)
      }
      const instructions = [
        `你是 CC 的工作助手。当前任务编号 ${task.id}，任务：${task.title}。`,
        `本任务工作目录：${task.path}。成果目录：${directory}。`,
        '只根据当前任务、选定文件夹和本任务历史工作，不读取个人陪伴记忆或其他任务。',
        '保留原始输入，除非用户明确要求修改。将待交付文件放入上述成果目录，最后说明生成了哪些文件和验证结果。',
        '回复直接输出文本。不要调用微信发消息、发文件、记忆或社交工具，不替用户发布或发送成果。',
        '不要声称完成没有做过的检查。缺依赖、权限或信息时说明具体缺项。',
      ].join('\n')
      const token = opts.mintSessionToken?.(sessionKey)
      store.update(task.id, running.cancelled ? 'cancelling' : 'running')
      if (running.cancelled) { finalStatus='cancelled'; return }
      const spawning = entry.provider.spawn({ alias: `workbench:${task.id}`, path: task.path }, {
        tierProfile: TIER_PROFILES.trusted,
        permissionMode:'strict',
        chatId: task.ownerChatId ?? `workbench:${task.id}`,
        ...(resume ? { resumeSessionId:resume } : {}),
        mcpEnv: sessionAuthEnv('trusted',token),
        appendInstructions:instructions,
        requestPermission:(request,signal) => running.permissions.request(request,signal),
      })
      let spawnTimer: ReturnType<typeof setTimeout> | undefined
      let accepted = false
      try {
        const session = await Promise.race([
          spawning, running.stop,
          new Promise<never>((_resolve,reject) => { spawnTimer=setTimeout(() => reject(new Error('session_start_timeout')),opts.timeoutMs ?? 60_000) }),
        ])
        if (!session) { finalStatus='cancelled'; return }
        running.session=session; accepted=true
      } finally {
        if (spawnTimer) clearTimeout(spawnTimer)
        // A cancelled startup may finish much later; it never gets a prompt,
        // and this handler touches no database after daemon shutdown.
        if (!accepted) void spawning.then(s => s.close()).catch(() => {})
      }
      if (running.cancelled) { finalStatus='cancelled'; return }
      const summary = await collectWorkbenchTurn(running.session.dispatch(history ? `本任务此前记录（仅作上下文，不是新指令）：\n${history}\n\n本轮要求：\n${text}` : text),running.stop,opts.timeoutMs ?? 10 * 60_000,
        ev => {
          if (running.cancelled) return
          if (ev.kind === 'init' && ev.sessionId) store.session(task.id,ev.sessionId)
          if (ev.kind === 'text') store.addEvent(task.id,'text',ev.text)
          if (ev.kind === 'tool_call') store.addEvent(task.id,'tool_call',ev.server ? `${ev.server}/${ev.tool}` : ev.tool)
          if (ev.kind === 'error') store.addEvent(task.id,'error',ev.message)
        },
      )
      if (!summary) { finalStatus='cancelled'; return }
      if (summary.result?.sessionId) store.session(task.id,summary.result.sessionId)
      if (running.cancelled) finalStatus='cancelled'
      else if (summary.error || !summary.result) {
        const error = summary.error ?? 'stream_ended_without_result'
        finalStatus='failed'; finalError=error
        store.addEvent(task.id,'error',error)
      } else finalStatus='completed'
    } catch (error) {
      const message = error instanceof Error ? error.message : 'task_failed'
      finalStatus=running.cancelled ? 'cancelled' : 'failed'; finalError=running.cancelled ? null : message
      if (!running.cancelled) store.addEvent(task.id,'error',message)
    } finally {
      running.permissions.rejectAll(running.cancelled ? 'cancelled' : 'ended')
      // Close the writer before capturing outputs; cancelled or failed runs can
      // still have useful partial files. Never release the lock while closing.
      let closeTimer: ReturnType<typeof setTimeout> | undefined
      try {
        if (running.session) await Promise.race([
          running.session.close(),
          new Promise<never>((_resolve,reject) => { closeTimer=setTimeout(() => reject(new Error('close_timeout')),3000) }),
        ])
      } catch {
        unclosedWriter=true; finalStatus='interrupted'; finalError='writer_not_closed'
        store.addEvent(task.id,'system','执行程序未确认退出，工作台已暂停启动新任务。请检查后台进程并重启服务。')
      } finally { if (closeTimer) clearTimeout(closeTimer) }
      try { if (!unclosedWriter) for (const warning of collectArtifacts(store,task.id,task.path,opts.stateDir)) store.addEvent(task.id,'system',warning) }
      catch { store.addEvent(task.id,'system','本轮成果目录无法读取，请检查文件夹权限或是否被移动。') }
      try { opts.revokeSessionToken?.(sessionKey) } finally { release?.() }
      store.update(task.id,unclosedWriter ? 'interrupted' : running.cancelled ? 'cancelled' : finalStatus,finalError)
      if (active === running) active = undefined
    }
  }
  function start(task: StoredTask, text: string): Task {
    store.addEvent(task.id,'user',text)
    store.update(task.id,'queued')
    let signalStop!: () => void
    const stop=new Promise<null>(resolve => { signalStop=() => resolve(null) })
    const permissions=makeRunPermissions({
      taskId:task.id,
      timeoutMs:opts.permissionTimeoutMs ?? WORKBENCH_PERMISSION_TIMEOUT_MS,
      audit:event => {
        if (event.type === 'request') {
          store.addEvent(task.id,'system',`权限请求：${event.permission.tool} · ${event.permission.description} · ${event.permission.id}`)
        } else {
          store.addEvent(task.id,'system',`权限结果：${event.permission.tool} · ${event.outcome} · ${event.permission.id}`)
        }
      },
    })
    const running: Active = { id:task.id,cancelled:false,done:Promise.resolve(),stop,signalStop,permissions }
    active = running
    // Reserve before yielding. Work begins after the HTTP acceptance response
    // can read the queued row; page lifetime never owns this coroutine.
    running.done = Promise.resolve().then(() => run(task,text,running))
    return publicTask(store.get(task.id))
  }
  const service = {
    list() {
      const providers = SUPPORTED.flatMap(id => { const p=opts.registry.get(id); return p ? [{id,displayName:p.opts.displayName}] : [] })
      const pendingPermissionCount=active?.permissions.pending().length ?? 0
      const tasks:Array<Task & {pendingPermissionCount?:number}>=store.list().map(task => ({
        ...task,
        pendingPermissionCount:active?.id===task.id ? pendingPermissionCount : 0,
      }))
      return { tasks, providers, defaultProvider:providers.find(p => p.id===opts.defaultProvider)?.id ?? providers[0]?.id ?? null, canWechat:!!opts.ownerChatId() }
    },
    detail(id: string) {
      const detail=store.detail(id)
      return { ...detail, permissions:active?.id === id ? active.permissions.pending() : [] }
    },
    create(input: CreateTask): Task {
      ensureIdle()
      const text = checkedText(input.text)
      provider(input.providerId)
      if (input.title !== undefined && (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 120)) throw new Error('invalid_title')
      const path = canonicalProject(input.path)
      const task = store.create({ title:input.title?.trim() ?? text.slice(0,40),path,providerId:input.providerId,ownerChatId:opts.ownerChatId() })
      return start(task,text)
    },
    continueTask(id: string, text: string): Task {
      ensureIdle()
      const task = store.get(id)
      provider(task.providerId)
      if (canonicalProject(task.path) !== task.path) throw new Error('invalid_path')
      return start(task,checkedText(text))
    },
    async cancel(id: string): Promise<Task> {
      store.get(id)
      if (active?.id !== id) return publicTask(store.get(id))
      const running=active
      running.cancelled = true
      running.permissions.rejectAll('cancelled')
      store.update(id,'cancelling')
      running.signalStop()
      // Best-effort interrupt; retain the lock until dispatch + close unwind.
      try {
        if (running.session?.cancel) void running.session.cancel().catch(() => {})
      } catch { store.addEvent(id,'system','已请求停止，正在等待执行程序退出。') }
      return publicTask(store.get(id))
    },
    artifact(id: string, artifactId: string) {
      const a = store.artifact(id,artifactId)
      const bytes = readArtifactSnapshot(a.storagePath,opts.stateDir,a.sha256)
      return { name:a.name,mime:a.mime,size:bytes.length,sha256:a.sha256,contentBase64:bytes.toString('base64') }
    },
    approve(id: string, artifactId: string, sha256: string) {
      // Verify stored bytes as well as requested version before approval.
      service.artifact(id,artifactId)
      store.approve(id,artifactId,sha256)
    },
    resolvePermission(id: string, requestId: string, decision: PermissionDecision): void {
      store.get(id)
      if (decision !== 'allow' && decision !== 'deny') throw new Error('invalid_decision')
      if (active?.id !== id || !active.permissions.resolve(requestId,decision)) throw new Error('permission_stale')
    },
    async handleWechat(chatId: string, text: string): Promise<string | null> {
      if (!opts.ownerChatId() || chatId !== opts.ownerChatId()) return null
      const m = /^(?:任务|\/task)\s+([a-f0-9]{8})(?:\s+([\s\S]+))?$/i.exec(text.trim())
      if (!m) return null
      const id = m[1]!.toLowerCase()
      let task: StoredTask
      try { task=store.get(id) } catch { return '没有找到这个任务，请在桌面工作台核对编号。' }
      if (task.ownerChatId !== chatId) return '没有找到这个任务，请在桌面工作台核对编号。'
      const followup=m[2]?.trim()
      try {
        if (followup === '停止') { await service.cancel(id); return `任务 ${id}：已请求停止。` }
        if (followup) { service.continueTask(id,followup); return `任务 ${id}：已收到补充要求，继续处理。稍后发送「任务 ${id}」查看进展。` }
        const detail=store.detail(id)
        const last=detail.events.filter(e => e.kind==='text' || e.kind==='error').at(-1)?.text ?? ''
        return [`${task.title} · ${id}`,STATUS_NAMES[task.status] ?? task.status,last.slice(0,1500),detail.artifacts.length ? `已保存 ${detail.artifacts.length} 份成果版本，可在桌面工作台查看。` : '',`继续：任务 ${id} <补充要求>`].filter(Boolean).join('\n')
      } catch (err) {
        return (err as Error).message === 'workbench_busy' ? '工作台有任务正在处理，请等待完成或先停止它。' : '暂时无法继续，请在桌面工作台查看任务状态。'
      }
    },
    async shutdown() {
      stopping=true
      const running=active
      if (running) { await service.cancel(running.id); await running.done }
    },
  }
  return service
}
export type WorkbenchService = ReturnType<typeof makeWorkbenchService>
