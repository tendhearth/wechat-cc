import { describe, it, expect } from 'vitest'
import {
  collectTurn,
  isReplyToolCall,
  isReplyToolName,
  mergeEnvIntoMcpServers,
  CORE_MCP_SERVER_NAMES,
  type AgentEvent,
} from './agent-provider'

async function* events(...e: AgentEvent[]): AsyncIterable<AgentEvent> {
  for (const ev of e) yield ev
}

describe('mergeEnvIntoMcpServers — session-token scoping (F2)', () => {
  const servers: Record<string, { command: string; env?: Record<string, string> }> = {
    wechat: { command: 'bun', env: { A: '1' } },
    delegate: { command: 'bun' },
    wxvault: { command: 'python3', env: { DATA: '/x' } },   // third-party plugin
  }
  const token = { WECHAT_SESSION_TOKEN: 'secret', WECHAT_SESSION_TIER: 'admin' }

  it('without onlyNames, injects into every server (legacy behavior)', () => {
    const out = mergeEnvIntoMcpServers(servers, token)
    expect(out.wxvault!.env).toMatchObject(token)
  })

  it('scoped to CORE_MCP_SERVER_NAMES, the plugin gets NO bearer token', () => {
    const out = mergeEnvIntoMcpServers(servers, token, CORE_MCP_SERVER_NAMES)
    expect(out.wechat!.env).toMatchObject({ A: '1', ...token })   // core: token injected
    expect(out.delegate!.env).toMatchObject(token)
    expect(out.wxvault!.env).toEqual({ DATA: '/x' })              // plugin: untouched
    expect(out.wxvault!.env).not.toHaveProperty('WECHAT_SESSION_TOKEN')
  })
})

/**
 * Yields the given events, then hangs forever (never emits a result and
 * never closes) — models the Claude SDK subprocess going silent mid-turn
 * (idle-timeout / wedge). `returned` flips true when the consumer breaks
 * out of the loop and the generator's `return()` runs, so a test can
 * assert the watchdog actually stopped consuming.
 */
function hangingEvents(emit: AgentEvent[]): { stream: AsyncIterable<AgentEvent>; returned: () => boolean } {
  // Hand-rolled to mirror the real provider's AsyncQueue iterator: `next()`
  // hangs once the buffered events drain (the SDK went silent), but
  // `return()` resolves immediately and flips a flag (the queue closes). A
  // native `async *` generator stuck on `await` can't model this — its
  // `return()` never completes.
  let returned = false
  const buf = [...emit]
  const it: AsyncIterator<AgentEvent> = {
    next() {
      if (buf.length > 0) return Promise.resolve({ value: buf.shift()!, done: false })
      return new Promise<IteratorResult<AgentEvent>>(() => {}) // hang
    },
    return() { returned = true; return Promise.resolve({ value: undefined, done: true }) },
  }
  return { stream: { [Symbol.asyncIterator]: () => it }, returned: () => returned }
}

describe('isReplyToolCall', () => {
  it('matches wechat reply tools', () => {
    expect(isReplyToolCall({ kind: 'tool_call', server: 'wechat', tool: 'reply' })).toBe(true)
    expect(isReplyToolCall({ kind: 'tool_call', server: 'wechat', tool: 'reply_voice' })).toBe(true)
    expect(isReplyToolCall({ kind: 'tool_call', server: 'wechat', tool: 'send_file' })).toBe(true)
    expect(isReplyToolCall({ kind: 'tool_call', server: 'wechat', tool: 'edit_message' })).toBe(true)
    expect(isReplyToolCall({ kind: 'tool_call', server: 'wechat', tool: 'broadcast' })).toBe(true)
    expect(isReplyToolCall({ kind: 'tool_call', server: 'wechat', tool: 'send_sticker' })).toBe(true)
  })
  it('rejects non-wechat servers', () => {
    expect(isReplyToolCall({ kind: 'tool_call', server: 'other', tool: 'reply' })).toBe(false)
  })

  describe('isReplyToolName (raw SDK tool name)', () => {
    it('matches mcp__wechat__<replyTool> names', () => {
      expect(isReplyToolName('mcp__wechat__reply')).toBe(true)
      expect(isReplyToolName('mcp__wechat__reply_voice')).toBe(true)
      expect(isReplyToolName('mcp__wechat__send_file')).toBe(true)
      expect(isReplyToolName('mcp__wechat__broadcast')).toBe(true)
      expect(isReplyToolName('mcp__wechat__send_sticker')).toBe(true)
    })
    it('rejects other servers, non-reply wechat tools, and built-ins', () => {
      expect(isReplyToolName('mcp__other__reply')).toBe(false)
      expect(isReplyToolName('mcp__wechat__memory_read')).toBe(false)
      expect(isReplyToolName('Read')).toBe(false)
      expect(isReplyToolName('Bash')).toBe(false)
    })
  })
  it('rejects non-reply tools on wechat server', () => {
    expect(isReplyToolCall({ kind: 'tool_call', server: 'wechat', tool: 'memory_read' })).toBe(false)
  })
  it('rejects events with no server field (built-in tools)', () => {
    expect(isReplyToolCall({ kind: 'tool_call', tool: 'Read' })).toBe(false)
  })
  it('returns false for non-tool-call events', () => {
    expect(isReplyToolCall({ kind: 'text', text: 'hi' })).toBe(false)
    expect(isReplyToolCall({ kind: 'init', sessionId: 's1' })).toBe(false)
    expect(isReplyToolCall({ kind: 'result', sessionId: 's1', numTurns: 1, durationMs: 100 })).toBe(false)
    expect(isReplyToolCall({ kind: 'error', message: 'boom' })).toBe(false)
  })
})

describe('collectTurn', () => {
  it('accumulates text events', async () => {
    const summary = await collectTurn(events(
      { kind: 'text', text: 'hello' },
      { kind: 'text', text: 'world' },
    ))
    expect(summary.assistantText).toEqual(['hello', 'world'])
    expect(summary.replyToolCalled).toBe(false)
    expect(summary.result).toBeUndefined()
    expect(summary.error).toBeUndefined()
  })

  it('flags reply tool calls', async () => {
    const summary = await collectTurn(events(
      { kind: 'tool_call', server: 'wechat', tool: 'reply' },
    ))
    expect(summary.replyToolCalled).toBe(true)
  })

  it('does not flag non-reply tool calls', async () => {
    const summary = await collectTurn(events(
      { kind: 'tool_call', server: 'wechat', tool: 'memory_read' },
      { kind: 'tool_call', tool: 'Read' },
    ))
    expect(summary.replyToolCalled).toBe(false)
  })

  it('captures result event', async () => {
    const summary = await collectTurn(events(
      { kind: 'init', sessionId: 's1' },
      { kind: 'text', text: 'hi' },
      { kind: 'result', sessionId: 's1', numTurns: 1, durationMs: 250 },
    ))
    expect(summary.result).toEqual({ sessionId: 's1', numTurns: 1, durationMs: 250 })
    expect(summary.assistantText).toEqual(['hi'])
  })

  it('captures error events', async () => {
    const summary = await collectTurn(events(
      { kind: 'text', text: 'partial' },
      { kind: 'error', message: 'turn failed' },
    ))
    expect(summary.error).toBe('turn failed')
    expect(summary.assistantText).toEqual(['partial'])
  })

  it('handles empty iterable', async () => {
    const summary = await collectTurn(events())
    expect(summary).toEqual({
      assistantText: [], replyToolCalled: false, toolCalls: [], result: undefined, error: undefined, errorCode: undefined,
    })
  })

  it('returns a turn_timeout summary when the stream stalls past timeoutMs (does not hang)', async () => {
    const { stream, returned } = hangingEvents([{ kind: 'text', text: 'partial' }])
    const summary = await collectTurn(stream, { timeoutMs: 30 })
    expect(summary.errorCode).toBe('turn_timeout')
    expect(summary.error).toMatch(/timed out/i)
    // Partial text seen before the stall is preserved for diagnostics.
    expect(summary.assistantText).toEqual(['partial'])
    expect(summary.result).toBeUndefined()
    // The watchdog stopped consuming the wedged stream (generator return ran).
    expect(returned()).toBe(true)
  }, 2000)

  it('returns normally (no timeout) when the stream completes before timeoutMs', async () => {
    const summary = await collectTurn(events(
      { kind: 'text', text: 'hi' },
      { kind: 'result', sessionId: 's1', numTurns: 1, durationMs: 5 },
    ), { timeoutMs: 1000 })
    expect(summary.errorCode).toBeUndefined()
    expect(summary.assistantText).toEqual(['hi'])
    expect(summary.result).toEqual({ sessionId: 's1', numTurns: 1, durationMs: 5 })
  })
})

describe('ProviderCapabilities — per-provider self-declarations (RFC 05 Phase 2)', () => {
  it('CLAUDE_CAPABILITIES has the four expected fields', async () => {
    const { CLAUDE_CAPABILITIES } = await import('./claude-agent-provider')
    expect(CLAUDE_CAPABILITIES.perToolCallback).toBe(true)
    expect(CLAUDE_CAPABILITIES.supportsDelegation).toBe(true)
    expect(CLAUDE_CAPABILITIES.supportsResume).toBe(true)
    expect(CLAUDE_CAPABILITIES.sandboxLevels).toBeInstanceOf(Set)
  })

  it('CODEX_CAPABILITIES has the four expected fields', async () => {
    const { CODEX_CAPABILITIES } = await import('./codex-agent-provider')
    // codex SDK has no per-tool callback — that's the whole reason
    // tier→sandbox translation is coarse-grained for codex.
    expect(CODEX_CAPABILITIES.perToolCallback).toBe(false)
    expect(CODEX_CAPABILITIES.supportsDelegation).toBe(true)
    expect(CODEX_CAPABILITIES.supportsResume).toBe(true)
  })

  it('CURSOR_CAPABILITIES has the four expected fields', async () => {
    const { CURSOR_CAPABILITIES } = await import('./cursor-agent-provider')
    expect(CURSOR_CAPABILITIES.perToolCallback).toBe(false)
    // cursor SDK doesn't expose sub-agents yet — see RFC 05 §7 decision 3
    expect(CURSOR_CAPABILITIES.supportsDelegation).toBe(false)
    expect(CURSOR_CAPABILITIES.supportsResume).toBe(true)
  })
})

// 2026-09-02:把「一个 text 事件 = 一条完整的助手消息」这条**跨 provider 的
// 契约**钉下来。它此前只存在于各家实现的默契里,openai 那家违反了它整整
// 一个版本,症状是派活/圆桌的回复被按 token 切碎(每个 delta 之间一个换行)。
//
// 这个断言不会替你抓住一家新 provider 违约,但它把契约写成了可读的代码 ——
// 下一个实现者至少看得到「消费者会 join('\n')」这件事。
describe('AgentEvent text 的契约 —— 一个事件 = 一条完整消息', () => {
  it('collectTurn 把每个 text 事件当作一条独立消息(所以 provider 必须先聚合)', async () => {
    const stream = (async function* () {
      yield { kind: 'text', text: '第一条' } as AgentEvent
      yield { kind: 'text', text: '第二条' } as AgentEvent
      yield { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 } as AgentEvent
    })()
    const s = await collectTurn(stream)
    expect(s.assistantText).toEqual(['第一条', '第二条'])
    // 消费者的拼法:两条消息之间换行是对的 —— 前提是每一项真的是一条消息。
    expect(s.assistantText.join('\n')).toBe('第一条\n第二条')
  })
})

// 2026-09-02:owner 问「今天有什么新闻」,bot 答得有名有姓,而 channel.log 里
// 只有 `chunks=3 dur=39190ms` —— **看不出这答案是查来的还是模型编的**。
// 我当时差点据此断定「新闻是编的」,幸好去看了 agy 的原始流:它真的调了
// search_web、跑了 3.75 秒。事件流里 tool_call 一直在发,只是没有任何人记它。
describe('collectTurn 收集工具名 —— 「查来的」和「想出来的」要能分清', () => {
  it('按顺序收集,MCP 工具带上 server 前缀', async () => {
    const stream = (async function* () {
      yield { kind: 'tool_call', tool: 'search_web' } as AgentEvent
      yield { kind: 'text', text: '据检索…' } as AgentEvent
      yield { kind: 'tool_call', tool: 'reply', server: 'wechat' } as AgentEvent
      yield { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 } as AgentEvent
    })()
    const s = await collectTurn(stream)
    expect(s.toolCalls).toEqual(['search_web', 'wechat/reply'])
    expect(s.replyToolCalled).toBe(true)   // 没有把既有的 reply 检测弄坏
  })

  it('一个工具都没调 → 空数组(= 这条回答没查任何东西)', async () => {
    const stream = (async function* () {
      yield { kind: 'text', text: '我想是这样' } as AgentEvent
      yield { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 } as AgentEvent
    })()
    expect((await collectTurn(stream)).toolCalls).toEqual([])
  })

  it('**只有名字,没有参数** —— 参数里是搜索词/文件路径/消息正文', async () => {
    const stream = (async function* () {
      yield { kind: 'tool_call', tool: 'search_web' } as AgentEvent
      yield { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 } as AgentEvent
    })()
    const s = await collectTurn(stream)
    expect(JSON.stringify(s.toolCalls)).toBe('["search_web"]')
  })
})
