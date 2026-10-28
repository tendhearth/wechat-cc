/**
 * 照剧本说话的假 Claude Agent SDK `query()` —— **只给测试与实验 harness 用**,生产代码不 import 它。
 *
 * 为什么要它(回复交付第 5 步,2026-10-03):Claude 对话侧是一个常驻的 SDK `query()`(流式输入,一轮一条 user
 * 消息),连 api.anthropic.com、用主人的订阅登录 —— 闸门不能全靠真模型跑。这里给生产的 `createClaudeAgentProvider`
 * 注入一个假的 `query`(`queryImpl`),每收到一条 user 消息就按剧本吐 SDK 消息,形状照 SDK 的类型声明与真机:
 *   - 每轮先 `system/init`,最后 `result{subtype:'success', result: 最后一条助理消息的文字}`;
 *   - 一次 API 响应 = 若干内容块(text / tool_use);有 tool_use 就接一条 `user{tool_result}`,然后是下一次响应;
 *   - 子 agent(Task)里的消息带 `parent_tool_use_id`。
 *
 * 四种外部条件:
 *   - `recorded`:**每个内容块单独一条** `assistant` 消息(同一个 message.id)—— Claude Code 流式输出的样子;
 *   - `bundled`:一次响应的所有块在**同一条** `assistant` 消息里(SDK 类型允许、回放 / 旧版本就是这样)——
 *     provider 以前在这种形状下先发 tool_call 再发文字,分段错位;
 *   - `drift`:wechat MCP 挂在别的名字下(Claude Code 插件 MCP 的 `mcp__plugin_<插件>_<server>__<tool>`),
 *     下游认不出这是 reply;
 *   - `tool_error`:wechat 的工具调用失败(MCP 起不来 / 内部 API 拒了),`tool_result.is_error`;模型看得到失败,
 *     接着演 `ifError`。
 *
 * 不起任何进程、不连网。
 */
import type { query as sdkQuery, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

export type ClaudeShape = 'recorded' | 'bundled' | 'drift' | 'tool_error'

export type ClaudeScriptStep =
  /** 一个 text 块。 */
  | { say: string }
  /** 一个 thinking 块(provider 不读)。 */
  | { think: string }
  /**
   * 一次工具调用(tool_use 块)。`server` 缺省 = 内置工具(Bash / Read …);给了就是 MCP(`mcp__<server>__<tool>`)。
   * `ifError`:调用失败(tool_error 条件)之后模型接着演的步骤。
   */
  | { tool: string; server?: string; args?: Record<string, unknown>; ifError?: ClaudeScriptStep[]; /** 这一次一定失败(比如工具已不在表里)。 */ fail?: true }
  /** 一个子 agent(Task):它自己的过程文字与工具调用都带 parent_tool_use_id。 */
  | { subagent: ClaudeScriptStep[] }
  /** 原样发一条 SDK 消息(回放录到的流)。 */
  | { raw: unknown }
  /** 停一会儿(长任务)。 */
  | { delayMs: number }

export interface ClaudeScriptedTurn {
  steps: ClaudeScriptStep[]
  /** 回放录到的一轮:原样吐这些 SDK 消息(含它自己的 result),不再合成 result。`steps` 被忽略。 */
  replay?: unknown[]
  /** 这一轮以 SDK 标注的 API 错误结束(助理消息带 `error`,result `is_error: true`)。 */
  apiError?: { sdkError: string; text: string; status?: number | null }
}

export interface ClaudeScriptedCall { server: string | undefined; tool: string; args: Record<string, unknown> }

export interface ScriptedClaudeOptions {
  turns: ClaudeScriptedTurn[] | ((input: string, n: number) => ClaudeScriptedTurn)
  shape?: ClaudeShape
  /** MCP 工具「真的被调用」的那一刻(没失败):模拟 MCP server 那一侧的副作用(reply 发进微信、voice 挂到本轮)。 */
  onToolCall?: (call: ClaudeScriptedCall) => void | Promise<void>
  sessionId?: string
}

export interface ScriptedClaude {
  query: typeof sdkQuery
  /** 每一轮收到的 user 消息文字。 */
  inputs: string[]
  /** 每条吐出去的 SDK 消息(录流用)。 */
  emitted: unknown[]
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** drift:Claude Code 插件 MCP 的命名(`[^_]+` 的 server 正则抓不到,provider 报成一个没有 server 的工具名)。 */
const DRIFT_SERVER = 'plugin_wechat-cc_wechat'

export function createScriptedClaude(opts: ScriptedClaudeOptions): ScriptedClaude {
  const shape = opts.shape ?? 'recorded'
  const inputs: string[] = []
  const emitted: unknown[] = []
  const sessionId = opts.sessionId ?? 'scripted-session'
  let n = 0
  let msgSeq = 0
  let toolSeq = 0
  const turnFor = (input: string): ClaudeScriptedTurn => {
    const k = n++
    if (typeof opts.turns === 'function') return opts.turns(input, k)
    const t = opts.turns[k]
    if (!t) throw new Error(`scripted claude: 第 ${k + 1} 轮没有剧本`)
    return t
  }

  const query = ((args: { prompt: AsyncIterable<SDKUserMessage> | string }) => {
    let closed = false
    async function* gen(): AsyncGenerator<SDKMessage> {
      const prompt = args.prompt
      if (typeof prompt === 'string') throw new Error('scripted claude: 只演流式输入(对话侧)')
      for await (const user of prompt) {
        if (closed) return
        const content = (user.message as { content: unknown }).content
        const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((b: { text?: string }) => b.text ?? '').join('') : ''
        inputs.push(text)
        const turn = turnFor(text)
        for (const m of playTurn(turn)) {
          if ('delayMs' in (m as object)) { await sleep((m as { delayMs: number }).delayMs); continue }
          if ('__call' in (m as object)) { await opts.onToolCall?.((m as { __call: ClaudeScriptedCall }).__call); continue }
          emitted.push(m)
          yield m as SDKMessage
        }
      }
    }

    /** 一轮 → SDK 消息序列(同步算好;delay 用占位对象)。 */
    function playTurn(turn: ClaudeScriptedTurn): unknown[] {
      const out: unknown[] = [{ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-scripted' }]
      let lastAssistantText = ''
      let numTurns = 0
      // 一次 API 响应:攒块,遇到「工具之后又要说话」就结束这次响应。
      const respond = (blocks: Array<Record<string, unknown>>, parent: string | null): void => {
        if (blocks.length === 0) return
        numTurns++
        const id = `msg_${++msgSeq}`
        const base = { type: 'assistant', session_id: sessionId, parent_tool_use_id: parent }
        if (shape === 'bundled') {
          out.push({ ...base, uuid: `${id}-u`, message: { id, role: 'assistant', model: 'claude-scripted', content: blocks } })
        } else {
          blocks.forEach((b, i) => out.push({ ...base, uuid: `${id}-u${i}`, message: { id, role: 'assistant', model: 'claude-scripted', content: [b] } }))
        }
        if (parent === null) {
          const last = shape === 'bundled' ? blocks : [blocks[blocks.length - 1]!]
          lastAssistantText = last.filter(b => b.type === 'text').map(b => String(b.text ?? '')).join('')
        }
      }
      const play = (steps: ClaudeScriptStep[], parent: string | null): void => {
        let blocks: Array<Record<string, unknown>> = []
        let results: Array<{ id: string; isError: boolean }> = []
        let calls: ClaudeScriptedCall[] = []
        let after: ClaudeScriptStep[] = []
        const flush = () => {
          respond(blocks, parent)
          // 工具真的被调用(MCP server 那一侧的副作用)发生在 tool_use 之后、tool_result 之前。
          for (const c of calls) out.push({ __call: c })
          calls = []
          if (results.length) out.push({ type: 'user', session_id: sessionId, parent_tool_use_id: parent, message: { role: 'user', content: results.map(r => ({ type: 'tool_result', tool_use_id: r.id, content: r.isError ? 'MCP error -32000: Connection closed' : '{"ok":true}', is_error: r.isError })) } })
          blocks = []; results = []
          const pending = after; after = []
          if (pending.length) play(pending, parent)
        }
        for (const s of steps) {
          if (('say' in s || 'think' in s) && results.length) flush()
          if ('say' in s) blocks.push({ type: 'text', text: s.say })
          else if ('think' in s) blocks.push({ type: 'thinking', thinking: s.think, signature: '' })
          else if ('delayMs' in s) { flush(); out.push({ delayMs: s.delayMs }) }
          else if ('raw' in s) { flush(); out.push(s.raw) }
          else if ('subagent' in s) {
            const tid = `toolu_${++toolSeq}`
            blocks.push({ type: 'tool_use', id: tid, name: 'Task', input: { description: 'sub' } })
            respond(blocks, parent); blocks = []
            for (const c of calls) out.push({ __call: c })
            calls = []
            play(s.subagent, tid)
            out.push({ type: 'user', session_id: sessionId, parent_tool_use_id: parent, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content: 'done', is_error: false }] } })
          } else {
            const tid = `toolu_${++toolSeq}`
            const server = s.server === undefined ? undefined : shape === 'drift' && s.server === 'wechat' ? DRIFT_SERVER : s.server
            const name = server === undefined ? s.tool : `mcp__${server}__${s.tool}`
            blocks.push({ type: 'tool_use', id: tid, name, input: s.args ?? {} })
            const failed = s.fail === true || (shape === 'tool_error' && s.server === 'wechat')
            results.push({ id: tid, isError: failed })
            if (failed) { if (s.ifError) after.push(...s.ifError) }
            else calls.push({ server: s.server, tool: s.tool, args: s.args ?? {} })
          }
        }
        flush()
      }
      if (turn.replay) { out.push(...turn.replay); return out }
      if (turn.apiError) {
        out.push({ type: 'assistant', session_id: sessionId, parent_tool_use_id: null, uuid: `err-${++msgSeq}`, error: turn.apiError.sdkError, message: { id: `err_${msgSeq}`, role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: turn.apiError.text }] } })
        out.push({ type: 'result', subtype: 'success', session_id: sessionId, num_turns: 1, duration_ms: 1, is_error: true, api_error_status: turn.apiError.status ?? null, result: turn.apiError.text })
        return out
      }
      play(turn.steps, null)
      out.push({ type: 'result', subtype: 'success', session_id: sessionId, num_turns: numTurns, duration_ms: 1, is_error: false, result: lastAssistantText })
      return out
    }

    const it = gen()
    return Object.assign(it, {
      interrupt: async () => {},
      close: () => { closed = true },
    })
  }) as unknown as typeof sdkQuery

  return { query, inputs, emitted }
}
