/**
 * 照剧本说话的假 `codex app-server`(stdio JSON-RPC)—— **只给测试与实验 harness 用**,生产代码不 import 它。
 *
 * 为什么要它:Codex 对话侧(B1 2026-10-25 起和工作台同一个协议)连的是 api.openai.com、用主人的 ChatGPT 登录与额度
 * —— 闸门不能全靠真模型跑。这里给生产的 `createCodexChatProvider` 注入一个假的子进程(`spawnProcess`),它按
 * app-server v2 的形状应答 initialize / config/read / thread/start|resume / turn/start|steer|interrupt,每一轮按剧本发通知:
 *   - `turn/started` → 一条 `userMessage` 条目(真 codex 也发,对话侧不能把它当工具)→ 剧本 → `turn/completed`;
 *   - 助理消息:`item/started{agentMessage}` → 逐字 `item/agentMessage/delta` → `item/completed{agentMessage,text}`;
 *   - 思考 `reasoning`;shell `commandExecution`(inProgress → completed);MCP `mcpToolCall`(inProgress → completed|failed)。
 *
 * 外部条件:
 *   - `mcpItem: 'unknown_item'`:主人的 codex CLI 比我们新,MCP 调用换了一个不认识的条目类型(字段也换了名);
 *   - 没开免审(daemon 跑在 strict):codex 把每一次 MCP 调用都拒掉(`status: failed`,`error.message` 是 0.153 真机
 *     录到的「MCP tool call requires approval, but approval policy is never」);模型看得到失败,可以接着演 `ifRejected`。
 *   - `raw`:回放 `codex exec` 录到的 ThreadEvent(2026-10-03 沙盒真跑),逐条翻成 app-server 的条目通知。
 *
 * 不起任何进程、不连网。
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { CodexAppServerSpawn } from '../../adapters/executors/codex/codex-app-server-process'

/** codex 0.153 在 approval never + 没有免审时拒 MCP 调用的原话(2026-10-03 沙盒真跑录到)。 */
export const MCP_REJECTED = 'MCP tool call requires approval, but approval policy is never'

export type CodexScriptStep =
  /** 一条完整的助理消息。 */
  | { say: string }
  /** 思考(reasoning 条目,对话侧丢掉)。 */
  | { think: string }
  /** MCP 工具调用。`ifRejected`:被拒(strict)之后模型接着演的步骤。 */
  | { mcp: { server: string; tool: string; args?: Record<string, unknown> }; ifRejected?: CodexScriptStep[] }
  /** shell 命令(commandExecution)。 */
  | { shell: string; output?: string }
  /** 回放一条录到的 `codex exec` ThreadEvent(只认 item.started / item.completed)。 */
  | { raw: unknown }
  /** 原样发一条 app-server 通知(params 里的 threadId / turnId 缺省自动补上)。 */
  | { notify: { method: string; params?: Record<string, unknown> } }
  /** 发一条服务端请求(审批 / 提问 / MCP 表单),等客户端应答,应答记进 `responses`。 */
  | { request: { method: string; params?: Record<string, unknown> } }
  /** codex 自己在重连(`error{willRetry:true}`)。 */
  | { reconnect: string }
  /** 停一会儿(长任务);中断会提前叫醒。 */
  | { delayMs: number }
  /** 子进程就此退出(崩溃),stderr 写这一句。 */
  | { crash: string }

export interface CodexScriptedTurn {
  steps: CodexScriptStep[]
  /** 这一轮失败:`error{willRetry:false}` + `turn/completed{failed}`,带这条消息(和可选的 codexErrorInfo)。 */
  fail?: string
  failInfo?: unknown
  /** 不结束(直到中断)。 */
  hang?: boolean
}

export interface CodexScriptedCall { server: string; tool: string; args: Record<string, unknown> }

export interface ScriptedCodexOptions {
  /** 第 n 轮(所有子进程一起从 0 数)演哪一轮;函数形式拿得到这一轮的输入原文。 */
  turns: CodexScriptedTurn[] | ((input: string, n: number) => CodexScriptedTurn | Promise<CodexScriptedTurn>)
  /** MCP 调用用哪种条目:缺省 `mcpToolCall`;`unknown_item` = CLI 比我们新(见文件头)。 */
  mcpItem?: 'mcp_tool_call' | 'unknown_item'
  /** MCP 调用会不会被 codex 拒掉。缺省:看线程配置里有没有免审(`dangerously_bypass_approvals_and_sandbox`)。 */
  rejectMcp?: boolean
  /** MCP 工具「真的被调用」的那一刻(没被拒):模拟 MCP server 那一侧的副作用。 */
  onToolCall?: (call: CodexScriptedCall) => void | Promise<void>
  threadId?: string
  /** thread/resume 失败(线程不在了)。 */
  resumeFails?: boolean
  /** initialize 报的 userAgent。 */
  userAgent?: string
  /** 一次性评估线程(只读 + 线程配置 network_access=false)的回答;它们不消耗 `turns`。缺省 'ok'。 */
  cheapAnswer?: (prompt: string) => string | Promise<string>
  /** 改写 / 吞掉 / 追加 app-server 发出去的每一条(测试演「codex 报了别的策略」「一直重连」之类)。返回 null ⇒ 不发。 */
  rewrite?: (message: ScriptedRpc) => ScriptedRpc | ScriptedRpc[] | null
  /** 一起来就退出(stderr 写这一句,exit 1):登录失效、配置坏了时 app-server 的样子。 */
  startupCrash?: string
  /** 每次 thread/start / thread/resume(含一次性评估的)。 */
  onThreadStart?: (method: string, params: Record<string, unknown>, cheap: boolean) => void
}

export interface ScriptedCodex {
  spawn: CodexAppServerSpawn
  /** 每一轮(不含一次性评估)turn/start 的输入文字。 */
  inputs: string[]
  /** 一次性评估收到的提示。 */
  cheapPrompts: string[]
  /** 每次 thread/start / thread/resume 的方法与参数(含一次性评估的)。 */
  threadStarts: Array<{ method: string; params: Record<string, unknown> }>
  /** 每次起子进程的命令行。 */
  spawned: Array<{ command: string; args: readonly string[]; cwd: string }>
  /** turn/steer 收到的输入文字。 */
  steers: string[]
  /** 剧本里 `request` 步骤得到的应答。 */
  responses: Array<{ method: string; result?: unknown; error?: unknown }>
  /** 当前活着的子进程数。 */
  alive(): number
}

export type ScriptedRpc = { id?: string | number; method?: string; params?: any; result?: any; error?: any }
type Rpc = ScriptedRpc

const SANDBOX: Record<string, string> = { 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' }
const camelStatus = (s: unknown) => s === 'in_progress' ? 'inProgress' : s
const inputText = (input: unknown): string => Array.isArray(input) ? input.filter(i => i?.type === 'text').map(i => String(i.text)).join('\n') : ''

/** `codex exec` 的 ThreadItem → app-server v2 的条目(回放录到的流用)。 */
export function execItemToAppServer(item: Record<string, any>): Record<string, unknown> {
  const base = { id: item.id }
  switch (item.type) {
    case 'agent_message': return { ...base, type: 'agentMessage', text: item.text }
    case 'reasoning': return { ...base, type: 'reasoning', summary: [item.text ?? ''], content: [] }
    case 'mcp_tool_call': return { ...base, type: 'mcpToolCall', server: item.server, tool: item.tool, arguments: item.arguments ?? {}, status: camelStatus(item.status), result: item.result ?? null, error: item.error ?? null }
    case 'command_execution': return { ...base, type: 'commandExecution', command: item.command, aggregatedOutput: item.aggregated_output ?? null, exitCode: item.exit_code ?? null, status: camelStatus(item.status), cwd: '/', commandActions: [] }
    case 'file_change': return { ...base, type: 'fileChange', changes: item.changes ?? [], status: camelStatus(item.status) }
    case 'web_search': return { ...base, type: 'webSearch', query: item.query ?? '' }
    case 'todo_list': return { ...base, type: 'todoList', items: item.items ?? [] }
    case 'error': return { ...base, type: 'error', message: item.message }
    default: return { ...item }
  }
}

class FakeChild extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough()
  pid: number | undefined = undefined
  exitCode: number | null = null; signalCode: NodeJS.Signals | null = null
  kill(signal: NodeJS.Signals = 'SIGTERM') { queueMicrotask(() => this.exit(null, signal)); return true }
  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    if (this.exitCode !== null || this.signalCode !== null) return
    this.exitCode = code; this.signalCode = signal
    this.stdout.end(); this.stderr.end(); this.emit('exit', code, signal); this.emit('close', code, signal)
  }
}

export function createScriptedCodex(opts: ScriptedCodexOptions): ScriptedCodex {
  const inputs: string[] = [], cheapPrompts: string[] = [], steers: string[] = []
  const threadStarts: ScriptedCodex['threadStarts'] = [], spawned: ScriptedCodex['spawned'] = [], responses: ScriptedCodex['responses'] = []
  let n = 0, threadSeq = 0, cheapSeq = 0, live = 0
  const turnFor = (input: string): CodexScriptedTurn | Promise<CodexScriptedTurn> => {
    const k = n++
    if (typeof opts.turns === 'function') return opts.turns(input, k)
    const t = opts.turns[k]
    if (!t) throw new Error(`scripted codex: 第 ${k + 1} 轮没有剧本`)
    return t
  }

  const spawn: CodexAppServerSpawn = (command, args, options) => {
    spawned.push({ command, args, cwd: options.cwd })
    const child = new FakeChild(); live++
    child.once('exit', () => { live-- })
    let threadId = '', cheap = false, rejectMcp = opts.rejectMcp ?? true, turnSeq = 0, item = 0, reqSeq = 0
    let current: { id: string; stop: () => void; stopped: boolean } | undefined
    const pending = new Map<string | number, (m: Rpc) => void>()
    // 真管道是异步的:写出去的每一行都排到微任务里(先写的先到),免得同步重入把顺序演得比真机还「整齐」。
    const send = (m: Rpc) => queueMicrotask(() => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const out = opts.rewrite ? opts.rewrite(m) : m
      for (const line of out === null ? [] : Array.isArray(out) ? out : [out]) child.stdout.write(JSON.stringify(line) + '\n')
    })
    const notify = (method: string, params: Record<string, unknown>) => send({ method, params })
    const nextId = (p: string) => `${p}_${++item}`

    const play = async (turnId: string, turn: CodexScriptedTurn, ctl: { stopped: boolean; wake?: () => void }) => {
      const at = { threadId, turnId }
      const itemNote = (method: 'item/started' | 'item/completed', value: Record<string, unknown>) => notify(method, { ...at, item: value })
      const sleep = (ms: number) => new Promise<void>(resolve => { const t = setTimeout(resolve, ms); ctl.wake = () => { clearTimeout(t); resolve() } })
      const steps = async (list: CodexScriptStep[]): Promise<boolean> => {
        for (const s of list) {
          if (ctl.stopped) return false
          await Promise.resolve()
          if ('say' in s) {
            const id = nextId('msg')
            itemNote('item/started', { id, type: 'agentMessage', text: '' })
            if (s.say) notify('item/agentMessage/delta', { ...at, itemId: id, delta: s.say })
            itemNote('item/completed', { id, type: 'agentMessage', text: s.say })
          } else if ('think' in s) {
            const id = nextId('rs')
            itemNote('item/started', { id, type: 'reasoning', summary: [], content: [] })
            itemNote('item/completed', { id, type: 'reasoning', summary: [s.think], content: [] })
          } else if ('delayMs' in s) await sleep(s.delayMs)
          else if ('raw' in s) {
            const ev = s.raw as { type?: string; item?: Record<string, any> }
            if ((ev.type === 'item.started' || ev.type === 'item.completed') && ev.item) itemNote(ev.type === 'item.started' ? 'item/started' : 'item/completed', execItemToAppServer(ev.item))
          } else if ('notify' in s) notify(s.notify.method, { ...at, ...(s.notify.params ?? {}) })
          else if ('reconnect' in s) notify('error', { ...at, willRetry: true, error: { message: s.reconnect, codexErrorInfo: null } })
          else if ('crash' in s) { child.stderr.write(s.crash + '\n'); setTimeout(() => child.exit(1), 5); return false }
          else if ('request' in s) {
            const id = `srv-${++reqSeq}`
            const answered = new Promise<Rpc>(resolve => pending.set(id, resolve))
            send({ id, method: s.request.method, params: { ...at, ...(s.request.params ?? {}) } })
            const m = await answered
            responses.push({ method: s.request.method, ...(m.result !== undefined ? { result: m.result } : {}), ...(m.error !== undefined ? { error: m.error } : {}) })
          } else if ('shell' in s) {
            const id = nextId('cmd')
            itemNote('item/started', { id, type: 'commandExecution', command: s.shell, cwd: '/', status: 'inProgress', commandActions: [], aggregatedOutput: null, exitCode: null })
            itemNote('item/completed', { id, type: 'commandExecution', command: s.shell, cwd: '/', status: 'completed', commandActions: [], aggregatedOutput: s.output ?? '', exitCode: 0 })
          } else {
            const id = nextId('mcp')
            const { server, tool } = s.mcp
            const callArgs = s.mcp.args ?? {}
            const shape = (status: 'inProgress' | 'completed' | 'failed', extra: Record<string, unknown> = {}) => (opts.mcpItem === 'unknown_item'
              // CLI 比我们新:同一次 MCP 调用,换了一个不认识的条目类型(字段也换了名)。
              ? { id, type: 'mcpCall', invocation: { server, tool, arguments: callArgs }, status, ...extra }
              : { id, type: 'mcpToolCall', server, tool, arguments: callArgs, status, ...extra })
            itemNote('item/started', shape('inProgress'))
            if (rejectMcp) {
              itemNote('item/completed', shape('failed', { error: { message: MCP_REJECTED } }))
              if (s.ifRejected && !(await steps(s.ifRejected))) return false
            } else {
              await opts.onToolCall?.({ server, tool, args: callArgs })
              itemNote('item/completed', shape('completed', { result: { content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: null } }))
            }
          }
        }
        return true
      }
      notify('turn/started', { threadId, turn: { id: turnId, items: [], status: 'inProgress', error: null } })
      const uid = nextId('user')
      itemNote('item/started', { id: uid, type: 'userMessage', content: [] })
      itemNote('item/completed', { id: uid, type: 'userMessage', content: [] })
      const finished = await steps(turn.steps)
      if (!finished || ctl.stopped) return
      if (turn.hang) { await new Promise<void>(resolve => { ctl.wake = resolve }); return }
      if (turn.fail !== undefined) {
        const error = { message: turn.fail, codexErrorInfo: turn.failInfo ?? null }
        notify('error', { ...at, willRetry: false, error })
        notify('turn/completed', { threadId, turn: { id: turnId, items: [], status: 'failed', error, durationMs: 3 } })
      } else {
        notify('thread/tokenUsage/updated', { ...at, tokenUsage: { last: { totalTokens: 12, inputTokens: 10, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 }, total: null } })
        notify('turn/completed', { threadId, turn: { id: turnId, items: [], status: 'completed', error: null, durationMs: 3 } })
      }
    }

    const reply = (m: Rpc, result: Record<string, unknown>) => send({ id: m.id, result })
    let crashed = false
    const onMessage = async (m: Rpc) => {
      if (opts.startupCrash !== undefined) { if (!crashed) { crashed = true; child.stderr.write(opts.startupCrash + '\n'); setTimeout(() => child.exit(1), 5) } return }
      if (m.method === undefined) { if (m.id !== undefined) { const r = pending.get(m.id); pending.delete(m.id); r?.(m) } return }
      const p = m.params ?? {}
      switch (m.method) {
        case 'initialize': return reply(m, { userAgent: opts.userAgent ?? 'tendhearth_cc/0.153.4 (scripted)' })
        case 'initialized': return
        case 'config/read': return reply(m, { config: {} })
        case 'thread/start': case 'thread/resume': {
          cheap = p.sandbox === 'read-only' && p.config?.sandbox_workspace_write?.network_access === false
          threadStarts.push({ method: m.method, params: p })
          opts.onThreadStart?.(m.method, p, cheap)
          if (m.method === 'thread/resume' && opts.resumeFails) return send({ id: m.id, error: { code: -32600, message: `no rollout found for thread id ${p.threadId}` } })
          rejectMcp = opts.rejectMcp ?? p.config?.dangerously_bypass_approvals_and_sandbox !== true
          if (m.method === 'thread/resume') threadId = String(p.threadId)
          else if (cheap) threadId = `cheap-${++cheapSeq}`
          else { const k = threadSeq++; threadId = `${opts.threadId ?? 'scripted-thread'}${k ? `-${k + 1}` : ''}` }
          return reply(m, { thread: { id: threadId }, cwd: p.cwd, model: p.model ?? 'scripted-model', approvalPolicy: p.approvalPolicy, sandbox: { type: SANDBOX[p.sandbox] ?? p.sandbox } })
        }
        case 'turn/start': {
          if (current && !current.stopped) return send({ id: m.id, error: { code: -32600, message: 'turn already running' } })
          const turnId = `turn-${++turnSeq}`
          const text = inputText(p.input)
          reply(m, { turn: { id: turnId, items: [], status: 'inProgress', error: null } })
          const ctl: { stopped: boolean; wake?: () => void } = { stopped: false }
          current = { id: turnId, stopped: false, stop: () => { ctl.stopped = true; ctl.wake?.() } }
          const mine = current
          await Promise.resolve()
          if (cheap) {
            cheapPrompts.push(text)
            const answer = await (opts.cheapAnswer?.(text) ?? 'ok')
            notify('turn/started', { threadId, turn: { id: turnId, items: [], status: 'inProgress', error: null } })
            notify('item/completed', { threadId, turnId, item: { id: nextId('msg'), type: 'agentMessage', text: answer } })
            notify('turn/completed', { threadId, turn: { id: turnId, items: [], status: 'completed', error: null, durationMs: 1 } })
          } else {
            inputs.push(text)
            let turn: CodexScriptedTurn
            try { turn = await turnFor(text) } catch (err) { turn = { steps: [], fail: err instanceof Error ? err.message : String(err) } }
            await play(turnId, turn, ctl)
          }
          if (current === mine) mine.stopped = true
          return
        }
        case 'turn/steer': {
          if (!current || current.stopped || p.expectedTurnId !== current.id) return send({ id: m.id, error: { code: -32600, message: 'no active turn' } })
          steers.push(inputText(p.input))
          return reply(m, { turnId: current.id })
        }
        case 'turn/interrupt': {
          const c = current
          if (c && c.id === p.turnId && !c.stopped) {
            c.stopped = true; c.stop()
            notify('turn/completed', { threadId, turn: { id: c.id, items: [], status: 'interrupted', error: null, durationMs: 2 } })
          }
          return reply(m, {})
        }
        default:
          return send({ id: m.id, error: { code: -32601, message: `scripted codex: ${m.method} not implemented` } })
      }
    }

    let lines = ''
    child.stdin.on('data', chunk => {
      lines += String(chunk)
      while (lines.includes('\n')) {
        const end = lines.indexOf('\n'), line = lines.slice(0, end); lines = lines.slice(end + 1)
        if (line.trim()) { const m = JSON.parse(line) as Rpc; queueMicrotask(() => { void onMessage(m) }) }
      }
    })
    return child as unknown as ChildProcessWithoutNullStreams
  }
  return { spawn, inputs, cheapPrompts, threadStarts, spawned, steers, responses, alive: () => live }
}
