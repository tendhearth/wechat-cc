import { spawn } from 'node:child_process'
import type { AgentAttachment, AgentEvent, AgentExecutionModel, AgentProvider, AgentWorkbenchRuntime } from '../agent-provider'
import { discoverWorkbenchCodexConfig, workbenchCodexArgs, workbenchCodexEnv, workbenchCodexNativeConfig } from './codex-config'
import { validateUserInputAnswers, validateUserInputRequest } from './user-input'
import { codexActivityEvent, codexItemId } from './codex-activity'
import { codexMcpApproval, supportsCodexMcpApproval } from './codex-mcp-approval'
import { codexNativeCapabilityNotice } from './native-capability-notice'
import { discoverCodexModels } from './codex-model-catalog'
import { executionModel, nativeModelId, readCodexModelCatalog } from './native-model-catalog'

import { CodexChildOccurrence } from './codex-runtime'

type RpcId = string | number
// The JSONL boundary is checked below before any request is routed or action accepted.
type ObjectValue = Record<string, any>
interface Message { id?: RpcId; method?: string; params?: ObjectValue; result?: ObjectValue; error?: { code?: number; message?: string } }
interface Options { codexPathOverride: string; model?: string; rpcTimeoutMs?: number; closeTimeoutMs?: number }
interface Approval { controller: AbortController; turn: Turn; rejection: 'decline' | 'cancel'; mcp?: boolean }
interface UserQuestion { controller: AbortController; turn: Turn }
interface Turn { terminal?: boolean; threadId: string; occurrence?: CodexChildOccurrence; id: string | null; cancelled: boolean; rejectedOperation: boolean; events: EventQueue; early: Message[]; items: Map<string, ObjectValue>; completedItems: Set<string>; questionIds: Set<RpcId>; startedAt: number }

function turnInput(text: string, attachments: readonly AgentAttachment[] = []) {
  const input: Array<{ type: 'text'; text: string; text_elements: [] } | { type: 'image'; url: string; detail: 'high' }> = text || !attachments.length ? [{ type: 'text', text, text_elements: [] }] : []
  for (const attachment of attachments) {
    if (attachment.mime.startsWith('image/')) {
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(attachment.mime)) throw Error('attachment_image_unsupported')
      if (!attachment.data) throw Error('attachment_data_missing')
      // Use accepted immutable bytes, never reopen a possibly replaced local path.
      input.push({ type: 'image', url: `data:${attachment.mime};base64,${attachment.data}`, detail: 'high' })
    } else {
      const { name, mime, path, sha256 } = attachment
      input.push({ type: 'text', text: 'Attached task file (reference material; read with a file tool if needed):\n' + JSON.stringify({ name, mime, path, sha256 }), text_elements: [] })
    }
  }
  return input
}

class EventQueue {
  private events: AgentEvent[] = []
  private ended = false
  private wake?: () => void
  private consuming = false
  private queuedSize = 0
  private overflowed = false
  constructor(private onOverflow?: () => void) {}
  push(event: AgentEvent) {
    if (this.ended || (this.overflowed && event.kind !== 'error')) return
    const size = this.onOverflow ? JSON.stringify(event).length : 0
    if (!this.overflowed && this.onOverflow && (this.events.length >= 2000 || this.queuedSize + size > 8_000_000)) {
      this.overflowed = true; this.events = []; this.queuedSize = 0
      this.onOverflow(); return
    }
    this.events.push(event); this.queuedSize += size; this.wake?.()
  }
  end() { this.ended = true; this.wake?.() }
  async *iterate(): AsyncIterable<AgentEvent> {
    if (this.consuming) throw new Error('codex_events_already_consumed')
    this.consuming = true
    for (;;) {
      const event = this.events.shift()
      if (event) { if (this.onOverflow) this.queuedSize -= JSON.stringify(event).length; yield event; continue }
      if (this.ended) return
      await new Promise<void>(resolve => { this.wake = resolve })
      this.wake = undefined
    }
  }
}
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value)
const rpcId = (value: unknown): value is RpcId => typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))
const preview = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value ?? '')
const onlyKeys = (value: ObjectValue, keys: string[]) => Object.keys(value).every(key => keys.includes(key))
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string')
const rejectionDecision = (params?: ObjectValue): 'decline' | 'cancel' => Array.isArray(params?.availableDecisions) && !params.availableDecisions.includes('decline') && params.availableDecisions.includes('cancel') ? 'cancel' : 'decline'
const isUserQuestion = (message: Message) => message.method === 'item/tool/requestUserInput'
const isMcpRequest = (message: Message) => message.method === 'mcpServer/elicitation/request'
const trackedRequest = (message: Message) => isUserQuestion(message) || isMcpRequest(message)
const declinedMcp = () => ({ action: 'decline', content: null, _meta: null })
const rejectedRequest = (message: Message) => isMcpRequest(message) ? declinedMcp() : isUserQuestion(message) ? { answers: {} } : { decision: rejectionDecision(message.params) }
const networkAmendment = (value: unknown) => object(value) && onlyKeys(value, ['host', 'action']) && typeof value.host === 'string' && ['allow', 'deny'].includes(value.action)
const approvalDecision = (value: unknown) => {
  if (typeof value === 'string') return ['accept', 'acceptForSession', 'decline', 'cancel'].includes(value)
  if (!object(value) || Object.keys(value).length !== 1) return false
  const exec = value.acceptWithExecpolicyAmendment, network = value.applyNetworkPolicyAmendment
  return (object(exec) && onlyKeys(exec, ['execpolicy_amendment']) && strings(exec.execpolicy_amendment)) ||
    (object(network) && onlyKeys(network, ['network_policy_amendment']) && networkAmendment(network.network_policy_amendment))
}

/** Only known per-command authority can be accepted; proposals never change policy. */
function approvalScope(params: ObjectValue): string | null {
  if (!onlyKeys(params, ['kind', 'threadId', 'turnId', 'itemId', 'startedAtMs', 'approvalId', 'environmentId', 'reason', 'networkApprovalContext', 'command', 'cwd', 'commandActions', 'additionalPermissions', 'availableDecisions', 'proposedExecpolicyAmendment', 'proposedNetworkPolicyAmendments', 'grantRoot'])) return null
  // Native 0.153.4 labels this app-server's local execution environment.
  // Remote/unknown environments are not covered by the selected project policy.
  if ((params.environmentId != null && params.environmentId !== 'local') || params.grantRoot != null) return null
  const decisions = params.availableDecisions
  if (decisions != null && (!Array.isArray(decisions) || !decisions.includes('accept') || !decisions.every(approvalDecision))) return null
  const permissions = params.additionalPermissions, network = params.networkApprovalContext
  if (permissions != null) {
    if (!object(permissions) || !onlyKeys(permissions, ['network', 'fileSystem'])) return null
    const net = permissions.network, fs = permissions.fileSystem
    if (net != null && (!object(net) || !onlyKeys(net, ['enabled']) || (net.enabled != null && typeof net.enabled !== 'boolean'))) return null
    // New filesystem entry/glob forms need an explicit review before support.
    if (fs != null && (!object(fs) || !onlyKeys(fs, ['read', 'write']) || (fs.read != null && !strings(fs.read)) || (fs.write != null && !strings(fs.write)))) return null
  }
  if (network != null && (!object(network) || !onlyKeys(network, ['host', 'protocol']) || typeof network.host !== 'string' || !['http', 'https', 'socks5Tcp', 'socks5Udp'].includes(network.protocol))) return null
  const execProposal = params.proposedExecpolicyAmendment, networkProposals = params.proposedNetworkPolicyAmendments
  if (execProposal != null && !strings(execProposal)) return null
  if (networkProposals != null && (!Array.isArray(networkProposals) || !networkProposals.every(networkAmendment))) return null
  return [
    'Execution environment: local',
    permissions != null && `Additional permissions for this command:\n${JSON.stringify(permissions, null, 2)}`,
    network != null && `Network access for this command:\n${JSON.stringify(network, null, 2)}`,
    execProposal != null && `Suggested future command policy (not applied by this approval):\n${JSON.stringify(execProposal, null, 2)}`,
    networkProposals != null && `Suggested future network policy (not applied by this approval):\n${JSON.stringify(networkProposals, null, 2)}`,
  ].filter(Boolean).join('\n')
}

/** Workbench-only native protocol adapter. Normal chats continue using the SDK. */
export function createWorkbenchCodexProvider(options: Options): AgentProvider {
  return {
    modelCatalog: project => discoverCodexModels(options.codexPathOverride, project.path, options.rpcTimeoutMs),
    async spawn(project, context) {
      const execution = context.execution ? {...context.execution} : undefined
      const model = execution ? execution.model ?? (execution.defaults === 'provider' && !context.resumeSessionId ? context.model ?? options.model : undefined) : context.model ?? options.model
      let selectedModel: AgentExecutionModel | undefined
      const validateAttachments = (attachments?: readonly AgentAttachment[]) => {
        if (selectedModel?.inputModalities && !selectedModel.inputModalities.includes('image') && attachments?.some(item => item.mime.startsWith('image/'))) throw new Error('execution_image_unsupported')
      }
      if (process.platform === 'win32') throw new Error('Codex 工作台暂不支持 Windows：尚未验证任务进程树清理。')
      const discovery = await discoverWorkbenchCodexConfig(options.codexPathOverride, project.path)
      // Startup has no turn. Keep MCPs disabled while reading the native layers,
      // without overwriting the user's web-search mode before config/read.
      const { web_search: _startupSearch, ...startupConfig } = discovery.config
      const enabledMcp = new Set<string>()
      const child = spawn(options.codexPathOverride, [...workbenchCodexArgs(startupConfig), 'app-server', '--listen', 'stdio://'], {
        cwd: project.path, env: workbenchCodexEnv(), stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true, detached: true,
      })
      const rpcs = new Map<RpcId, { resolve: (value: ObjectValue) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
      const approvals = new Map<RpcId, Approval>()
      const questions = new Map<RpcId, UserQuestion>()
      let sequence = 0, threadId = '', active: Turn | undefined, buffer = ''
      let closing = false, exited = false, broken: Error | undefined, closePromise: Promise<void> | undefined
      let resolveExit!: () => void
      const exit = new Promise<void>(resolve => { resolveExit = resolve })
      const lifetime = context.workbenchLifecycle ? new EventQueue(() => fatal('codex_runtime_output_limit')) : undefined
      let registrationVerified = false
      let retained = false, runtimeStarted = false, runtimeEnded = false, stopped = false
      const pendingStarts = new Set<Turn>()
      const rootTurns = new Map<string, Turn>(), descendants = new Map<string, string>()
      const childTurns = new Map<string, Turn>(), occurrences = new Map<string, Turn>()
      const candidates = new Map<string, Message[]>(), unknownBackground = new Set<string>()
      const current = (turn: Turn) => !stopped && !closing && !turn.cancelled && (turn.occurrence ? childTurns.get(turn.threadId) === turn && turn.occurrence.running : active === turn)
      const makeTurn = (owner = threadId, id: string | null = null): Turn => ({ threadId: owner, id, cancelled: false, rejectedOperation: false, events: lifetime ?? new EventQueue(), early: [], items: new Map(), completedItems: new Set(), questionIds: new Set(), startedAt: Date.now() })
      const rememberRequest = (turn: Turn, id: RpcId) => {
        if (lifetime && !turn.questionIds.has(id) && turn.questionIds.size >= 1000) { fatal('codex_runtime_request_limit'); return false }
        turn.questionIds.add(id); return true
      }
      const requestCapacity = () => {
        if (lifetime && approvals.size + questions.size >= 1000) { fatal('codex_runtime_request_limit'); return false }
        return true
      }
      const cacheItem = (turn: Turn, item: ObjectValue) => {
        if (lifetime) {
          if (!turn.items.has(item.id) && turn.items.size >= 1000) { fatal('codex_runtime_item_limit'); return false }
          let size = JSON.stringify(item).length
          for (const [id, value] of turn.items) if (id !== item.id) size += JSON.stringify(value).length
          if (size > 8_000_000) { fatal('codex_runtime_item_limit'); return false }
        }
        turn.items.set(item.id, item); return true
      }
      const endRuntime = () => { runtimeEnded = true; lifetime?.end() }
      const runtimeCapacity = () => {
        if (rootTurns.size + descendants.size + childTurns.size + occurrences.size + candidates.size + unknownBackground.size >= 10_000) { fatal('codex_runtime_record_limit'); return false }
        return true
      }
      const retainUnknown = (key: string) => { if (!unknownBackground.has(key) && runtimeCapacity()) unknownBackground.add(key) }
      const bufferCapacity = (incoming?: Message) => {
        const messages = [...candidates.values()].flat().concat(active?.early ?? [])
        if (messages.length >= 1000 || messages.reduce((size, message) => size + JSON.stringify(message).length, incoming ? JSON.stringify(incoming).length : 0) > 4_000_000) { fatal('codex_protocol_buffer_limit'); return false }
        return true
      }
      const pruneFinishedTurn = (turn: Turn) => {
        for (const [id, item] of turn.items) if (item.type !== 'commandExecution' || (turn.completedItems.has(id) && item.status !== 'inProgress')) turn.items.delete(id)
        turn.completedItems.clear(); turn.questionIds.clear()
      }

      const send = (message: Message, onWritten?: () => void) => {
        if (exited || child.stdin.destroyed || child.stdin.writableEnded) { fatal('codex_protocol_write_failed'); return }
        try {
          child.stdin.write(JSON.stringify(message) + '\n', error => {
            if (error) fatal('codex_protocol_write_failed')
            else onWritten?.()
          })
        } catch { fatal('codex_protocol_write_failed') }
      }
      const dropPendingRequests = (turn?: Turn, reply = true) => {
        const queuedTurn = turn ?? active
        if (queuedTurn) queuedTurn.early = queuedTurn.early.filter(message => {
          if (!rpcId(message.id)) return true
          if (trackedRequest(message)) {
            if (queuedTurn.questionIds.has(message.id)) return false
            if (!stopped && !rememberRequest(queuedTurn, message.id)) return false
          }
          if (reply) send({ id: message.id, result: rejectedRequest(message) })
          return false
        })
        for (const [id, entry] of approvals) {
          if (turn && entry.turn !== turn) continue
          approvals.delete(id); entry.controller.abort()
          if (reply) send({ id, result: entry.mcp ? declinedMcp() : { decision: entry.rejection } })
        }
        for (const [id, entry] of questions) {
          if (turn && entry.turn !== turn) continue
          questions.delete(id); entry.controller.abort()
          if (reply) send({ id, result: { answers: {} } })
        }
      }
      const rejectRpcs = (error: Error) => {
        for (const rpc of rpcs.values()) { clearTimeout(rpc.timer); rpc.reject(error) }
        rpcs.clear()
      }
      const retainUnfinishedCommands = (turn: Turn) => {
        if (!lifetime) return
        for (const item of turn.items.values()) if (item.type === 'commandExecution' && !turn.completedItems.has(item.id)) { retained = true; retainUnknown(`command:${turn.id}:${item.id}`) }
      }
      const finish = (turn: Turn, event: AgentEvent) => {
        if (turn.occurrence) {
          if (!turn.occurrence.running) return
          dropPendingRequests(turn); retainUnfinishedCommands(turn)
          turn.occurrence.finish(event.kind === 'result' ? 'completed' : turn.cancelled ? 'interrupted' : 'failed')
          turn.events.push(turn.occurrence.event()); childTurns.delete(turn.threadId); pruneFinishedTurn(turn)
          return
        }
        if (active !== turn) return
        dropPendingRequests(turn)
        if (lifetime) {
          retainUnfinishedCommands(turn)
          turn.events.push(event); active = undefined; pruneFinishedTurn(turn)
          if (event.kind === 'error' || !retained) endRuntime()
        } else { turn.events.push(event); turn.events.end(); active = undefined }

      }
      const signalOwned = (signal: NodeJS.Signals) => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal)
          else if (!exited) child.kill(signal)
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      }
      const groupAlive = () => {
        if (process.platform === 'win32' || !child.pid) return !exited
        try { process.kill(-child.pid, 0); return true }
        catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
      }
      // Cleanup RPCs remain readable after new input/authority has been blocked.
      // They use the single close deadline and never create a fresh turn.
      const cleanupRequest = (method: string, params: ObjectValue, deadline: number): Promise<ObjectValue> => {
        if (exited || Date.now() >= deadline) return Promise.reject(new Error('codex_terminal_cleanup_unverified'))
        const id = `cc-close-${++sequence}`
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { rpcs.delete(id); reject(new Error('codex_terminal_cleanup_unverified')) }, Math.max(1, deadline - Date.now()))
          rpcs.set(id, {resolve,reject,timer}); send({id,method,params})
        })
      }
      const close = (): Promise<void> => {
        if (closePromise) return closePromise
        stopped = true
        const unverifiedChildren = [...unknownBackground].filter(key => key.startsWith('child:')).map(key => key.slice(6))
        for (const waiting of candidates.values()) for (const message of waiting) if (rpcId(message.id)) send({id:message.id,result:rejectedRequest(message)})
        dropPendingRequests()
        const stoppingTurns = [...new Set([...(active ? [active] : []), ...rootTurns.values(), ...childTurns.values(), ...pendingStarts])].filter(turn => !turn.terminal)
        const interruptTargets = stoppingTurns.filter(turn => !turn.cancelled && turn.id)
        for (const turn of stoppingTurns) turn.cancelled = true
        const timeout = Math.min(options.closeTimeoutMs ?? 2_000, 2_500), deadline = Date.now() + timeout
        closePromise = Promise.resolve().then(async () => {
          let cleanupFailure: Error | undefined
          if (lifetime && threadId && !exited) {
            const cleanupDeadline = Date.now() + Math.max(50, Math.floor((deadline - Date.now()) * .55))
            const fence = async (turn: Turn) => {
              if (!turn.id || turn.terminal) return
              turn.cancelled = true
              try {
                await cleanupRequest('turn/interrupt', {threadId:turn.threadId,turnId:turn.id}, cleanupDeadline)
                // Fixed 0.153.4 replies only upon TurnAborted (not submission).
                if (registrationVerified) turn.terminal = true
              } catch { if (!turn.terminal) cleanupFailure = new Error('codex_terminal_cleanup_unverified') }
            }
            await Promise.all(interruptTargets.map(fence))
            for (;;) {
              const producers = [...new Set([...rootTurns.values(), ...occurrences.values(), ...pendingStarts, ...(active ? [active] : [])])].filter(turn => !turn.terminal)
              const late = producers.filter(turn => !turn.cancelled && turn.id)
              if (late.length) await Promise.all(late.map(fence))
              const observedThreads = new Set([...occurrences.values()].map(turn => turn.threadId))
              const firstTurnPending = [...descendants.keys()].some(id => !observedThreads.has(id))
              if (!producers.some(turn => !turn.terminal) && !candidates.size && !firstTurnPending) break
              if (Date.now() >= cleanupDeadline) { cleanupFailure = new Error('codex_terminal_cleanup_unverified'); break }
              await new Promise<void>(resolve => setTimeout(resolve, 10))
            }

            const cleanupOwner = async (owner: string) => {
              try {
                await cleanupRequest('thread/backgroundTerminals/clean', {threadId:owner}, cleanupDeadline)
                for (;;) {
                  const response = await cleanupRequest('thread/backgroundTerminals/list', {threadId:owner,limit:100}, cleanupDeadline)
                  if (!Array.isArray(response.data)) throw new Error('codex_terminal_cleanup_unverified')
                  if (!response.data.length && response.nextCursor == null) return
                  await new Promise<void>(resolve => setTimeout(resolve, 10))
                }
              } catch { throw new Error('codex_terminal_cleanup_unverified') }
            }
            const cleanupOwners = new Set([threadId, ...descendants.keys()])
            const cleanupResults = await Promise.allSettled([
              ...[...cleanupOwners].map(cleanupOwner),
              ...unverifiedChildren.map(async id => {
                const response = await cleanupRequest('thread/read', {threadId:id,includeTurns:false}, cleanupDeadline)
                const parent = response.thread?.source?.subAgent?.thread_spawn?.parent_thread_id
                if (response.thread?.id !== id || !codexItemId(parent)) throw new Error('codex_terminal_cleanup_unverified')
                // Lineage permits stopping our child; cwd also gates its authority.
                if (cleanupOwners.has(parent)) await cleanupOwner(id)
              }),
            ])
            const uncoveredChild = [...unknownBackground].some(key => key.startsWith('child:') && !cleanupOwners.has(key.slice(6)) && !unverifiedChildren.includes(key.slice(6)))
            if (uncoveredChild || [...descendants.keys()].some(id => !cleanupOwners.has(id)) || candidates.size || [...childTurns.values()].some(turn => !turn.terminal)) cleanupFailure = new Error('codex_terminal_cleanup_unverified')
            if (cleanupResults.some(result => result.status === 'rejected')) cleanupFailure = new Error('codex_terminal_cleanup_unverified')
          } else if (lifetime && (retained || unknownBackground.size || stoppingTurns.some(turn => [...turn.items.values()].some(item => item.type === 'commandExecution')))) cleanupFailure = new Error('codex_terminal_cleanup_unverified')
          closing = true; rejectRpcs(new Error('codex_session_closed'))
          if (active) { if (!lifetime) active.events.end(); active = undefined }
          for (const turn of childTurns.values()) { turn.occurrence!.finish('interrupted'); lifetime?.push(turn.occurrence!.event()) }
          childTurns.clear(); unknownBackground.clear(); endRuntime()
          child.stdin.end(); signalOwned('SIGTERM')
          let killed = false
          while (!exited || groupAlive()) {
            if (Date.now() >= deadline) throw new Error('codex_process_not_exited')
            if (!killed && Date.now() >= deadline - Math.max(50, timeout / 4)) { signalOwned('SIGKILL'); killed = true }
            const pause = new Promise<void>(resolve => setTimeout(resolve, 15))
            await (exited ? pause : Promise.race([exit, pause]))
          }
          if (cleanupFailure) throw cleanupFailure
        })
        return closePromise
      }
      const fatal = (message: string) => {
        if (broken || closing) return
        broken = new Error(message)
        if (lifetime && !active) { lifetime.push({kind:'error',message}); endRuntime() }
        dropPendingRequests(undefined, false)
        if (active) finish(active, { kind: 'error', message })
        rejectRpcs(broken)
        void close().catch(() => {})
      }
      const request = (method: string, params: ObjectValue): Promise<ObjectValue> => {
        if (broken || closing || exited) return Promise.reject(broken ?? new Error('codex_session_closed'))
        const id = `cc-${++sequence}`
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { fatal(`codex_rpc_timeout: ${method}`) }, options.rpcTimeoutMs ?? 30_000)
          rpcs.set(id, { resolve, reject, timer })
          try { send({ id, method, params }) } catch { fatal('codex_protocol_write_failed') }
        })
      }
      const onApproval = (message: Message, turn: Turn) => {
        const id = message.id!, params = message.params!
        if (approvals.has(id)) { fatal('codex_duplicate_approval_request'); return }
        if (!requestCapacity()) return
        const controller = new AbortController(), entry = { controller, turn, rejection: rejectionDecision(params) }
        approvals.set(id, entry)
        const file = message.method === 'item/fileChange/requestApproval'
        const item = turn.items.get(params.itemId)
        const validChanges = Array.isArray(item?.changes) && item.changes.length > 0 && item.changes.every((change: unknown) => object(change) && typeof change.path === 'string' && typeof change.diff === 'string')
        const changes = validChanges ? item!.changes.map((change: ObjectValue) => `${preview(change.path)}\n${preview(change.kind)}\n${preview(change.diff)}`).join('\n\n') : null
        const command = params.command ?? item?.command
        const scope = approvalScope(params)
        const description = (file
          ? [changes, params.reason, scope]
          : [command, params.cwd && `Working directory: ${params.cwd}`, params.reason, scope]
        ).filter(Boolean).join('\n')
        // Stdin grants and unknown approval variants lack a reviewed command;
        // do not turn them into blanket/session policy grants.
        const supported = scope !== null && description.length <= 20_000 && (file ? validChanges : (typeof command === 'string' && !!command.trim() && (!params.kind || params.kind === 'command')))
        if (!supported) {
          send({ id, result: { decision: entry.rejection } })
          fatal('无法核实或完整显示本次 Codex 权限请求，工作台已停止任务。')
          return
        }
        void Promise.resolve().then(() => !controller.signal.aborted && current(turn) && supported && context.requestPermission
          ? context.requestPermission({ tool: file ? 'fileChange' : 'commandExecution', description }, controller.signal)
          : false,
        ).catch(() => false).then(allow => {
          if (approvals.get(id) !== entry || controller.signal.aborted || !current(turn)) return
          if (allow !== true && entry.rejection === 'cancel') turn.rejectedOperation = true
          send({ id, result: { decision: allow === true ? 'accept' : entry.rejection } }, () => {
            if (approvals.get(id) === entry) approvals.delete(id)
          })
        })
      }
      const onQuestion = (message: Message, turn: Turn) => {
        const id = message.id!, params = message.params!
        if (turn.questionIds.has(id)) return
        if (!rememberRequest(turn, id)) return
        if (Array.isArray(params.questions) && params.questions.some((q: unknown) => object(q) && q.isSecret === true)) {
          send({ id, result: { answers: {} } })
          fatal('工作台暂不支持密码等敏感问题，请在原生 Codex 中处理。')
          return
        }
        let request
        try {
          if (typeof params.itemId !== 'string' || !params.itemId || !Array.isArray(params.questions) ||
              (params.isBlocking !== undefined && typeof params.isBlocking !== 'boolean')) throw new Error('invalid_question')
          request = validateUserInputRequest({ questions: params.questions.map((q: unknown) => {
            if (!object(q) || typeof q.isOther !== 'boolean' || q.isSecret !== false || (q.options !== null && !Array.isArray(q.options))) throw new Error('invalid_question')
            return { id: q.id, header: q.header, question: q.question, options: q.options ?? [], multiSelect: false, allowOther: q.options === null || q.isOther }
          }) })
        } catch {
          send({ id, result: { answers: {} } })
          fatal('无法完整显示本次 Codex 问题，工作台已停止任务。')
          return
        }
        if (!requestCapacity()) return
        const controller = new AbortController(), entry = { controller, turn }
        questions.set(id, entry)
        void Promise.resolve().then(() => !controller.signal.aborted && current(turn) && context.requestUserInput
          ? context.requestUserInput(request, controller.signal) : null,
        ).then(answer => answer === null ? null : validateUserInputAnswers(request, answer)).catch(() => null).then(answer => {
          if (questions.get(id) !== entry || controller.signal.aborted || !current(turn)) return
          questions.delete(id)
          send({ id, result: { answers: answer === null ? {} : Object.fromEntries(Object.entries(answer).map(([key, values]) => [key, { answers: values }])) } })
        })
      }
      const onMcpApproval = (message: Message, turn: Turn) => {
        const id = message.id!, params = message.params!
        if (turn.questionIds.has(id)) return
        if (!rememberRequest(turn, id)) return
        const permission = codexMcpApproval(params, turn.items.values(), turn.completedItems, enabledMcp)
        if (!permission) {
          send({ id, result: declinedMcp() })
          turn.events.push({ kind: 'tool_call', tool: 'mcpElicitation', activity: {
            id: `mcp-request-${String(id).slice(0, 100)}`, type: 'tool', status: 'failed', label: '工具请求未能处理',
            detail: '此工具需要尚未支持的表单、外部认证，或无法唯一核实的调用；已拒绝本次请求。',
          } })
          return
        }
        if (!requestCapacity()) return
        const controller = new AbortController(), entry: Approval = { controller, turn, rejection: 'decline', mcp: true }
        approvals.set(id, entry)
        void Promise.resolve().then(() => !controller.signal.aborted && current(turn) && context.requestPermission
          ? context.requestPermission(permission, controller.signal) : false,
        ).catch(() => false).then(allow => {
          if (approvals.get(id) !== entry || controller.signal.aborted || !current(turn)) return
          send({ id, result: { action: allow === true ? 'accept' : 'decline', content: null, _meta: null } }, () => {
            if (approvals.get(id) === entry) approvals.delete(id)
          })
        })
      }
      const verifyChild = (metadata: ObjectValue): boolean => {
        const id = metadata.id, parent = metadata.source?.subAgent?.thread_spawn?.parent_thread_id
        if (!codexItemId(id) || id === threadId || !codexItemId(parent) || (parent !== threadId && !descendants.has(parent)) || metadata.cwd !== project.path) return false
        if (!descendants.has(id) && !runtimeCapacity()) return false
        descendants.set(id, parent); retained = true; unknownBackground.delete(`child:${id}`)
        const waiting = candidates.get(id); candidates.delete(id)
        for (const message of waiting ?? []) route(message)
        return true
      }
      const discoverChild = (id: string) => {
        if (descendants.has(id) || candidates.has(id) || id === threadId) return
        if (!runtimeCapacity()) return
        candidates.set(id, []); retainUnknown(`child:${id}`)
        void request('thread/read', { threadId: id, includeTurns: false }).then(response => {
          if (closing) return
          if (!object(response.thread) || response.thread.id !== id || !verifyChild(response.thread)) {
            const waiting = candidates.get(id); candidates.delete(id)
            for (const message of waiting ?? []) if (rpcId(message.id)) send({id:message.id,result:rejectedRequest(message)})
          }
        }).catch(() => {})
      }
      const registerBackground = (message: Message) => {
        const params = message.params!, item = params.item
        if (!object(item) || !['item/started', 'item/completed'].includes(message.method!)) return
        if (['collabAgentToolCall', 'collabToolCall', 'subAgentActivity'].includes(item.type)) {
          retained = true
          const ids: unknown[] = item.type === 'subAgentActivity' ? [item.agentThreadId] : [...(Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []), item.receiverThreadId, item.newThreadId]
          for (const id of ids) if (codexItemId(id)) discoverChild(id)
          // An unknown launch remains retained even when it cannot be counted.
        }
        if (item.type === 'commandExecution' && message.method === 'item/completed') {
          const key = `command:${params.turnId}:${item.id}`
          if (item.processId && item.exitCode == null && item.status === 'inProgress') { retained = true; retainUnknown(key) }
          else unknownBackground.delete(key)
        }
      }
      const route = (message: Message) => {
        if (message.method) {
          const params = message.params ?? {}
          const isRequest = rpcId(message.id)
          const approval = message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval'
          if (isRequest && !approval && !trackedRequest(message)) {
            if (message.method === 'item/permissions/requestApproval') send({ id: message.id, result: { permissions: {}, scope: 'turn' } })
            else { send({ id: message.id, error: { code: -32601, message: 'This request is not supported in CC Workbench.' } }); fatal('codex_unsupported_server_request') }
            return
          }
          if (lifetime && !closing) {
            if (stopped && message.method === 'turn/started' && params.threadId === threadId && codexItemId(params.turn?.id)) {
              const pending = active && !active.id ? active : [...pendingStarts].find(turn => !turn.id)
              if (pending) { pending.id = params.turn.id; pending.cancelled = false; pendingStarts.delete(pending); rootTurns.set(pending.id!, pending); for (const early of pending.early.splice(0)) route(early) }
              return
            }
            // Native notifications can precede turn/start's response. Keep their
            // wire order until the acknowledged root turn can establish lineage.
            if (active && !active.id && params.threadId !== threadId && params.threadId && !descendants.has(params.threadId) && !candidates.has(params.threadId)) {
              if (!bufferCapacity(message)) { fatal('codex_protocol_buffer_limit'); return }
              active.early.push(message); return
            }
            if (message.method === 'thread/started' && object(params.thread)) { verifyChild(params.thread); return }
            const senderOwned = params.threadId === threadId ? rootTurns.has(params.turnId) || active?.id === params.turnId : occurrences.has(`${params.threadId}:${params.turnId}`)
            if (senderOwned) registerBackground(message)
            if (params.threadId !== threadId && candidates.has(params.threadId)) {
              const waiting = candidates.get(params.threadId)!
              if (!bufferCapacity(message)) { fatal('codex_protocol_buffer_limit'); return }
              waiting.push(message); return
            }
            if (message.method === 'turn/started' && descendants.has(params.threadId) && codexItemId(params.turn?.id)) {
              const key = `${params.threadId}:${params.turn.id}`
              if (occurrences.has(key)) return
              const previous = childTurns.get(params.threadId)
              if (previous?.occurrence?.running) { fatal('codex_overlapping_child_turn'); return }
              if (!runtimeCapacity()) return
              const owned = makeTurn(params.threadId, params.turn.id)
              owned.occurrence = new CodexChildOccurrence(params.threadId, params.turn.id, descendants.get(params.threadId)!)
              childTurns.set(params.threadId, owned); occurrences.set(key, owned)
              owned.events.push(owned.occurrence.event()); return
            }
          }
          if (lifetime && stopped && message.method === 'turn/completed') {
            const known = params.threadId === threadId ? rootTurns.get(params.turn?.id) : occurrences.get(`${params.threadId}:${params.turn?.id}`)
            if (known) { known.terminal = true; dropPendingRequests(known) }
          }
          if (message.method === 'serverRequest/resolved') {
            const pending = approvals.get(params.requestId), question = questions.get(params.requestId)
            const owner = pending?.turn ?? question?.turn
            if (owner && (owner.threadId !== params.threadId || (params.turnId != null && params.turnId !== owner.id))) return
            const matching = params.threadId === threadId ? active : childTurns.get(params.threadId)
            if (!owner && !matching?.early.some(queued => queued.id === params.requestId)) return
            if (matching) {
              matching.early = matching.early.filter(queued => queued.id !== params.requestId)
              if (rpcId(params.requestId) && !rememberRequest(matching, params.requestId)) return
            }
            if (pending) { approvals.delete(params.requestId); pending.controller.abort() }
            if (question) { questions.delete(params.requestId); question.controller.abort() }
            return
          }
          if (lifetime && !isRequest && message.method === 'item/completed' && params.item?.type === 'commandExecution') {
            const previous = params.threadId === threadId ? rootTurns.get(params.turnId) : occurrences.get(`${params.threadId}:${params.turnId}`)
            if (previous && !current(previous) && previous.items.has(params.item.id)) {
              const item = {...previous.items.get(params.item.id), ...params.item}, event = codexActivityEvent(item, true)
              if (event?.kind === 'tool_call' && event.activity) lifetime.push(previous.occurrence ? {...event,activity:{...event.activity,id:`${previous.occurrence.id}:${event.activity.id}`,parentId:previous.occurrence.id}} : event)
              if (item.status !== 'inProgress') previous.items.delete(item.id)
              return
            }
          }
          const turn = params.threadId === threadId ? active : lifetime ? childTurns.get(params.threadId) : undefined
          if (isRequest && trackedRequest(message) && turn?.questionIds.has(message.id!)) return
          if (!turn || (turn.cancelled && message.method !== 'turn/completed') || closing || stopped) {
            if (isRequest) send({ id: message.id, result: rejectedRequest(message) })
            return
          }
          if (!turn.id) {
            if (lifetime && !bufferCapacity(message)) return
            if (turn.early.length > 1_000) { fatal('codex_protocol_buffer_limit'); return }
            turn.early.push(message); return
          }
          const eventTurn = message.method.startsWith('turn/') ? params.turn?.id : params.turnId
          if (eventTurn !== turn.id) { if (isRequest) send({ id: message.id, result: rejectedRequest(message) }); return }
          if (isRequest && (approvals.get(message.id!)?.turn ?? questions.get(message.id!)?.turn) && (approvals.get(message.id!)?.turn ?? questions.get(message.id!)?.turn) !== turn) {
            send({id:message.id,result:rejectedRequest(message)}); fatal('codex_duplicate_server_request'); return
          }
          if (isRequest) { if (isMcpRequest(message)) onMcpApproval(message, turn); else if (isUserQuestion(message)) onQuestion(message, turn); else onApproval(message, turn); return }
          if (!turn.occurrence && message.method === 'model/rerouted' && nativeModelId(params.toModel)) {
            context.reportExecution?.({model:params.toModel,sessionId:threadId,source:'native_reroute'})
          }
          if (message.method === 'item/started' && object(params.item)) {
            const item = params.item
            if (codexItemId(item.id) && turn.completedItems.has(item.id)) return
            if (typeof item.id === 'string' && !cacheItem(turn, item)) return
            const event = codexActivityEvent(item, false)
            if (event) turn.events.push(turn.occurrence && event.kind === 'tool_call' && event.activity ? { ...event, activity: { ...event.activity, id: `${turn.occurrence.id}:${event.activity.id}`, parentId: turn.occurrence.id } } : event)
          } else if (message.method === 'item/fileChange/patchUpdated' && typeof params.itemId === 'string' && Array.isArray(params.changes)) {
            if (turn.completedItems.has(params.itemId)) return
            const item = { ...turn.items.get(params.itemId), id: params.itemId, type: 'fileChange', changes: params.changes }
            if (!cacheItem(turn, item)) return
            const event = codexActivityEvent(item, false)
            if (event) turn.events.push(turn.occurrence && event.kind === 'tool_call' && event.activity ? { ...event, activity: { ...event.activity, id: `${turn.occurrence.id}:${event.activity.id}`, parentId: turn.occurrence.id } } : event)
          } else if (message.method === 'item/agentMessage/delta' && codexItemId(params.itemId) && typeof params.delta === 'string' && params.delta && !turn.completedItems.has(params.itemId)) {
            if (turn.occurrence) { turn.occurrence.text(params.itemId, params.delta, false); turn.events.push(turn.occurrence.event()) }
            else turn.events.push({ kind: 'text', itemId: params.itemId, textMode: 'append', text: params.delta })
          } else if (message.method === 'item/completed' && object(params.item)) {
            const item = { ...turn.items.get(params.item.id), ...params.item }
            if (codexItemId(item.id)) {
              if (turn.completedItems.has(item.id)) return
              turn.completedItems.add(item.id)
              if (!cacheItem(turn, item)) return
            }
            if (item.type === 'agentMessage' && typeof item.text === 'string') {
              if (turn.occurrence) { turn.occurrence.text(item.id, item.text, true); turn.events.push(turn.occurrence.event()) }
              else turn.events.push({ kind: 'text', text: item.text, ...(codexItemId(item.id) ? { itemId: item.id, textMode: 'replace' as const } : {}) })
            } else {
              const event = codexActivityEvent(item, true)
              if (event) turn.events.push(turn.occurrence && event.kind === 'tool_call' && event.activity ? { ...event, activity: { ...event.activity, id: `${turn.occurrence.id}:${event.activity.id}`, parentId: turn.occurrence.id } } : event)
            }
          } else if (message.method === 'error' && !params.willRetry) {
            finish(turn, { kind: 'error', message: typeof params.error?.message === 'string' ? params.error.message : 'codex_turn_failed' })
          } else if (message.method === 'turn/completed') {
            turn.terminal = true
            if (turn.occurrence) {
              for (const item of Array.isArray(params.turn?.items) ? params.turn.items : []) if (item.type === 'agentMessage' && codexItemId(item.id) && typeof item.text === 'string') turn.occurrence.text(item.id, item.text, true)
              dropPendingRequests(turn); retainUnfinishedCommands(turn); turn.occurrence.finish(params.turn?.status)
              turn.events.push(turn.occurrence.event()); childTurns.delete(turn.threadId); pruneFinishedTurn(turn); return
            }
            if (params.turn?.status === 'completed' && !turn.cancelled) finish(turn, { kind: 'result', sessionId: threadId, numTurns: 1, durationMs: typeof params.turn.durationMs === 'number' ? params.turn.durationMs : Date.now() - turn.startedAt })
            else if (params.turn?.status === 'interrupted') finish(turn, { kind: 'error', message: turn.cancelled ? 'Codex 本轮已停止。' : turn.rejectedOperation ? '这次操作已被拒绝，Codex 已结束本轮。可以补充要求后继续。' : 'Codex 本轮已中断，未能确认完成。可以补充要求后继续。' })
            else finish(turn, { kind: 'error', message: typeof params.turn?.error?.message === 'string' ? params.turn.error.message : 'Codex 本轮未能完成，可以补充要求后重试。' })
          }
        } else if (rpcId(message.id)) {
          const rpc = rpcs.get(message.id)
          if (!rpc) return // A timed-out or cancelled client's late response.
          rpcs.delete(message.id); clearTimeout(rpc.timer)
          if (message.error) rpc.reject(new Error(typeof message.error.message === 'string' ? message.error.message : 'codex_rpc_failed'))
          else if (object(message.result)) rpc.resolve(message.result)
          else { rpc.reject(new Error('codex_invalid_rpc_response')); fatal('codex_invalid_rpc_response') }
        } else fatal('codex_invalid_protocol_message')
      }
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => {
        if (closing) return
        buffer += String(chunk)
        if (buffer.length > 4_000_000) { fatal('codex_protocol_buffer_limit'); return }
        while (buffer.includes('\n') && !closing) {
          const end = buffer.indexOf('\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
          if (!line.trim()) continue
          try {
            const message: unknown = JSON.parse(line)
            if (!object(message) || (message.method !== undefined && typeof message.method !== 'string') || (message.params !== undefined && !object(message.params))) throw new Error('invalid message')
            route(message)
          } catch { fatal('codex_invalid_protocol_message') }
        }
      })
      child.stderr.resume()
      child.stdin.on('error', () => fatal('codex_protocol_write_failed'))
      child.stdin.on('close', () => fatal('codex_protocol_write_failed'))
      child.on('error', () => { exited = true; resolveExit(); fatal('codex_process_start_failed') })
      child.on('exit', (code, signal) => {
        exited = true; resolveExit()
        if (!closing) fatal(`codex_process_exited: ${signal ?? code ?? 'unknown'}`)
      })
      try {
        const initialized = await request('initialize', { clientInfo: { name: 'cc_workbench', title: 'CC Workbench', version: '0.6.4' }, capabilities: { experimentalApi: !!lifetime, requestAttestation: false } })
        // Registration-before-parent-result was verified with this exact native
        // protocol version. New/unknown versions retain instead of claiming EOF.
        registrationVerified = typeof initialized.userAgent === 'string' && /^[^/\r\n]+\/0\.153\.4(?:\s|$)/.test(initialized.userAgent)
        if (lifetime && !registrationVerified) retained = true
        send({ method: 'initialized' })
        const native = await request('config/read', { cwd: project.path, includeLayers: false })
        const config = workbenchCodexNativeConfig(discovery.servers, native.config)
        const catalog = execution && (execution.model || execution.reasoningEffort) ? await readCodexModelCatalog(request, project.path) : undefined
        if (catalog && execution?.model) selectedModel = executionModel(catalog, execution)
        for (const [name, server] of Object.entries(config.mcp_servers)) if (server.enabled) enabledMcp.add(name)
        const capabilityNotice = codexNativeCapabilityNotice(discovery.servers, enabledMcp)
        if (capabilityNotice) context.reportNotice?.(capabilityNotice)
        if (enabledMcp.size && !supportsCodexMcpApproval(initialized.userAgent)) throw new Error('原生工具逐次批准需要 Codex 0.153.4 或更新版本，请先更新 Codex。')
        const response = await request(context.resumeSessionId ? 'thread/resume' : 'thread/start', {
          ...(context.resumeSessionId ? { threadId: context.resumeSessionId, excludeTurns: true } : {}),
          cwd: project.path, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write',
          developerInstructions: context.appendInstructions ?? '', config: {...config,...(execution?.reasoningEffort ? {model_reasoning_effort:execution.reasoningEffort} : {})},
          ...(model ? {model} : {}),
        })
        if (typeof response.thread?.id !== 'string' || !response.thread.id) throw new Error('codex_missing_thread_id')
        if (context.resumeSessionId && response.thread.id !== context.resumeSessionId) throw new Error('codex_resume_thread_mismatch')
        if (response.cwd !== project.path) throw new Error('codex_unverified_thread_cwd')
        const sandbox = response.sandbox
        if (response.approvalPolicy !== 'on-request' || response.approvalsReviewer !== 'user' ||
            sandbox?.type !== 'workspaceWrite' || sandbox.networkAccess !== false ||
            sandbox.excludeTmpdirEnvVar !== true || sandbox.excludeSlashTmp !== true ||
            !Array.isArray(sandbox.writableRoots) || sandbox.writableRoots.some((root: unknown) => root !== project.path)) {
          throw new Error('codex_unverified_thread_policy')
        }
        threadId = response.thread.id
        if (catalog && execution) selectedModel = executionModel(catalog, execution, response.model)
        if (nativeModelId(response.model)) context.reportExecution?.({model:response.model,...(nativeModelId(response.reasoningEffort) ? {reasoningEffort:response.reasoningEffort} : {}),sessionId:threadId,source:'native_response'})
      } catch (error) { await close(); throw error }
      const launch = (text: string, attachments?: readonly AgentAttachment[]) => {
        if (active) throw new Error('codex_turn_already_running')
        if (closing || exited || broken || stopped || runtimeEnded) throw broken ?? new Error('codex_session_closed')
        validateAttachments(attachments)
        const input = turnInput(text, attachments), turn = makeTurn()
        active = turn; if (lifetime) pendingStarts.add(turn); turn.events.push({ kind: 'init', sessionId: threadId })
        const accepted = request('turn/start', { threadId, input }).then(response => {
          if (closing) throw new Error('codex_session_closed')
          if (typeof response.turn?.id !== 'string' || !response.turn.id) { fatal('codex_missing_turn_id'); throw new Error('codex_missing_turn_id') }
          if (lifetime && !runtimeCapacity()) throw new Error('codex_runtime_record_limit')
          if (turn.id && turn.id !== response.turn.id) { fatal('codex_turn_start_mismatch'); throw new Error('codex_turn_start_mismatch') }
          const hadId = !!turn.id
          turn.id = response.turn.id; if (lifetime) { pendingStarts.delete(turn); rootTurns.set(turn.id!, turn) }
          if (lifetime && stopped) { if (!hadId) turn.cancelled = false; for (const message of turn.early.splice(0)) route(message); throw new Error('codex_session_closed') }
          if (turn.cancelled) { void request('turn/interrupt', { threadId, turnId: turn.id }).catch(() => {}); throw new Error('codex_turn_cancelled') }
          for (const message of turn.early.splice(0)) route(message)
        }).catch(error => {
          if (!broken && !stopped) pendingStarts.delete(turn)
          if (active === turn) finish(turn, {kind:'error',message:error instanceof Error ? error.message : 'codex_turn_start_failed'})
          throw error
        })
        return { turn, accepted }
      }
      const submitted = new Map<string, { fingerprint: string; accepted: Promise<void> }>()
      let initialAcceptance: Promise<void> = Promise.resolve(), submitTail: Promise<void> = Promise.resolve()
      const runtime: AgentWorkbenchRuntime | undefined = lifetime ? {
        events: { [Symbol.asyncIterator]: () => lifetime.iterate()[Symbol.asyncIterator]() },
        start(text, attachments) {
          if (runtimeStarted) throw new Error('codex_runtime_already_started')
          const launched = launch(text, attachments); runtimeStarted = true
          initialAcceptance = launched.accepted
          void initialAcceptance.catch(error => { if (active === launched.turn) finish(launched.turn, { kind: 'error', message: String(error.message ?? error) }) })
        },
        submit(requestId, text, attachments) {
          attachments = attachments?.map(item => ({...item}))
          if (!runtimeStarted || runtimeEnded || closing || stopped || broken) return Promise.reject(new Error('codex_session_closed'))
          try {
            if (!codexItemId(requestId) || typeof text !== 'string' || (!text.trim() && !attachments?.length)) throw new Error('codex_empty_input')
            validateAttachments(attachments); turnInput(text, attachments)
          } catch (error) { return Promise.reject(error) }
          const fingerprint = JSON.stringify([text, attachments?.map(item => [item.name, item.mime, item.sha256])])
          const prior = submitted.get(requestId)
          if (prior) return prior.fingerprint === fingerprint ? prior.accepted : Promise.reject(new Error('codex_input_id_conflict'))
          if (submitted.size >= 1000) return Promise.reject(new Error('codex_input_limit'))
          // Keep the epoch while an accepted native input can produce additional turns.
          // RPC uncertainty also retains ownership; it must never trigger an automatic retry.
          retained = true
          const accepted = submitTail.then(async () => {
            await initialAcceptance
            if (closing || stopped || runtimeEnded || broken) throw new Error('codex_session_closed')
            if (!active) { await launch(text, attachments).accepted; return }
            const turn = active, expectedTurnId = turn.id
            if (!expectedTurnId || turn.cancelled) throw new Error('codex_no_active_turn')
            const response = await request('turn/steer', { threadId, expectedTurnId, input: turnInput(text, attachments) })
            if (response.turnId !== expectedTurnId) throw new Error('codex_steer_turn_mismatch')
            if (closing || stopped || broken || turn.cancelled) throw new Error('codex_session_closed')
          })
          submitted.set(requestId, { fingerprint, accepted }); submitTail = accepted.catch(() => {})
          return accepted
        },
        snapshot() { return { retained, foreground: stopped || closing ? 'idle' : active ? 'running' : 'idle', backgroundCount: childTurns.size + unknownBackground.size, input: stopped || closing || runtimeEnded ? 'queue' : active ? active.id ? 'steer' : 'queue' : 'send' } },
      } : undefined
      return {
        ...(runtime ? { workbenchRuntime: runtime } : {}),
        dispatch(text, attachments) {
          if (runtime) throw new Error('codex_runtime_requires_lifetime_stream')
          const { turn, accepted } = launch(text, attachments)
          void accepted.catch(error => { if (active === turn) finish(turn, { kind: 'error', message: error instanceof Error ? error.message : 'codex_turn_start_failed' }) })
          return turn.events.iterate()
        },
        async steer(text, attachments) {
          const turn = active
          if (!turn?.id || turn.cancelled || closing || exited || broken) throw new Error('codex_no_active_turn')
          validateAttachments(attachments)
          if (typeof text !== 'string' || (!text.trim() && !attachments?.length)) throw new Error('codex_empty_input')
          const expectedTurnId = turn.id
          const response = await request('turn/steer', { threadId, expectedTurnId, input: turnInput(text, attachments) })
          if (response.turnId !== expectedTurnId) throw new Error('codex_steer_turn_mismatch')
          if (!current(turn) || exited || broken) throw new Error('codex_steer_no_longer_active')
        },
        async cancel() {
          if (lifetime) {
            if (stopped) return
            stopped = true; dropPendingRequests()
            const turns = [...(active ? [active] : []), ...childTurns.values()]
            await Promise.allSettled(turns.map(turn => { turn.cancelled = true; return turn.id ? request('turn/interrupt', { threadId: turn.threadId, turnId: turn.id }).then(() => { if (registrationVerified) turn.terminal = true }) : Promise.resolve() }))
            return
          }
          const turn = active
          if (!turn || closing) return
          turn.cancelled = true; dropPendingRequests(turn)
          if (turn.id) await request('turn/interrupt', { threadId, turnId: turn.id })
          // The acknowledgement means interruption was requested. close()
          // still owns process termination and must confirm actual exit.
        },
        close,
      }
    },
  }
}
