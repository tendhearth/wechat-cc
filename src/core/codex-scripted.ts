/**
 * 照剧本说话的假 Codex(`codex exec --experimental-json` 的事件流)—— **只给测试与实验 harness 用**,生产代码不 import 它。
 *
 * 为什么要它(回复交付第 4 步,2026-10-03):Codex 对话侧每一轮是一次 `codex exec`(经 `@openai/codex-sdk` 的
 * `runStreamed`),连的是 api.openai.com、用主人的 ChatGPT 登录与额度 —— 闸门不能全靠真模型跑。这里给生产的
 * `createCodexAgentProvider` 注入一个假的 `Codex`(`codexFactory`),每一轮按剧本吐 ThreadEvent,形状照 SDK 0.144
 * 的类型声明与真机(2026-10-03 沙盒真跑录到的流,见 docs/reference/reply-once-experiment.md「第 4 步」):
 *   - 第一轮先 `thread.started`(之后的轮是同一个 thread,不再发),每轮 `turn.started` … `turn.completed{usage}`;
 *   - 助理消息是整条的 `item.completed{agent_message}`(codex 没有 token 级增量);思考是 `reasoning`;
 *   - MCP 调用 `item.started{mcp_tool_call, in_progress}` → `item.completed{completed|failed}`;
 *   - shell 是 `command_execution`(started → completed,带 aggregated_output / exit_code)。
 *
 * 三种外部条件(和 Cursor 臂对应):
 *   - 身份照真机:`mcp_tool_call` 带 `server` / `tool`;
 *   - `mcpItem: 'unknown_item'`:用户的 codex CLI 比我们带的 SDK 新(2026-09-09 定案:SDK 0.144 驱动 CLI 0.153),
 *     MCP 调用换了一个 SDK 不认识的 item 类型 —— 下游认不出这是 reply;
 *   - 没带 `dangerously_bypass_approvals_and_sandbox`(daemon 跑在 strict 下):codex 把每一次 MCP 调用都拒掉
 *     (`status: failed`,`error.message` 是 0.153 真机录到的「MCP tool call requires approval, but approval policy is
 *     never」;0.128 是「user cancelled MCP tool call」);模型看得到失败,可以接着演 `ifRejected`。
 *
 * 不起任何进程、不连网。
 */
import type { Codex, Thread, ThreadEvent, ThreadOptions } from '@openai/codex-sdk'
import type { CodexFactory } from './codex-agent-provider'

type ThreadItemLike = Extract<ThreadEvent, { type: 'item.completed' }>['item']

/** codex 0.153 在 approval never + 没有 bypass 时拒 MCP 调用的原话(2026-10-03 沙盒真跑录到)。 */
export const MCP_REJECTED = 'MCP tool call requires approval, but approval policy is never'

export type CodexScriptStep =
  /** 一条完整的助理消息(item.completed{agent_message})。 */
  | { say: string }
  /** 思考摘要(reasoning item,provider 丢掉)。 */
  | { think: string }
  /** MCP 工具调用。`ifRejected`:被拒(strict)之后模型接着演的步骤(它看得到调用失败了)。 */
  | { mcp: { server: string; tool: string; args?: Record<string, unknown> }; ifRejected?: CodexScriptStep[] }
  /** shell 命令(command_execution)。 */
  | { shell: string; output?: string }
  /** 原样发一条 ThreadEvent(回放录到的流)。 */
  | { raw: unknown }
  /** 停一会儿(长任务)。 */
  | { delayMs: number }

export interface CodexScriptedTurn {
  steps: CodexScriptStep[]
  /** 这一轮以 turn.failed 结束(消息原文)。 */
  fail?: string
}

export interface CodexScriptedCall { server: string; tool: string; args: Record<string, unknown> }

export interface ScriptedCodexOptions {
  /** 第 n 次 runStreamed(从 0 数)演哪一轮;函数形式拿得到这一轮的输入原文。 */
  turns: CodexScriptedTurn[] | ((input: string, n: number) => CodexScriptedTurn)
  /** MCP 调用用哪种 item:缺省 `mcp_tool_call`;`unknown_item` = CLI 比 SDK 新(见文件头)。 */
  mcpItem?: 'mcp_tool_call' | 'unknown_item'
  /**
   * MCP 调用会不会被 codex 拒掉。缺省:看 config 里有没有 `dangerously_bypass_approvals_and_sandbox`(和生产一样由
   * daemon 的 --dangerously 决定)—— 没有 ⇒ 全拒。
   */
  rejectMcp?: boolean
  /** MCP 工具「真的被调用」的那一刻(没被拒):模拟 MCP server 那一侧的副作用(reply 发进微信、voice 挂到本轮)。 */
  onToolCall?: (call: CodexScriptedCall) => void | Promise<void>
  threadId?: string
}

export interface ScriptedCodex {
  factory: CodexFactory
  /** 每一轮 runStreamed 收到的输入(第一轮带着前置的系统指令)。 */
  inputs: string[]
  /** 每次 `new Codex(...)` 的构造参数(spawn 时的 config:mcp_servers / bypass)。 */
  constructed: Array<Record<string, unknown>>
  threadOptions: ThreadOptions[]
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
  const t = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) }, { once: true })
})

export function createScriptedCodex(opts: ScriptedCodexOptions): ScriptedCodex {
  const inputs: string[] = []
  const constructed: Array<Record<string, unknown>> = []
  const threadOptions: ThreadOptions[] = []
  let n = 0
  const turnFor = (input: string): CodexScriptedTurn => {
    const k = n++
    if (typeof opts.turns === 'function') return opts.turns(input, k)
    const t = opts.turns[k]
    if (!t) throw new Error(`scripted codex: 第 ${k + 1} 轮没有剧本`)
    return t
  }

  const factory: CodexFactory = (args) => {
    const a = (args ?? {}) as Record<string, unknown>
    constructed.push(a)
    const config = (a.config ?? {}) as Record<string, unknown>
    const rejectMcp = opts.rejectMcp ?? config.dangerously_bypass_approvals_and_sandbox !== true
    const makeThread = (resumeId: string | null): Thread => {
      let id: string | null = resumeId
      let item = 0
      const nextId = (p: string) => `${p}_${++item}`
      const thread = {
        get id() { return id },
        async run() { throw new Error('scripted codex: run() 没有实现(对话侧只用 runStreamed)') },
        async runStreamed(input: unknown, turnOptions?: { signal?: AbortSignal }) {
          const text = typeof input === 'string' ? input : JSON.stringify(input)
          inputs.push(text)
          const turn = turnFor(text)
          const signal = turnOptions?.signal
          async function* gen(): AsyncGenerator<ThreadEvent> {
            if (id === null) {
              id = opts.threadId ?? 'scripted-thread'
              yield { type: 'thread.started', thread_id: id }
            }
            yield { type: 'turn.started' }
            async function* play(steps: CodexScriptStep[]): AsyncGenerator<ThreadEvent> {
              for (const s of steps) {
                if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
                if ('say' in s) yield { type: 'item.completed', item: { id: nextId('msg'), type: 'agent_message', text: s.say } }
                else if ('think' in s) yield { type: 'item.completed', item: { id: nextId('rs'), type: 'reasoning', text: s.think } }
                else if ('delayMs' in s) await sleep(s.delayMs, signal)
                else if ('raw' in s) yield s.raw as ThreadEvent
                else if ('shell' in s) {
                  const iid = nextId('cmd')
                  yield { type: 'item.started', item: { id: iid, type: 'command_execution', command: s.shell, aggregated_output: '', status: 'in_progress' } }
                  yield { type: 'item.completed', item: { id: iid, type: 'command_execution', command: s.shell, aggregated_output: s.output ?? '', exit_code: 0, status: 'completed' } }
                } else {
                  const iid = nextId('mcp')
                  const { server, tool } = s.mcp
                  const args = s.mcp.args ?? {}
                  const shape = (status: 'in_progress' | 'completed' | 'failed', extra: Record<string, unknown> = {}) => (
                    opts.mcpItem === 'unknown_item'
                      // CLI 比 SDK 新:同一次 MCP 调用,换了一个 SDK 不认识的 item 类型(字段也换了名)。
                      ? { id: iid, type: 'mcp_call', invocation: { server, tool, arguments: args }, status, ...extra }
                      : { id: iid, type: 'mcp_tool_call', server, tool, arguments: args, status, ...extra }
                  ) as unknown as ThreadItemLike
                  yield { type: 'item.started', item: shape('in_progress') }
                  if (rejectMcp) {
                    yield { type: 'item.completed', item: shape('failed', { error: { message: MCP_REJECTED } }) }
                    if (s.ifRejected) yield* play(s.ifRejected)
                  } else {
                    await opts.onToolCall?.({ server, tool, args })
                    yield { type: 'item.completed', item: shape('completed', { result: { content: [{ type: 'text', text: '{"ok":true}' }], structured_content: null } }) }
                  }
                }
              }
            }
            yield* play(turn.steps)
            if (turn.fail !== undefined) yield { type: 'turn.failed', error: { message: turn.fail } }
            else yield { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } }
          }
          return { events: gen() }
        },
      }
      return thread as unknown as Thread
    }
    const codex = {
      startThread(o?: ThreadOptions) { threadOptions.push(o ?? {}); return makeThread(null) },
      resumeThread(rid: string, o?: ThreadOptions) { threadOptions.push(o ?? {}); return makeThread(rid) },
    }
    return codex as unknown as Codex
  }
  return { factory, inputs, constructed, threadOptions }
}
