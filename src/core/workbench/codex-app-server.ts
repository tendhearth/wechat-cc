import { spawn } from 'node:child_process'
import type { AgentEvent, AgentProvider } from '../agent-provider'
import { discoverWorkbenchCodexConfig, workbenchCodexArgs, workbenchCodexEnv, workbenchCodexNativeConfig } from './codex-config'
import { validateUserInputAnswers, validateUserInputRequest } from './user-input'
import { codexActivityEvent, codexItemId } from './codex-activity'
import { codexMcpApproval, supportsCodexMcpApproval } from './codex-mcp-approval'
import { codexNativeCapabilityNotice } from './native-capability-notice'

type RpcId = string | number
// The JSONL boundary is checked below before any request is routed or action accepted.
type ObjectValue = Record<string, any>
interface Message { id?: RpcId; method?: string; params?: ObjectValue; result?: ObjectValue; error?: { code?: number; message?: string } }
interface Options { codexPathOverride: string; model?: string; rpcTimeoutMs?: number; closeTimeoutMs?: number }
interface Approval { controller: AbortController; turn: Turn; rejection: 'decline' | 'cancel'; mcp?: boolean }
interface UserQuestion { controller: AbortController; turn: Turn }
interface Turn { id: string | null; cancelled: boolean; rejectedOperation: boolean; events: EventQueue; early: Message[]; items: Map<string, ObjectValue>; completedItems: Set<string>; questionIds: Set<RpcId>; startedAt: number }

class EventQueue {
  private events: AgentEvent[] = []
  private ended = false
  private wake?: () => void
  push(event: AgentEvent) { if (!this.ended) { this.events.push(event); this.wake?.() } }
  end() { this.ended = true; this.wake?.() }
  async *iterate(): AsyncIterable<AgentEvent> {
    for (;;) {
      const event = this.events.shift()
      if (event) { yield event; continue }
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
    async spawn(project, context) {
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
            queuedTurn.questionIds.add(message.id)
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
      const finish = (turn: Turn, event: AgentEvent) => {
        if (active !== turn) return
        dropPendingRequests(turn)
        turn.events.push(event); turn.events.end(); active = undefined
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
      const close = (): Promise<void> => {
        if (closePromise) return closePromise
        closing = true
        dropPendingRequests()
        rejectRpcs(new Error('codex_session_closed'))
        if (active) { active.cancelled = true; active.events.end(); active = undefined }
        closePromise = (async () => {
          child.stdin.end()
          signalOwned('SIGTERM')
          const timeout = Math.min(options.closeTimeoutMs ?? 2_000, 2_500)
          const deadline = Date.now() + timeout
          let killed = false
          while (!exited || groupAlive()) {
            if (Date.now() >= deadline) throw new Error('codex_process_not_exited')
            if (!killed && Date.now() >= deadline - Math.max(100, timeout / 2)) { signalOwned('SIGKILL'); killed = true }
            const pause = new Promise<void>(resolve => setTimeout(resolve, 15))
            await (exited ? pause : Promise.race([exit, pause]))
          }
        })()
        return closePromise
      }
      const fatal = (message: string) => {
        if (broken || closing) return
        broken = new Error(message)
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
        void Promise.resolve().then(() => !controller.signal.aborted && active === turn && !turn.cancelled && supported && context.requestPermission
          ? context.requestPermission({ tool: file ? 'fileChange' : 'commandExecution', description }, controller.signal)
          : false,
        ).catch(() => false).then(allow => {
          if (approvals.get(id) !== entry || controller.signal.aborted || active !== turn || turn.cancelled || closing) return
          if (allow !== true && entry.rejection === 'cancel') turn.rejectedOperation = true
          send({ id, result: { decision: allow === true ? 'accept' : entry.rejection } }, () => {
            if (approvals.get(id) === entry) approvals.delete(id)
          })
        })
      }
      const onQuestion = (message: Message, turn: Turn) => {
        const id = message.id!, params = message.params!
        if (turn.questionIds.has(id)) return
        turn.questionIds.add(id)
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
        const controller = new AbortController(), entry = { controller, turn }
        questions.set(id, entry)
        void Promise.resolve().then(() => !controller.signal.aborted && active === turn && !turn.cancelled && context.requestUserInput
          ? context.requestUserInput(request, controller.signal) : null,
        ).then(answer => answer === null ? null : validateUserInputAnswers(request, answer)).catch(() => null).then(answer => {
          if (questions.get(id) !== entry || controller.signal.aborted || active !== turn || turn.cancelled || closing) return
          questions.delete(id)
          send({ id, result: { answers: answer === null ? {} : Object.fromEntries(Object.entries(answer).map(([key, values]) => [key, { answers: values }])) } })
        })
      }
      const onMcpApproval = (message: Message, turn: Turn) => {
        const id = message.id!, params = message.params!
        if (turn.questionIds.has(id)) return
        turn.questionIds.add(id)
        const permission = codexMcpApproval(params, turn.items.values(), turn.completedItems, enabledMcp)
        if (!permission) {
          send({ id, result: declinedMcp() })
          turn.events.push({ kind: 'tool_call', tool: 'mcpElicitation', activity: {
            id: `mcp-request-${String(id).slice(0, 100)}`, type: 'tool', status: 'failed', label: '工具请求未能处理',
            detail: '此工具需要尚未支持的表单、外部认证，或无法唯一核实的调用；已拒绝本次请求。',
          } })
          return
        }
        const controller = new AbortController(), entry: Approval = { controller, turn, rejection: 'decline', mcp: true }
        approvals.set(id, entry)
        void Promise.resolve().then(() => !controller.signal.aborted && active === turn && !turn.cancelled && context.requestPermission
          ? context.requestPermission(permission, controller.signal) : false,
        ).catch(() => false).then(allow => {
          if (approvals.get(id) !== entry || controller.signal.aborted || active !== turn || turn.cancelled || closing) return
          send({ id, result: { action: allow === true ? 'accept' : 'decline', content: null, _meta: null } }, () => {
            if (approvals.get(id) === entry) approvals.delete(id)
          })
        })
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
          if (message.method === 'serverRequest/resolved') {
            if (params.threadId !== threadId) return
            if (active) {
              active.early = active.early.filter(queued => queued.id !== params.requestId)
              if (rpcId(params.requestId)) active.questionIds.add(params.requestId)
            }
            const pending = approvals.get(params.requestId)
            if (pending) { approvals.delete(params.requestId); pending.controller.abort() }
            const question = questions.get(params.requestId)
            if (question) { questions.delete(params.requestId); question.controller.abort() }
            return
          }
          const turn = active
          if (isRequest && trackedRequest(message) && params.threadId === threadId && turn?.questionIds.has(message.id!)) return
          if (!turn || params.threadId !== threadId || (turn.cancelled && message.method !== 'turn/completed') || closing) {
            if (isRequest) send({ id: message.id, result: rejectedRequest(message) })
            return
          }
          if (!turn.id) {
            if (turn.early.length > 1_000) { fatal('codex_protocol_buffer_limit'); return }
            turn.early.push(message); return
          }
          const eventTurn = message.method.startsWith('turn/') ? params.turn?.id : params.turnId
          if (eventTurn !== turn.id) { if (isRequest) send({ id: message.id, result: rejectedRequest(message) }); return }
          if (isRequest) { if (isMcpRequest(message)) onMcpApproval(message, turn); else if (isUserQuestion(message)) onQuestion(message, turn); else onApproval(message, turn); return }
          if (message.method === 'item/started' && object(params.item)) {
            const item = params.item
            if (codexItemId(item.id) && turn.completedItems.has(item.id)) return
            if (typeof item.id === 'string') turn.items.set(item.id, item)
            const event = codexActivityEvent(item, false)
            if (event) turn.events.push(event)
          } else if (message.method === 'item/fileChange/patchUpdated' && typeof params.itemId === 'string' && Array.isArray(params.changes)) {
            if (turn.completedItems.has(params.itemId)) return
            const item = { ...turn.items.get(params.itemId), id: params.itemId, type: 'fileChange', changes: params.changes }
            turn.items.set(params.itemId, item)
            const event = codexActivityEvent(item, false)
            if (event) turn.events.push(event)
          } else if (message.method === 'item/agentMessage/delta' && codexItemId(params.itemId) && typeof params.delta === 'string' && params.delta && !turn.completedItems.has(params.itemId)) {
            turn.events.push({ kind: 'text', itemId: params.itemId, textMode: 'append', text: params.delta })
          } else if (message.method === 'item/completed' && object(params.item)) {
            const item = { ...turn.items.get(params.item.id), ...params.item }
            if (codexItemId(item.id)) {
              if (turn.completedItems.has(item.id)) return
              turn.completedItems.add(item.id)
              turn.items.set(item.id, item)
            }
            if (item.type === 'agentMessage' && typeof item.text === 'string') {
              turn.events.push({ kind: 'text', text: item.text, ...(codexItemId(item.id) ? { itemId: item.id, textMode: 'replace' as const } : {}) })
            } else {
              const event = codexActivityEvent(item, true)
              if (event) turn.events.push(event)
            }
          } else if (message.method === 'error' && !params.willRetry) {
            finish(turn, { kind: 'error', message: typeof params.error?.message === 'string' ? params.error.message : 'codex_turn_failed' })
          } else if (message.method === 'turn/completed') {
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
        const initialized = await request('initialize', { clientInfo: { name: 'cc_workbench', title: 'CC Workbench', version: '0.6.4' }, capabilities: { experimentalApi: false, requestAttestation: false } })
        send({ method: 'initialized' })
        const native = await request('config/read', { cwd: project.path, includeLayers: false })
        const config = workbenchCodexNativeConfig(discovery.servers, native.config)
        for (const [name, server] of Object.entries(config.mcp_servers)) if (server.enabled) enabledMcp.add(name)
        const capabilityNotice = codexNativeCapabilityNotice(discovery.servers, enabledMcp)
        if (capabilityNotice) context.reportNotice?.(capabilityNotice)
        if (enabledMcp.size && !supportsCodexMcpApproval(initialized.userAgent)) throw new Error('原生工具逐次批准需要 Codex 0.153.4 或更新版本，请先更新 Codex。')
        const response = await request(context.resumeSessionId ? 'thread/resume' : 'thread/start', {
          ...(context.resumeSessionId ? { threadId: context.resumeSessionId, excludeTurns: true } : {}),
          cwd: project.path, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write',
          developerInstructions: context.appendInstructions ?? '', config,
          ...((context.model ?? options.model) ? { model: context.model ?? options.model } : {}),
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
      } catch (error) { await close(); throw error }
      return {
        dispatch(text) {
          if (active) throw new Error('codex_turn_already_running')
          if (closing || exited || broken) throw broken ?? new Error('codex_session_closed')
          const turn: Turn = { id: null, cancelled: false, rejectedOperation: false, events: new EventQueue(), early: [], items: new Map(), completedItems: new Set(), questionIds: new Set(), startedAt: Date.now() }
          active = turn; turn.events.push({ kind: 'init', sessionId: threadId })
          void request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] }).then(response => {
            if (active !== turn || closing) return
            if (typeof response.turn?.id !== 'string' || !response.turn.id) { fatal('codex_missing_turn_id'); return }
            turn.id = response.turn.id
            if (turn.cancelled) { void request('turn/interrupt', { threadId, turnId: turn.id }).catch(() => {}); return }
            for (const message of turn.early.splice(0)) route(message)
          }).catch(error => { if (active === turn) finish(turn, { kind: 'error', message: error instanceof Error ? error.message : 'codex_turn_start_failed' }) })
          return turn.events.iterate()
        },
        async steer(text) {
          const turn = active
          if (!turn?.id || turn.cancelled || closing || exited || broken) throw new Error('codex_no_active_turn')
          if (typeof text !== 'string' || !text.trim()) throw new Error('codex_empty_input')
          const expectedTurnId = turn.id
          const response = await request('turn/steer', { threadId, expectedTurnId, input: [{ type: 'text', text, text_elements: [] }] })
          if (response.turnId !== expectedTurnId) throw new Error('codex_steer_turn_mismatch')
          if (active !== turn || turn.cancelled || closing || exited || broken) throw new Error('codex_steer_no_longer_active')
        },
        async cancel() {
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
