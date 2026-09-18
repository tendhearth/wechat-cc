/**
 * 工作台专用的 ACP(Agent Client Protocol v1)执行者:起 `<command> <args>`(cursor:`cursor-agent acp`),
 * stdio 上换行分隔 JSON-RPC。每个 spawn 一个进程、一个 session;dispatch = 一次 session/prompt。
 *
 * 真机边界(2026-09-17 spike,见 docs/superpowers/specs/2026-09-17-acp-evaluation.md 末节):
 *  - 命令(kind execute)逐次 session/request_permission;工作区内文件编辑不弹卡 ⇒ spawn 时报 ACP_NOTICE;
 *  - 关 stdin 不会让 cursor-agent 退出 ⇒ close() 必须 SIGTERM/SIGKILL 进程组并确认退出;
 *  - 不注入 MCP(工作台任务本来就不给执行者 wechat MCP);不声明 fs/terminal,agent 自己落盘。
 * 对话侧的 Cursor(print 模式,cursor-cli-provider.ts)与本文件无关。
 */
import { spawn as nodeSpawn } from 'node:child_process'
import type { AgentEvent, AgentProvider, AgentSession, SpawnContext } from './agent-provider'
import { AsyncQueue } from './async-queue'
import { makeTurnEmitter } from './turn-emitter'
import { isAuthFail } from './auth-fail'
import { AcpRequestError, createAcpConnection, type AcpConnection } from './acp/rpc'
import { acpPermissionDescription, acpPermissionOption, createAcpTranslator } from './acp/events'

export interface AcpWorkbenchProviderOptions {
  command: string; args: string[]; displayName: string
  /** initialize / session/new / session/load 的上限;缺省 60s。 */
  rpcTimeoutMs?: number
  /** close() 确认进程组退出的上限;缺省 2.5s(留出余量给服务层自己的 3s close 竞速 —
   *  等于 3s 会让 acp_process_not_exited 永远赶不上服务层自己先超时返回,调用方看不到它)。 */
  closeTimeoutMs?: number
  spawn?: typeof nodeSpawn
}

export const ACP_NOTICE = 'Cursor 通过 ACP 执行：命令会逐次请求批准；工作区内的文件编辑由 Cursor 直接执行，不经过权限卡。'
const CLIENT_CAPABILITIES = { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
const CLIENT_INFO = { name: 'cc_workbench', title: 'CC Workbench', version: '0.6.4' }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
// 换行会破坏 stdio 上的换行分隔协议(把一个 session id 拆成两条消息),因此当作"缺失"处理。
const sessionIdOk = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\r\n]/.test(value)

interface Turn { queue: AsyncQueue<AgentEvent>; cancelled: boolean; startedAt: number }
interface PendingPermission { controller: AbortController; respond: (outcome: unknown) => void }

export function createAcpWorkbenchProvider(options: AcpWorkbenchProviderOptions): AgentProvider {
  const spawn = options.spawn ?? nodeSpawn
  const rpcTimeoutMs = options.rpcTimeoutMs ?? 60_000, closeTimeoutMs = options.closeTimeoutMs ?? 2_500
  return {
    async spawn(project, context: SpawnContext): Promise<AgentSession> {
      if (process.platform === 'win32') throw new Error('Cursor 工作台暂不支持 Windows：尚未验证任务进程树清理。')
      const child = spawn(options.command, options.args, { cwd: project.path, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true, windowsHide: true })
      const permissions = new Map<string, PendingPermission>()
      const translator = createAcpTranslator()
      let sessionId = '', active: Turn | undefined, loading = true
      let closing = false, exited = false, broken: Error | undefined, closePromise: Promise<void> | undefined
      let resolveExit!: () => void
      const exit = new Promise<void>(resolve => { resolveExit = resolve })
      let instructionsInjected = false

      const settlePermissions = (outcome: unknown) => {
        for (const [id, entry] of permissions) { permissions.delete(id); entry.controller.abort(); entry.respond(outcome) }
      }
      const finish = (turn: Turn, event: AgentEvent) => {
        if (active !== turn) return
        active = undefined
        settlePermissions({ outcome: { outcome: 'cancelled' } })
        turn.queue.push(event); turn.queue.end()
      }
      // 先收掉在飞回合(把中文提示作为该回合最后一个事件推出),再 dispose 连接 ——
      // 颠倒顺序会让 dispose 触发的挂起请求 reject 抢先把 finish 判定为"晚到"而丢弃这句提示。
      const fatal = (message: string) => {
        if (broken || closing) return
        broken = new Error(message)
        if (active) finish(active, { kind: 'error', message })
        connection.dispose(new Error('acp_session_closed'))
      }
      const connection: AcpConnection = createAcpConnection(child.stdin!, child.stdout!, {
        rpcTimeoutMs,
        onNotification(method, params) {
          if (method !== 'session/update' || loading || !object(params) || params.sessionId !== sessionId) return
          const turn = active
          if (!turn || turn.cancelled) return
          for (const event of translator.update(params.update)) turn.queue.push(event)
        },
        async onRequest(method, params) {
          if (method !== 'session/request_permission') throw Object.assign(new Error(`client capability not declared: ${method}`), { code: -32601 })
          const turn = active
          if (!turn || turn.cancelled || closing || !object(params) || params.sessionId !== sessionId) return { outcome: { outcome: 'cancelled' } }
          const description = acpPermissionDescription(params)
          if (description === null) { queueMicrotask(() => fatal('无法核实或完整显示本次 Cursor 权限请求，工作台已停止任务。')); return { outcome: { outcome: 'cancelled' } } }
          const toolCall = params.toolCall as Record<string, unknown>
          const tool = typeof toolCall.kind === 'string' && toolCall.kind ? toolCall.kind : 'tool'
          return new Promise<unknown>(resolve => {
            const controller = new AbortController()
            const key = `${Date.now()}:${Math.random()}`
            const entry: PendingPermission = { controller, respond: resolve }
            permissions.set(key, entry)
            void Promise.resolve().then(() => context.requestPermission ? context.requestPermission({ tool, description }, controller.signal) : false)
              .catch(() => false)
              .then(allow => {
                if (permissions.get(key) !== entry) return
                permissions.delete(key)
                if (controller.signal.aborted || active !== turn) { resolve({ outcome: { outcome: 'cancelled' } }); return }
                const optionId = acpPermissionOption(params.options, allow === true)
                resolve(optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } })
              })
          })
        },
        onFatal(error) { fatal(error.message) },
      })
      // Bounded tail, not raw retention: enough to fold cursor-agent's own fatal line into a
      // session-setup rejection (real diagnostics live on stderr, not in the JSON-RPC error
      // shape), without letting a chatty child grow this unboundedly.
      let stderrTail = ''
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', chunk => { stderrTail = (stderrTail + String(chunk)).slice(-8192) })
      child.on('error', () => { exited = true; resolveExit(); fatal('acp_process_start_failed') })
      child.on('exit', (code, signal) => { exited = true; resolveExit(); if (!closing) fatal(`acp_process_exited: ${signal ?? code ?? 'unknown'}`) })

      const signalGroup = (signal: NodeJS.Signals) => {
        try { if (child.pid) process.kill(-child.pid, signal); else child.kill(signal) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      }
      const groupAlive = () => {
        if (!child.pid) return !exited
        try { process.kill(-child.pid, 0); return true }
        catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
      }
      const close = (): Promise<void> => {
        if (closePromise) return closePromise
        closing = true
        closePromise = (async () => {
          const deadline = Date.now() + closeTimeoutMs
          settlePermissions({ outcome: { outcome: 'cancelled' } })
          if (active && sessionId) { active.cancelled = true; connection.notify('session/cancel', { sessionId }) }
          if (active) finish(active, { kind: 'error', message: 'acp_session_closed' })
          connection.dispose(new Error('acp_session_closed'))
          try { child.stdin?.end() } catch { /* already closed */ }
          signalGroup('SIGTERM')
          let killed = false
          while (!exited || groupAlive()) {
            // Best-effort: a non-ESRCH errno here (e.g. EPERM) must not replace the deterministic
            // acp_process_not_exited below with a raw errno error — the caller needs a stable
            // error to match on regardless of what this last kill attempt itself did.
            if (Date.now() >= deadline) { try { signalGroup('SIGKILL') } catch { /* reported via acp_process_not_exited below */ } throw new Error('acp_process_not_exited') }
            if (!killed && Date.now() >= deadline - Math.max(50, closeTimeoutMs / 4)) { signalGroup('SIGKILL'); killed = true }
            const pause = new Promise<void>(resolve => setTimeout(resolve, 15))
            await (exited ? pause : Promise.race([exit, pause]))
          }
        })()
        return closePromise
      }
      const setupError = (error: unknown): Error => {
        // acp_auth_required stays a bare code — the login-hint copy upstream is keyed on this
        // exact string, and stderr for an auth failure is rarely more informative than the code.
        if (error instanceof AcpRequestError && (error.code === -32000 || isAuthFail('sdk-error', error.message))) return new Error('acp_auth_required')
        if (error instanceof AcpRequestError) {
          const tail = stderrTail.trim().slice(-300)
          return new Error(tail ? `acp_session_failed: ${error.message}\n${tail}` : `acp_session_failed: ${error.message}`)
        }
        return error instanceof Error ? error : new Error(String(error))
      }
      try {
        const initialized = await connection.request('initialize', { protocolVersion: 1, clientCapabilities: CLIENT_CAPABILITIES, clientInfo: CLIENT_INFO })
        if (!object(initialized) || initialized.protocolVersion !== 1) throw new Error('acp_protocol_version_unsupported')
        const loadSession = object(initialized.agentCapabilities) && initialized.agentCapabilities.loadSession === true
        if (context.resumeSessionId) {
          if (!loadSession) throw new Error('acp_resume_unsupported')
          sessionId = context.resumeSessionId
          const loaded = await connection.request('session/load', { sessionId, cwd: project.path, mcpServers: [] })
          if (object(loaded) && loaded.sessionId !== undefined && loaded.sessionId !== sessionId) throw new Error('acp_resume_session_mismatch')
        } else {
          const created = await connection.request('session/new', { cwd: project.path, mcpServers: [] })
          if (!object(created) || !sessionIdOk(created.sessionId)) throw new Error('acp_missing_session_id')
          sessionId = created.sessionId
        }
      } catch (error) {
        const mapped = setupError(error)
        await close().catch(() => {})
        throw mapped
      }
      loading = false
      context.reportNotice?.(ACP_NOTICE)

      return {
        dispatch(text, attachments) {
          if (attachments?.length) throw new Error('acp_attachments_unsupported')
          if (closing || broken || exited) throw new Error('acp_session_closed')
          if (active) throw new Error('acp_turn_already_running')
          const em = makeTurnEmitter()
          const turn: Turn = { queue: new AsyncQueue<AgentEvent>(), cancelled: false, startedAt: Date.now() }
          active = turn
          translator.beginTurn()
          turn.queue.push(em.init(sessionId))
          let prompt = text
          if (!instructionsInjected && context.appendInstructions) { prompt = `${context.appendInstructions}\n\n---\n\n${text}`; instructionsInjected = true }
          void connection.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] }, 0).then(
            result => {
              const reason = object(result) && typeof result.stopReason === 'string' ? result.stopReason : 'end_turn'
              if (reason === 'cancelled' && turn.cancelled) finish(turn, { kind: 'error', message: 'acp_turn_cancelled' })
              else if (reason === 'end_turn' || reason === 'cancelled') finish(turn, em.finish({ sessionId, numTurns: 1, durationMs: Date.now() - turn.startedAt }))
              else finish(turn, { kind: 'error', message: `acp_stop_${reason}` })
            },
            (error: unknown) => { if (active === turn) finish(turn, em.errorText(error instanceof Error ? error.message : String(error))) },
          )
          const iterable = turn.queue.iterable()
          return {
            [Symbol.asyncIterator]() {
              const inner = iterable[Symbol.asyncIterator]()
              return {
                next: () => inner.next(),
                return: async (value?: AgentEvent) => {
                  if (active === turn && !turn.cancelled) { turn.cancelled = true; settlePermissions({ outcome: { outcome: 'cancelled' } }); connection.notify('session/cancel', { sessionId }) }
                  return inner.return!(value)
                },
              }
            },
          }
        },
        async cancel() {
          const turn = active
          if (!turn || turn.cancelled || closing) return
          turn.cancelled = true
          settlePermissions({ outcome: { outcome: 'cancelled' } })
          connection.notify('session/cancel', { sessionId })
        },
        close,
      }
    },
  }
}
