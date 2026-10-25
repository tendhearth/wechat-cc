/**
 * 照剧本说话的假 ACP agent —— **只给测试与实验 harness 用**,生产代码不 import 它。
 *
 * 为什么要它(回复交付第 3 步,2026-10-03):Cursor 的真 API 没法沙盒化(cursor-agent 连 Cursor 的服务,
 * 用主人的登录与额度),所以「legacy vs daemon」的闸门不能靠真模型跑。这里起一个假的 `cursor-agent acp`
 * 子进程:stdin / stdout 上是真的换行分隔 JSON-RPC,**生产的** ACP 客户端(acp-agent-provider.ts)照常
 * initialize → session/new → session/prompt,收到的 `session/update` 形状照 2026-09-17 真机录到的报文
 * (src/core/acp/fixtures/cursor-acp-2026-09-17.jsonl):
 *   - 助理文字是 token 级的 `agent_message_chunk`(两三个字一块,没有 messageId);
 *   - 思考是 `agent_thought_chunk`(翻译器丢掉);
 *   - MCP 调用先来一条 `tool_call`(kind other、title「MCP: tool」、**没有** rawInput),身份
 *     (`rawInput.providerIdentifier / toolName`)在随后的 `tool_call_update` 里,再 in_progress →
 *     `session/request_permission` → completed;
 *   - 原生工具(edit / search / execute)是 kind + title + locations / rawInput。
 * 也能原样回放录到的 update(`{ raw }`)。
 *
 * 不碰任何真进程:`pid` 是 undefined,provider 的 close() 走 `child.kill()`,不会给真的进程组发信号。
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

export type ScriptStep =
  /** 助理文字:切成 token 级的 agent_message_chunk。 */
  | { say: string }
  /** 思考(agent_thought_chunk)。 */
  | { think: string }
  /**
   * MCP 工具调用。`identity`:身份放在哪 ——
   *   'update'(缺省,2026-09-17 真机):tool_call 不带身份,紧跟的 tool_call_update 带 rawInput.providerIdentifier / toolName;
   *   'none':CLI 换了 envelope,哪儿都不带身份(下游只看得到「调用工具」)。
   * `ifRejected`:权限卡被拒(strict)时模型接着演的步骤(它看得到调用失败了)。
   */
  | { mcp: { server: string; tool: string; args?: Record<string, unknown> }; identity?: 'update' | 'none'; ifRejected?: ScriptStep[] }
  /** 原生工具(读 / 改文件、检索、跑命令)。 */
  | { native: 'read' | 'edit' | 'search' | 'execute'; title: string; path?: string; command?: string }
  /** 原样发一条录到的 `session/update` 的 update。 */
  | { raw: unknown }
  /**
   * cursor-agent 一轮出错时的写法(ACP 服务端 processPrompt 的 catch):`\n\n` + 报错,**一整块**
   * agent_message_chunk,之后这一轮什么都不再发(剧本里把它放最后一步;stopReason 照常 end_turn)。
   */
  | { cliError: string }
  /** 停一会儿(长任务)。 */
  | { delayMs: number }

export interface ScriptedTurn { steps: ScriptStep[]; stopReason?: string }

export interface ScriptedToolCall { server: string; tool: string; args: Record<string, unknown> }

export interface ScriptedAgentOptions {
  /** 第 n 次 session/prompt(从 0 数)演哪一轮;函数形式拿得到这一轮的提示原文。 */
  turns: ScriptedTurn[] | ((prompt: string, n: number) => ScriptedTurn)
  initializeResult?: Record<string, unknown>
  /** session/new 的应答(缺省给一个 sessionId);录到的 configOptions / models 可以原样放进来。 */
  newResult?: Record<string, unknown>
  /**
   * MCP 工具「真的被调用」的那一刻(权限放行之后):模拟 MCP server 那一侧的副作用 —— 比如 legacy 的
   * reply 路由把话发进微信、daemon 的 /v1/turn/attach 把语音挂到本轮。被拒的调用不会走到这里。
   */
  onToolCall?: (call: ScriptedToolCall) => void | Promise<void>
  /** 每块几个字(缺省 2;真机多是 1–4 个字一块)。 */
  chunkSize?: number
}

type Rpc = { jsonrpc?: string; id?: string | number; method?: string; params?: any; result?: any; error?: any }

const textOfPrompt = (params: any): string =>
  Array.isArray(params?.prompt) ? params.prompt.map((b: any) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('') : ''

/** 把一段话切成真机那样的小块(按码点,不切坏 emoji)。 */
export function chunkText(text: string, size = 2): string[] {
  const chars = [...text]
  const out: string[] = []
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''))
  return out
}

export interface ScriptedAgentHandle {
  /** 交给 provider 的 `spawn` 选项。 */
  spawn: typeof import('node:child_process').spawn
  /** 每一次 spawn 起的假进程(会话复用时只有一个)。 */
  readonly children: Array<{ sent: Rpc[]; prompts: string[] }>
}

/**
 * 造一个假 `cursor-agent acp`。每次 spawn 一个假进程,但所有进程共用同一份剧本计数(n 跨进程递增),
 * 这样「会话被回收后重开」也接得上下一轮。
 */
export function createScriptedAcpAgent(options: ScriptedAgentOptions): ScriptedAgentHandle {
  const children: Array<{ sent: Rpc[]; prompts: string[] }> = []
  let promptCount = 0
  const chunkSize = options.chunkSize ?? 2
  const turnFor = (prompt: string): ScriptedTurn => {
    const n = promptCount++
    if (typeof options.turns === 'function') return options.turns(prompt, n)
    const t = options.turns[n]
    if (!t) throw new Error(`scripted-agent: no turn #${n}`)
    return t
  }

  const spawn = ((..._args: unknown[]) => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number | undefined; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough
      exitCode: number | null; kill(signal?: string): boolean
    }
    const record = { sent: [] as Rpc[], prompts: [] as string[] }
    children.push(record)
    child.pid = undefined // 不给真进程组发信号:provider 的 close() 退回 child.kill()
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
    child.exitCode = null
    let exited = false
    const exit = (signal: string | null) => {
      if (exited) return
      exited = true
      child.stdout.end()
      queueMicrotask(() => child.emit('exit', null, signal))
    }
    child.kill = (signal?: string) => { exit(signal ?? 'SIGTERM'); return true }

    const send = (message: Rpc) => { if (!exited) child.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n') }
    let sessionId = typeof options.newResult?.sessionId === 'string' ? options.newResult.sessionId as string : 'scripted-session-1'
    const update = (u: unknown) => send({ method: 'session/update', params: { sessionId, update: u } })
    let nextId = 10_000
    const pending = new Map<string | number, (result: any) => void>()
    const ask = (method: string, params: unknown): Promise<any> => new Promise(resolve => {
      const id = `agent-${nextId++}`
      pending.set(id, resolve)
      send({ id, method, params })
    })
    const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
    let callN = 0

    const permitted = async (toolCall: Record<string, unknown>): Promise<boolean> => {
      const answer = await ask('session/request_permission', {
        sessionId, toolCall,
        options: [
          { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
          { optionId: 'allow-always', name: 'Always', kind: 'allow_always' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      })
      return answer?.outcome?.outcome === 'selected' && String(answer.outcome.optionId).startsWith('allow')
    }

    const play = async (turn: ScriptedTurn): Promise<string> => {
      const queue = [...turn.steps]
      while (queue.length > 0) {
        const step = queue.shift()!
        if (exited) return 'cancelled'
        if ('say' in step) for (const c of chunkText(step.say, chunkSize)) update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: c } })
        else if ('think' in step) update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: step.think } })
        else if ('raw' in step) update(step.raw)
        else if ('cliError' in step) update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `\n\n${step.cliError}` } })
        else if ('delayMs' in step) await sleep(step.delayMs)
        else if ('mcp' in step) {
          // 真机的 toolCallId 里嵌着字面换行(acp/events.ts 头注释)—— 照抄。
          const id = `tool_${++callN}\nmcp`
          const { server, tool } = step.mcp
          const args = step.mcp.args ?? {}
          update({ sessionUpdate: 'tool_call', toolCallId: id, title: 'MCP: tool', kind: 'other', status: 'pending', rawInput: {} })
          const identity = (step.identity ?? 'update') === 'update'
          update({ sessionUpdate: 'tool_call_update', toolCallId: id, title: `${server}: ${tool}`, ...(identity ? { rawInput: { providerIdentifier: server, toolName: tool, args } } : {}) })
          update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'in_progress' })
          const ok = await permitted({ toolCallId: id, title: `${server}: ${tool}`, kind: 'other', status: 'pending' })
          if (ok) await options.onToolCall?.({ server, tool, args })
          update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: ok ? 'completed' : 'failed', rawOutput: { success: ok } })
          if (!ok && step.ifRejected) queue.unshift(...step.ifRejected)
        } else {
          const id = `tool_${++callN}\n${step.native}`
          const locations = step.path ? [{ path: step.path }] : []
          update({ sessionUpdate: 'tool_call', toolCallId: id, title: step.title, kind: step.native, status: 'pending', locations, ...(step.command ? { rawInput: { command: step.command } } : {}) })
          update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'in_progress' })
          const ok = step.native === 'execute' ? await permitted({ toolCallId: id, title: step.title, kind: 'execute', status: 'pending', rawInput: { command: step.command ?? step.title } }) : true
          update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: ok ? 'completed' : 'failed', rawOutput: { success: ok } })
        }
      }
      return turn.stopReason ?? 'end_turn'
    }

    let cancelled = false
    let buffer = ''
    child.stdin.on('data', chunk => {
      buffer += String(chunk)
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n')
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        if (!line.trim()) continue
        const msg = JSON.parse(line) as Rpc
        record.sent.push(msg)
        if (msg.method === undefined && msg.id !== undefined) { pending.get(msg.id)?.(msg.result); pending.delete(msg.id); continue }
        const reply = (result: unknown) => setTimeout(() => send({ id: msg.id, result }), 0)
        if (msg.method === 'initialize') reply(options.initializeResult ?? { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } })
        else if (msg.method === 'session/new') reply({ sessionId, ...(options.newResult ?? {}) })
        else if (msg.method === 'session/load') { sessionId = String(msg.params?.sessionId ?? sessionId); reply({}) }
        else if (msg.method === 'session/set_config_option') reply({ configOptions: [] })
        else if (msg.method === 'session/cancel') { cancelled = true; for (const [id, resolve] of pending) { pending.delete(id); resolve({ outcome: { outcome: 'cancelled' } }) } }
        else if (msg.method === 'session/prompt') {
          const prompt = textOfPrompt(msg.params)
          record.prompts.push(prompt)
          cancelled = false
          const turn = turnFor(prompt)
          void play(turn).then(stop => setTimeout(() => send({ id: msg.id, result: { stopReason: cancelled ? 'cancelled' : stop } }), 0))
        }
      }
    })
    return child
  }) as unknown as typeof import('node:child_process').spawn

  return { spawn, children }
}
