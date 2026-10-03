/**
 * Claude 一次性评估(cheapEval / strongEval)也读 SDK 的结构化标注(arch backlog #4 第 2 步余下部分;
 * 会话路径是 #190 做的)。以前 SDK 抛 `Claude Code returned an error result: …` 时结构全丢 ——
 * 一律只剩正文给下游扫。
 *
 * 按 #188 的样本(`claude.json` 里 cheap_eval 那几条的 `sdkStructure`)重放 SDK 消息:
 * 助理消息带 `error` 标注,结果 `is_error` + `api_error_status`,然后 SDK 抛出。
 */
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClaudeAgentProvider } from './claude-agent-provider'
import { providerErrorCodeOf } from '../lib/provider-error-code'

const h = vi.hoisted(() => ({ script: [] as unknown[], throwAfter: undefined as string | undefined }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    async function* gen() {
      for (const m of h.script) yield m
      if (h.throwAfter) throw new Error(h.throwAfter)
    }
    return Object.assign(gen(), { interrupt() {}, close() {} })
  },
}))

interface Sample { id: string; path: string; errorCode: string | null; message: string; sdkStructure?: Record<string, unknown> }
const samples = (JSON.parse(readFileSync(join(__dirname, '..', 'daemon', 'diagnostics', '__fixtures__', 'provider-errors', 'claude.json'), 'utf8')) as Sample[])
  .filter(s => s.path === 'cheap_eval' && s.sdkStructure)

function replay(s: Sample, opts: { throws: boolean }) {
  const st = s.sdkStructure!
  const text = st['assistant.text'] as string
  h.script = [
    { type: 'assistant', parent_tool_use_id: null, error: st['assistant.error'], message: { model: '<synthetic>', content: [{ type: 'text', text }] } },
    { type: 'result', subtype: 'success', is_error: true, api_error_status: st['result.api_error_status'] ?? null, result: text },
  ]
  h.throwAfter = opts.throws ? s.message : undefined
}
const provider = () => createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })

describe('Claude cheapEval —— 带 SDK 码抛出', () => {
  it('语料里每条 cheap_eval 样本都有可重放的结构', () => {
    expect(samples.map(s => s.id).sort()).toEqual([
      'claude.bad_key.cheap_eval', 'claude.forbidden_403.cheap_eval', 'claude.net_dns.cheap_eval', 'claude.net_refused.cheap_eval',
      'claude.not_logged_in.cheap_eval', 'claude.sleep.cheap_eval', 'claude.timeout.cheap_eval', 'claude.tls.cheap_eval',
    ])
  })

  it.each(samples.map(s => [s.id, s] as const))('%s:SDK 抛出 ⇒ 原文不变、码与 fixture 一致', async (_id, s) => {
    replay(s, { throws: true })
    const err = await provider().cheapEval!('x').catch(e => e)
    expect((err as Error).message).toBe(s.message)
    expect(providerErrorCodeOf(err) ?? null).toBe(s.errorCode)
  })

  it('标注了但 SDK 没抛:错误原文**不再**被当成评估答案返回', async () => {
    const s = samples.find(x => x.id === 'claude.bad_key.cheap_eval')!
    replay(s, { throws: false })
    const err = await provider().cheapEval!('x').catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect(providerErrorCodeOf(err)).toBe('auth_rejected')
  })

  it('红线 A:只有哨兵是 auth_failed;401/403 是 auth_rejected', async () => {
    const codes = new Map<string, string | undefined>()
    for (const s of samples) { replay(s, { throws: true }); codes.set(s.id, providerErrorCodeOf(await provider().cheapEval!('x').catch(e => e))) }
    expect([...codes].filter(([, c]) => c === 'auth_failed').map(([id]) => id)).toEqual(['claude.not_logged_in.cheap_eval'])
  })

  it('没有标注的普通失败(比如二进制不在)不挂码,交给旧回退', async () => {
    h.script = []; h.throwAfter = 'spawn claude ENOENT'
    const err = await provider().cheapEval!('x').catch(e => e)
    expect(providerErrorCodeOf(err)).toBeUndefined()
  })

  it('正常回答照旧返回', async () => {
    h.script = [{ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'ok' }] } }, { type: 'result', subtype: 'success', result: 'ok' }]
    h.throwAfter = undefined
    expect(await provider().cheapEval!('x')).toBe('ok')
  })
})
