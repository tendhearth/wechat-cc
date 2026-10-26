/**
 * result 标了 `is_error: true` 的那种回合:对话和一起做同一个判法(claudeResultFailure,claude-sdk-messages.ts)。
 *
 * 主人 2026-10-26:一起做和对话对齐。以前对话侧把「is_error 而没有标注消息」收成 `provider_error`,一起做照常推
 * result,回合显示「完成」。这里同一组 SDK 消息分别喂给两边(真 provider,只把 SDK 的 `query()` 换成可控的流),
 * 每一条的结局两边必须一样:要么带同一个码、同一句话失败,要么照常完成。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClaudeAgentProvider } from './claude-agent-provider'
import { claudeResultFailure } from './claude-sdk-messages'
import type { AgentEvent, AgentSession } from '../../../ports/agent-provider'
import { TIER_PROFILES } from '../../../domain/user-tier'

const native = vi.hoisted(() => ({ emit: (_message: unknown) => {}, end: () => {} }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    const messages: unknown[] = [], waiting: ((value: IteratorResult<unknown>) => void)[] = []
    let done = false
    native.emit = message => { const waiter = waiting.shift(); if (waiter) waiter({ value: message, done: false }); else messages.push(message) }
    native.end = () => { done = true; for (const waiter of waiting.splice(0)) waiter({ value: undefined, done: true }) }
    void (async () => { for await (const _ of prompt) { /* 收下用户消息 */ } })()
    return {
      [Symbol.asyncIterator]() { return this },
      next() {
        if (messages.length) return Promise.resolve({ value: messages.shift(), done: false })
        if (done) return Promise.resolve({ value: undefined, done: true })
        return new Promise(resolve => waiting.push(resolve))
      },
      close() { native.end() },
      interrupt: async () => {},
    }
  },
}))

const SESSION = 'native-parent'
const result = (extra: Record<string, unknown>) => ({ type: 'result', subtype: 'success', session_id: SESSION, num_turns: 1, duration_ms: 3, ...extra })
const assistant = (text: string, extra: Record<string, unknown> = {}) => ({ type: 'assistant', uuid: crypto.randomUUID(), parent_tool_use_id: null, ...extra, message: { id: `msg-${crypto.randomUUID()}`, model: 'parent-model', content: [{ type: 'text', text }] } })

/** 同一组样本:一轮里 SDK 吐的消息(init 之后),和两边都该得到的结局(null = 照常完成)。 */
const FIXTURES: ReadonlyArray<readonly [name: string, messages: unknown[], failure: { code: string; message: string } | null]> = [
  ['is_error, no labelled message, text that reads like a normal reply',
    [assistant('改好了，测试也过了。'), result({ is_error: true, result: '改好了，测试也过了。' })],
    { code: 'provider_error', message: '改好了，测试也过了。' }],
  ['is_error with an error-looking result and no label',
    [result({ is_error: true, api_error_status: null, result: 'API Error: 500 boom' })],
    { code: 'provider_error', message: 'API Error: 500 boom' }],
  ['is_error with an empty result',
    [result({ is_error: true, result: '' })],
    { code: 'provider_error', message: 'claude result is_error' }],
  ['labelled API failure plus is_error: the label wins, one error only',
    [assistant('API Error: 529 Overloaded', { error: 'server_error' }), result({ is_error: true, api_error_status: 529, result: 'API Error: 529 Overloaded' })],
    { code: 'server_error', message: 'API Error: 529 Overloaded' }],
  ['is_error false: an ordinary completed turn',
    [assistant('都好了'), result({ is_error: false, result: '都好了' })],
    null],
  ['no is_error field: an ordinary completed turn',
    [assistant('都好了'), result({ result: '都好了' })],
    null],
]

const sessions: AgentSession[] = []
afterEach(async () => { native.end(); for (const s of sessions.splice(0)) await s.close().catch(() => {}) })

async function chatTurn(messages: unknown[]): Promise<AgentEvent[]> {
  const session = await createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
    .spawn({ alias: 'chat', path: '/tmp' }, { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: 'chat-1' })
  sessions.push(session)
  const out: AgentEvent[] = []
  const drained = (async () => { for await (const ev of session.dispatch('你好')) out.push(ev) })()
  native.emit({ type: 'system', subtype: 'init', session_id: SESSION })
  for (const m of messages) native.emit(m)
  await drained
  return out
}

async function workbenchTurn(messages: unknown[]): Promise<AgentEvent[]> {
  const session = await createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
    .spawn({ alias: 'wb', path: '/tmp' }, { tierProfile: TIER_PROFILES.trusted, permissionMode: 'strict', chatId: 'wb', workbenchTimeline: true, workbenchLifecycle: true })
  sessions.push(session)
  const runtime = session.workbenchRuntime!
  const out: AgentEvent[] = []
  const drained = (async () => { for await (const ev of runtime.events) out.push(ev) })()
  runtime.start('start')
  // 这个版本的原生 CLI 验证过后台登记,没有后台任务的回合在 result 上收尾(和运行时测试同一个前提)。
  native.emit({ type: 'system', subtype: 'init', session_id: SESSION, model: 'parent-model', claude_code_version: '2.1.267', tools: [], capabilities: ['msg_lifecycle_v1'] })
  for (const m of messages) native.emit(m)
  await drained
  return out
}

const errors = (events: AgentEvent[]) => events.filter(e => e.kind === 'error').map(e => ({ code: (e as { code?: string }).code, message: (e as { message: string }).message }))

describe.skipIf(process.platform === 'win32')('Claude result is_error: chat and workbench end the same way', () => {
  it.each(FIXTURES)('%s', async (_name, messages, failure) => {
    const chat = await chatTurn(messages)
    const workbench = await workbenchTurn(messages)

    expect(errors(chat), 'chat').toEqual(failure ? [failure] : [])
    expect(errors(workbench), 'workbench').toEqual(failure ? [failure] : [])

    // 对话:每一轮都以 result 收尾(coordinator 靠它结束这一轮);失败轮不带 finalText,原文不进回复。
    const chatResult = chat.at(-1) as Extract<AgentEvent, { kind: 'result' }>
    expect(chatResult.kind).toBe('result')
    if (failure) expect(chatResult).not.toHaveProperty('finalText')
    else expect(chatResult.finalText).toBe('都好了')

    // 一起做:失败轮不推 result(推了就会被当成「完成 / 这家恢复了」),成功轮推。
    expect(workbench.some(e => e.kind === 'result'), 'workbench result').toBe(!failure)
  })
})

describe('claudeResultFailure', () => {
  it('only a success-subtype result with is_error: true counts; other subtypes are handled by the caller', () => {
    expect(claudeResultFailure({ subtype: 'success', is_error: true, result: 'x' })).toEqual({ code: 'provider_error', message: 'x' })
    expect(claudeResultFailure({ is_error: true })).toEqual({ code: 'provider_error', message: 'claude result is_error' })
    expect(claudeResultFailure({ subtype: 'error_max_turns', is_error: true, result: 'x' })).toBeNull()
    expect(claudeResultFailure({ subtype: 'success', is_error: false, result: 'x' })).toBeNull()
    expect(claudeResultFailure({ subtype: 'success', result: 'x' })).toBeNull()
    expect(claudeResultFailure({ is_error: true, result: 'y'.repeat(500) })?.message).toHaveLength(400)
  })
})
