/**
 * 通用的 ACP(Agent Client Protocol v1)执行者:起 `<command> <args>`(cursor:`cursor-agent acp`),
 * stdio 上换行分隔 JSON-RPC。每个 spawn 一个进程、一个 session;dispatch = 一次 session/prompt。
 * 两种用法靠 `AcpProviderOptions` 的五个选项(permissions/text/mcpServers/model/resume/notice)分岔:
 *  - 工作台(`acp-workbench-provider.ts` 薄封装):逐工具权限桥(`permissions:'bridge'`)+ 逐字流(`text:'append'`)、
 *    不注入 MCP、不钉模型、resume 失败即拒绝、固定报 acpNotice()。
 *  - 对话侧(cursor 走 ACP):权限按 `permissionMode` 就地判(`permissions:'mode'`)+ 每条助理消息一条文本
 *    (`text:'messages'`)、可注入 wechat MCP、可钉模型、resume 失败可回退新会话、notice 可关闭。
 *
 * 真机边界(2026-09-17 spike,见 docs/superpowers/specs/2026-09-17-acp-evaluation.md 末节):
 *  - 命令(kind execute)逐次 session/request_permission;工作区内文件编辑不弹卡 ⇒ spawn 时报 notice();
 *  - 关 stdin 不会让 cursor-agent 退出 ⇒ close() 必须 SIGTERM/SIGKILL 进程组并确认退出;
 *  - 不声明 fs/terminal,agent 自己落盘。
 */
import { spawn as nodeSpawn } from 'node:child_process'
import type { AgentAttachment, AgentEvent, AgentProvider, AgentSession, SpawnContext } from './agent-provider'
import { AsyncQueue } from './async-queue'
import { makeTurnEmitter } from './turn-emitter'
import { isAuthFail } from './auth-fail'
import { AcpRequestError, createAcpConnection, type AcpConnection } from './acp/rpc'
import { acpPermissionDescription, acpPermissionOption, createAcpTranslator } from './acp/events'
import { workbenchSubprocessEnv } from './workbench/subprocess-env'

export interface AcpProviderBaseOptions {
  command: string; args: string[]; displayName: string
  /** initialize / session/new / session/load 的上限;缺省 45s(留出余量给服务层自己的 60s
   *  session_start_timeout 竞速 —— 等于 60s 会让这里的 acp_rpc_timeout 永远赶不上服务层先超时,
   *  调用方看不到"是哪一步卡住了"。与下面 closeTimeoutMs 让路 3s close 同一条道理)。 */
  rpcTimeoutMs?: number
  /** close() 确认进程组退出的上限;缺省 2.5s(留出余量给服务层自己的 3s close 竞速 —
   *  等于 3s 会让 acp_process_not_exited 永远赶不上服务层自己先超时返回,调用方看不到它)。 */
  closeTimeoutMs?: number
  /** 同时挂起的权限请求上限;缺省 100。越过 ⇒ acp_request_limit 停任务。 */
  permissionLimit?: number
  spawn?: typeof nodeSpawn
  /** daemon 日志口(tag, line)。每个 session 每类最多一行,只记"悄悄丢掉了什么"。 */
  log?: (tag: string, line: string) => void
}

export interface AcpMcpServer { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }
export interface AcpProviderOptions extends AcpProviderBaseOptions {
  /** 'bridge':逐工具转给 context.requestPermission(工作台任务桥);
   *  'mode':就地按 context.permissionMode 判(dangerously ⇒ allow-once,否则 reject-once),从不调用桥。 */
  permissions: 'bridge' | 'mode'
  /** 'append':token 级 chunk(工作台逐字流);'messages':每条助理消息一条 text 事件(对话侧)。 */
  text: 'append' | 'messages'
  /** 注入的 MCP server 列表;缺省不注入(工作台任务本来就不给执行者 wechat MCP)。 */
  mcpServers?: (context: SpawnContext) => AcpMcpServer[]
  /** 想钉的模型;只在新开的会话上生效(session/load 沿用会话原状),agent 未提供该选项时只记日志。 */
  model?: (context: SpawnContext) => string | undefined
  /** 'strict'(缺省):session/load 失败即拒绝(工作台语义,resume 到期就该让调用方知道);
   *  'fallback':失败后在同一进程内退回 session/new(对话侧语义,旧会话早晚会失效)。 */
  resume?: 'strict' | 'fallback'
  /** spawn 时报给主人的提示;缺省 acpNotice(displayName);null ⇒ 不报(对话侧不需要"编辑不经过权限卡"这句)。 */
  notice?: string | null
  /** 'refuse'(缺省):带附件即拒;'prompt':图片进 image 块(受 promptCapabilities.image 门控),
   *  其它附件给引用文本块(工作台语义,与 codex-app-server.ts 的 turnInput 同一做法)。 */
  attachments?: 'refuse' | 'prompt'
}

export type AcpPromptBlock = { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
/** 图片进 prompt 的 image 块(受 agent 的 promptCapabilities.image 门控);其它附件给引用文本块,执行者自己用文件工具读落盘那份 —— 与 Codex 的 turnInput 同一做法。 */
export function acpPromptBlocks(text: string, attachments: readonly AgentAttachment[] | undefined, imageOk: boolean): AcpPromptBlock[] {
  const list = attachments ?? []
  const blocks: AcpPromptBlock[] = text || !list.length ? [{ type: 'text', text }] : []
  for (const attachment of list) {
    if (attachment.mime.startsWith('image/')) {
      if (!IMAGE_MIMES.has(attachment.mime)) throw new Error('attachment_image_unsupported')
      if (!imageOk) throw new Error('acp_attachment_image_unsupported')
      if (!attachment.data) throw new Error('attachment_data_missing')
      blocks.push({ type: 'image', mimeType: attachment.mime, data: attachment.data })
    } else {
      const { name, mime, path, sha256 } = attachment
      blocks.push({ type: 'text', text: 'Attached task file (reference material; read with a file tool if needed):\n' + JSON.stringify({ name, mime, path, sha256 }) })
    }
  }
  return blocks
}

/** 每个任务开跑时报给主人的一句话。真机 spike:ACP 面上没有"编辑也要批准"的开关。 */
export const acpNotice = (displayName: string): string =>
  `${displayName} 通过 ACP 执行：命令会逐次请求批准；工作区内的文件编辑由 ${displayName} 直接执行，不经过权限卡。`
const CLIENT_CAPABILITIES = { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
// 客户端身份(initialize.clientInfo):对面看到的是"谁在连我" —— 现在对话侧也走这条路,
// 名字不能再说自己是工作台。version 写死成 package.json 当时的版本:core/ 里没有读 package.json
// 的 helper,直接 import 一份 JSON 只为一行字符串不值当;发版改 package.json 时顺手同步这里。
const CLIENT_INFO = { name: 'wechat-cc', title: 'CC', version: '0.6.4' }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
// 换行会破坏 stdio 上的换行分隔协议(把一个 session id 拆成两条消息),因此当作"缺失"处理。
const sessionIdOk = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\r\n]/.test(value)

interface Turn { queue: AsyncQueue<AgentEvent>; cancelled: boolean; startedAt: number }
interface PendingPermission { controller: AbortController; respond: (outcome: unknown) => void }
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g
/** agent 给的 sessionId 直接进日志行会把控制字符/超长串带进 daemon 日志,先收敛。 */
const forLog = (value: unknown): string => typeof value === 'string' ? value.replace(CONTROL_CHARS, ' ').slice(0, 80) : typeof value === 'undefined' ? '(none)' : String(value).slice(0, 80)

export function createAcpProvider(options: AcpProviderOptions): AgentProvider {
  const spawn = options.spawn ?? nodeSpawn
  const rpcTimeoutMs = options.rpcTimeoutMs ?? 45_000, closeTimeoutMs = options.closeTimeoutMs ?? 2_500
  const permissionLimit = options.permissionLimit ?? 100
  return {
    async spawn(project, context: SpawnContext): Promise<AgentSession> {
      // 对话侧与工作台共用这一句:两边都靠 close() 杀进程组收尾,Windows 上那条路没验过。
      // 文案不提"工作台" —— 对话侧也会撞到它(bootstrap 那边另有一道门:win32 不注册 ACP 对话 provider)。
      if (process.platform === 'win32') throw new Error(`${options.displayName} 暂不支持 Windows：尚未验证进程树清理。`)
      // daemon 自己的凭据不进外部 CLI —— cursor-agent 还会再 spawn 它自己的 MCP 子进程,env 是会传染的。
      const child = spawn(options.command, options.args, { cwd: project.path, env: workbenchSubprocessEnv(), stdio: ['pipe', 'pipe', 'pipe'], detached: true, windowsHide: true })
      // 按 JSON-RPC 请求 id 记账:id 是 agent 唯一能用来对上回复的东西,撞 id ⇒ 协议已经不可信。
      const permissions = new Map<string | number, PendingPermission>()
      const logged = new Set<string>()
      const logOnce = (kind: string, line: string) => { if (!options.log || logged.has(kind)) return; logged.add(kind); options.log('ACP', line) }
      const translator = createAcpTranslator({ text: options.text })
      let sessionId = '', active: Turn | undefined, loading = true, imageOk = false
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
        logOnce('fatal', `session stopped: ${message.replace(CONTROL_CHARS, ' ').slice(0, 300)}`)
        // 进程死了不等于这一轮什么都没说:messages 模式把整条助理消息攒在 translator 里,
        // 直接 finish 会把一条已经说完的话连同进程一起丢掉(用户只看到一个错误码)。
        // 先把攒着的吐出来,再推错误事件。append 模式(工作台)本来就逐字发过了,恒空。
        // (本地已取消的回合除外 —— 那条路的规矩是半截话不发,见 dispatch 里的 settle 注释。)
        if (active) { if (!active.cancelled) for (const e of translator.endTurn()) active.queue.push(e); finish(active, { kind: 'error', message }) }
        // dispose 的理由就是真因:setup 阶段挂起的 initialize / session.* 会拿着它 reject,
        // 换成 acp_session_closed 会把"老版本没有 acp 子命令"这类唯一的线索盖掉。
        connection.dispose(broken)
      }
      const connection: AcpConnection = createAcpConnection(child.stdin!, child.stdout!, {
        rpcTimeoutMs,
        onNotification(method, params) {
          if (method !== 'session/update' || !object(params)) return
          // loading 期间的外来 sessionId 是意料之中的:resume 回退时 session/load 会把旧会话的历史
          // 重播一遍,那些 update 本来就该丢。记一行只会把每会话一次的日志额度花在噪音上,
          // 真正该看见的"跑起来之后还有外来 update"反而挤不进来。
          if (params.sessionId !== sessionId) { if (!loading) logOnce('update', `session/update dropped: foreign sessionId ${forLog(params.sessionId)}`); return }
          if (loading) return
          const turn = active
          if (!turn || turn.cancelled) return
          for (const event of translator.update(params.update)) turn.queue.push(event)
        },
        async onRequest(method, params, id) {
          if (method !== 'session/request_permission') throw Object.assign(new Error(`client capability not declared: ${method}`), { code: -32601 })
          const turn = active
          if (object(params) && params.sessionId !== sessionId) logOnce('permission', `session/request_permission cancelled: foreign sessionId ${forLog(params.sessionId)}`)
          if (!turn || turn.cancelled || closing || !object(params) || params.sessionId !== sessionId) return { outcome: { outcome: 'cancelled' } }
          // 撞 id:两张权限卡共用一条回复通道,主人对哪一张点的"允许"就再也说不清了。
          if (permissions.has(id)) { queueMicrotask(() => fatal('acp_duplicate_permission_request')); return { outcome: { outcome: 'cancelled' } } }
          if (permissions.size >= permissionLimit) { queueMicrotask(() => fatal('acp_request_limit')); return { outcome: { outcome: 'cancelled' } } }
          const description = acpPermissionDescription(params)
          if (description === null) {
            if (options.permissions === 'mode') { logOnce('permission-shape', 'session/request_permission cancelled: undisplayable request'); return { outcome: { outcome: 'cancelled' } } }
            queueMicrotask(() => fatal(`无法核实或完整显示本次 ${options.displayName} 权限请求，工作台已停止任务。`)); return { outcome: { outcome: 'cancelled' } }
          }
          if (options.permissions === 'mode') {
            const optionId = acpPermissionOption(params.options, context.permissionMode === 'dangerously')
            return optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } }
          }
          const toolCall = params.toolCall as Record<string, unknown>
          const tool = typeof toolCall.kind === 'string' && toolCall.kind ? toolCall.kind : 'tool'
          return new Promise<unknown>(resolve => {
            const controller = new AbortController()
            const key = id
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
      const withTail = (message: string): Error => {
        const tail = stderrTail.trim().slice(-300)
        return new Error(tail ? `${message}\n${tail}` : message)
      }
      const setupError = (error: unknown): Error => {
        // acp_auth_required stays a bare code — the login-hint copy upstream is keyed on this
        // exact string, and stderr for an auth failure is rarely more informative than the code.
        if (error instanceof AcpRequestError && (error.code === -32000 || isAuthFail('sdk-error', error.message))) return new Error('acp_auth_required')
        if (error instanceof AcpRequestError) return withTail(`acp_session_failed: ${error.message}`)
        // 进程在 setup 途中死掉(老版本没有 acp 子命令、spawn 失败)⇒ 挂起的 RPC 被 fatal 的 dispose
        // 掀掉。真因在 broken 里,stderr 尾巴才是主人能看懂的那一行,按 acp_session_failed 同样的规矩带上。
        if (broken && (error === broken || (error instanceof Error && error.message === 'acp_session_closed'))) return withTail(broken.message)
        return error instanceof Error ? error : new Error(String(error))
      }
      try {
        const initialized = await connection.request('initialize', { protocolVersion: 1, clientCapabilities: CLIENT_CAPABILITIES, clientInfo: CLIENT_INFO })
        if (!object(initialized) || initialized.protocolVersion !== 1) throw new Error('acp_protocol_version_unsupported')
        const loadSession = object(initialized.agentCapabilities) && initialized.agentCapabilities.loadSession === true
        imageOk = object(initialized.promptCapabilities) && initialized.promptCapabilities.image === true
        const mcpServers = options.mcpServers?.(context) ?? []
        const openNew = async () => {
          const created = await connection.request('session/new', { cwd: project.path, mcpServers })
          if (!object(created) || !sessionIdOk(created.sessionId)) throw new Error('acp_missing_session_id')
          sessionId = created.sessionId
          return created
        }
        let created: Record<string, unknown> | undefined
        if (context.resumeSessionId) {
          try {
            if (!loadSession) throw new Error('acp_resume_unsupported')
            sessionId = context.resumeSessionId
            const loaded = await connection.request('session/load', { sessionId, cwd: project.path, mcpServers })
            if (object(loaded) && loaded.sessionId !== undefined && loaded.sessionId !== sessionId) throw new Error('acp_resume_session_mismatch')
          } catch (error) {
            if (options.resume !== 'fallback') throw error
            logOnce('resume', `session/load ${forLog(context.resumeSessionId)} failed (${error instanceof Error ? error.message.replace(CONTROL_CHARS, ' ').slice(0, 120) : String(error)}); opening a new session`)
            sessionId = ''
            created = await openNew()
          }
        } else created = await openNew()
        // 只在新会话上钉模型:session/load 沿用会话原状。失败只记日志,模型选错不该让整段对话起不来 ——
        // 但只吞 AcpRequestError(agent 明确拒绝了这个选项):任何别的拒绝(尤其是进程死掉时
        // connection.dispose() 甩出的那个)都必须原样上抛,让外层 catch 走 setupError + close(),
        // 不然一个已经断线的 session 会被这里的 .catch 悄悄咽掉,spawn() 却当成功返回。
        const wanted = created ? options.model?.(context) : undefined
        if (wanted && wanted !== 'auto') {
          const option = Array.isArray(created!.configOptions) ? created!.configOptions.find((item: unknown) => object(item) && (item.id === 'model' || item.category === 'model')) : undefined
          const offered = object(option) && Array.isArray(option.options) && option.options.some((item: unknown) => object(item) && item.value === wanted)
          const configId = offered && typeof (option as Record<string, unknown>).id === 'string' ? (option as Record<string, unknown>).id as string : undefined
          if (configId) {
            await connection.request('session/set_config_option', { sessionId, configId, value: wanted }, rpcTimeoutMs).catch((error: unknown) => {
              if (!(error instanceof AcpRequestError)) throw error
              logOnce('model', `session/set_config_option ${forLog(wanted)} failed: ${error.message.slice(0, 120)}`)
            })
          } else if (offered) logOnce('model', `model ${forLog(wanted)} offered without a usable config id; using its default`)
          else logOnce('model', `model ${forLog(wanted)} not offered by ${options.displayName}; using its default`)
        }
      } catch (error) {
        const mapped = setupError(error)
        await close().catch(() => {})
        throw mapped
      }
      loading = false
      if (options.notice !== null) context.reportNotice?.(options.notice ?? acpNotice(options.displayName))

      return {
        dispatch(text, attachments) {
          if (attachments?.length && options.attachments !== 'prompt') throw new Error('acp_attachments_unsupported')
          if (closing || broken || exited) throw new Error('acp_session_closed')
          if (active) throw new Error('acp_turn_already_running')
          let prompt = text
          if (!instructionsInjected && context.appendInstructions) { prompt = `${context.appendInstructions}\n\n---\n\n${text}`; instructionsInjected = true }
          // acpPromptBlocks 校验/组块可能抛错(mime 不支持、agent 无图片能力、缺 data)——必须在
          // active = turn 之前抛,否则一个坏附件会把 dispatch 甩出去、却留下一个没人收尾的挂起回合。
          const blocks: AcpPromptBlock[] = options.attachments === 'prompt' ? acpPromptBlocks(prompt, attachments, imageOk) : [{ type: 'text', text: prompt }]
          const em = makeTurnEmitter()
          const turn: Turn = { queue: new AsyncQueue<AgentEvent>(), cancelled: false, startedAt: Date.now() }
          active = turn
          translator.beginTurn()
          turn.queue.push(em.init(sessionId))
          // 三处结束态(成功 / 非取消的中止原因 / prompt 请求本身报错)在写入结果事件之前先把
          // messages 模式攒着的助理文本吐出来 —— 取消路径(下面的 acp_turn_cancelled)故意绕过它:
          // 半截话不该在"用户主动打断"时还发出去。
          const settle = (event: AgentEvent) => { if (active !== turn) return; for (const e of translator.endTurn()) turn.queue.push(e); finish(turn, event) }
          void connection.request('session/prompt', { sessionId, prompt: blocks }, 0).then(
            result => {
              const reason = object(result) && typeof result.stopReason === 'string' ? result.stopReason : 'end_turn'
              // turn.cancelled(我们自己叫停的)优先于 reason 本身怎么说:agent 的回复完全可能在
              // session/cancel 生效前就已经在路上、报的是 end_turn —— 半截话不能因为这条race而漏发。
              if (turn.cancelled) finish(turn, { kind: 'error', message: 'acp_turn_cancelled' })
              else if (reason === 'end_turn' || reason === 'cancelled') settle(em.finish({ sessionId, numTurns: 1, durationMs: Date.now() - turn.startedAt }))
              else settle({ kind: 'error', message: `acp_stop_${reason}` })
            },
            (error: unknown) => { if (active === turn) settle(em.errorText(error instanceof Error ? error.message : String(error))) },
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
