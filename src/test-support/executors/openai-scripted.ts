/**
 * 照剧本说话的假 OpenAI 兼容端点(`APIModel` 那一层)—— **只给测试用**,生产代码不 import 它。
 *
 * B2(2026-10-25)起对话和工作台是同一种会话(openai-session.ts),底下同一个 `APIModel`;两边的测试都拿这一个替身,
 * 不起网络、不连真模型。每一步按剧本:
 *   - `text`:一段字(给数组就是逐块的 delta,拼起来是一条消息);
 *   - `calls`:这一步发起的工具调用(id 不给就按步数编);
 *   - `finish`:finishReason(缺省:有调用 ⇒ tool-calls,没有 ⇒ stop);`model` / `usage`:端点报回来的;
 *   - `fail`:这一步的流直接抛这个错(网关 401、连不上 …);
 *   - `hang`:一直不说完,直到请求被掐(signal abort)。
 * 剧本可以是数组(一步一项,用完了再要 ⇒ 抛 `unexpected turn`),也可以是函数(按收到的历史现编)。
 */
import type { APIModel, ChatMessage, StepResult, ToolSpec, TurnDelta } from '../../adapters/executors/openai/api-model'

export interface OpenAiScriptedStep {
  text?: string | string[]
  calls?: { id?: string; name: string; input?: unknown }[]
  finish?: string
  model?: string | null
  usage?: StepResult['usage']
  fail?: unknown
  hang?: boolean
}

export interface ScriptedOpenAiModel {
  model: APIModel
  /** 每一步收到的历史(深拷贝)。 */
  seen: ChatMessage[][]
  /** 每一步收到的工具清单(只记名字)。 */
  tools: string[][]
  signals: AbortSignal[]
  /** generate() 收到的。 */
  prompts: ChatMessage[][]
}

export function scriptedOpenAiModel(
  script: OpenAiScriptedStep[] | ((messages: ChatMessage[], step: number) => OpenAiScriptedStep),
  opts: { generate?: (messages: ChatMessage[]) => string | Promise<string> } = {},
): ScriptedOpenAiModel {
  const seen: ChatMessage[][] = []
  const tools: string[][] = []
  const signals: AbortSignal[] = []
  const prompts: ChatMessage[][] = []
  let n = 0
  const model: APIModel = {
    stream(messages: ChatMessage[], specs: ToolSpec[], signal: AbortSignal) {
      n++
      seen.push(structuredClone(messages)); tools.push(specs.map(s => s.name)); signals.push(signal)
      const step = typeof script === 'function' ? script(messages, n) : script.shift()
      if (!step) throw Error('unexpected turn')
      const calls = (step.calls ?? []).map((c, i) => ({ id: c.id ?? `call-${n}-${i + 1}`, name: c.name, input: c.input ?? {} }))
      const chunks = step.text === undefined ? [] : Array.isArray(step.text) ? step.text : [step.text]
      const full = chunks.join('')
      let resolve!: (v: StepResult) => void, reject!: (e: unknown) => void
      const finished = new Promise<StepResult>((y, r) => { resolve = y; reject = r })
      void finished.catch(() => undefined)
      async function* deltas(): AsyncIterable<TurnDelta> {
        try {
          if (step!.hang) {
            await new Promise<void>(r => { if (signal.aborted) r(); else signal.addEventListener('abort', () => r(), { once: true }) })
            throw Error('api_model_aborted')
          }
          if (step!.fail !== undefined) throw step!.fail
          for (const c of chunks) if (c) yield { kind: 'text', text: c }
          for (const c of calls) yield { kind: 'tool_call', ...c }
          resolve({
            messages: [{ role: 'assistant', content: [...(full ? [{ type: 'text' as const, text: full }] : []), ...calls.map(c => ({ type: 'tool-call' as const, toolCallId: c.id, toolName: c.name, input: c.input }))] }],
            toolCalls: calls,
            finishReason: step!.finish ?? (calls.length ? 'tool-calls' : 'stop'),
            model: step!.model === undefined ? 'fixture' : step!.model,
            ...(step!.usage ? { usage: step!.usage } : {}),
          })
        } catch (err) { reject(err); throw err }
      }
      return { deltas: deltas(), finished }
    },
    async generate(messages) {
      prompts.push(structuredClone(messages))
      if (!opts.generate) throw Error('unexpected generate')
      return await opts.generate(messages)
    },
  }
  return { model, seen, tools, signals, prompts }
}

/** 一个什么工具都没有的 MCP 桥(AgentMcpTools 的形状)。`calls` 记下被调到的工具名。 */
export function scriptedMcpTools(spec: { tools?: { name: string; server?: string }[]; call?: (name: string, input: unknown) => string | Promise<string> } = {}) {
  const calls: { name: string; input: unknown }[] = []
  let closed = 0
  const servers = new Map((spec.tools ?? []).map(t => [t.name, t.server ?? 'wechat']))
  return {
    calls,
    closed: () => closed,
    bridge: {
      tools: (spec.tools ?? []).map(t => ({ name: t.name, description: t.name, parameters: { type: 'object' } as Record<string, unknown> })),
      async call(name: string, input: unknown) { calls.push({ name, input }); return spec.call ? await spec.call(name, input) : `ran:${name}` },
      async close() { closed++ },
      serverOf: (name: string) => servers.get(name),
    },
  }
}
