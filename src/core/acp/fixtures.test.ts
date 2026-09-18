/**
 * 真机报文回放契约测试。
 *
 * fixture 是 2026-09-17 ACP spike 抓到的 cursor-agent 原始 JSON-RPC 报文(脱敏后进仓库,
 * 生成脚本 `scripts/acp-fixture-from-transcript.ts`)。这里回放它,钉住两类东西:
 *  1. 翻译器吃真机报文不抛、事件条数对(不是只吃得下手写的理想报文);
 *  2. 协议字段的**实际**形状 —— `promptCapabilities` 嵌在 `agentCapabilities` 下面这种,
 *     照文档写会写错,只有录到的报文说了算。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../agent-provider'
import { acpImageCapable } from '../acp-agent-provider'
import { acpActivityId, createAcpTranslator } from './events'

type Obj = Record<string, unknown>
const obj = (value: unknown): Obj => (!!value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {})

const FIXTURE = fileURLToPath(new URL('./fixtures/cursor-acp-2026-09-17.jsonl', import.meta.url))
const records = readFileSync(FIXTURE, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as Obj)
const scenarios = [...new Set(records.map(record => String(record.scenario)))]
const of = (scenario: string): Obj[] => records.filter(record => record.scenario === scenario)
const payloadOf = (record: Obj): Obj => obj(record.payload)
const updatesOf = (rows: Obj[]): Obj[] => rows
  .filter(row => row.dir === 'in' && payloadOf(row).method === 'session/update')
  .map(row => obj(obj(payloadOf(row).params).update))

/** 一个场景的完整回放:prompt 请求 ⇒ beginTurn,带 stopReason 的同 id 应答 ⇒ endTurn。 */
function replay(rows: Obj[], text: 'append' | 'messages'): AgentEvent[] {
  const translator = createAcpTranslator({ text })
  const events: AgentEvent[] = []
  let promptId: unknown = undefined
  for (const row of rows) {
    const payload = payloadOf(row)
    if (row.dir === 'out' && payload.method === 'session/prompt') { translator.beginTurn(); promptId = payload.id; continue }
    if (row.dir !== 'in') continue
    if (payload.method === 'session/update') { events.push(...translator.update(obj(obj(payload.params).update))); continue }
    if (payload.method === undefined && promptId !== undefined && payload.id === promptId && typeof obj(payload.result).stopReason === 'string') {
      events.push(...translator.endTurn()); promptId = undefined
    }
  }
  return events
}

describe('ACP 真机报文回放(cursor-agent 2026-09-17)', () => {
  it('fixture 只含约定的场景与方向,且不带秘密', () => {
    expect(scenarios).toEqual(['c1', 'c2shellreject', 'c4both', 'c5', 'c5load'])
    expect([...new Set(records.map(record => record.dir))].sort()).toEqual(['in', 'out'])
    const raw = readFileSync(FIXTURE, 'utf8')
    expect([...new Set(raw.match(/\/Users\/[A-Za-z0-9._-]+/g) ?? [])]).toEqual(['/Users/owner'])
    expect(raw).not.toMatch(/[0-9a-f]{32,}/) // 会话 token 一类的裸十六进制
    expect(raw).toContain('"WECHAT_SESSION_TOKEN","value":"<redacted>"')
  })

  it('每个场景在 append / messages 两种模式下都回放得下去', () => {
    for (const scenario of scenarios) {
      for (const text of ['append', 'messages'] as const) {
        expect(() => replay(of(scenario), text), `${scenario}/${text}`).not.toThrow()
      }
    }
  })

  // 这条断言必须**替生产代码把关**,而不是只描述 fixture 的形状:录到的
  // initialize 结果直接喂 provider 自己的能力探测(acpImageCapable)。谁哪天
  // 照 ACP 文档把它改成只看顶层 promptCapabilities,这里立刻红。
  it('initialize 的能力字段:promptCapabilities 嵌在 agentCapabilities 下(照文档写会写错)', () => {
    let checked = 0
    for (const scenario of scenarios) {
      const rows = of(scenario)
      const request = rows.find(row => row.dir === 'out' && payloadOf(row).method === 'initialize')
      expect(request, scenario).toBeDefined()
      const id = payloadOf(request as Obj).id
      const response = rows.find(row => row.dir === 'in' && payloadOf(row).method === undefined && payloadOf(row).id === id)
      const result = obj(payloadOf(response as Obj).result)
      const capabilities = obj(result.agentCapabilities)
      expect(capabilities.loadSession, scenario).toBe(true)

      // 真机报文原样进探测 ⇒ true。
      expect(acpImageCapable(result), scenario).toBe(true)

      // 同一个对象,把嵌着的 promptCapabilities 摘掉 ⇒ false。
      // (探测真在读那个嵌套字段,而不是碰巧到处都返回 true。)
      const { promptCapabilities, ...withoutNested } = capabilities
      expect(acpImageCapable({ ...result, agentCapabilities: withoutNested }), scenario).toBe(false)

      // 拍平到顶层的兜底仍然认(将来哪家 agent 照文档写)。
      expect(acpImageCapable({ ...result, agentCapabilities: withoutNested, promptCapabilities }), scenario).toBe(true)
      checked++
    }
    expect(checked).toBe(scenarios.length)
  })

  it('权限卡只用协议里的三种 kind', () => {
    const requests = records.filter(record => record.dir === 'in' && payloadOf(record).method === 'session/request_permission')
    expect(requests.length).toBeGreaterThan(0)
    for (const request of requests) {
      const options = obj(payloadOf(request).params).options
      expect(Array.isArray(options)).toBe(true)
      for (const option of options as unknown[]) {
        expect(['allow_once', 'allow_always', 'reject_once']).toContain(obj(option).kind)
      }
    }
  })

  it('toolCallId 里嵌着字面换行,活动 id 清洗掉它', () => {
    const ids = [...new Set(updatesOf(records).map(update => update.toolCallId).filter((id): id is string => typeof id === 'string'))]
    const multiline = ids.filter(id => id.includes('\n'))
    expect(multiline.length).toBeGreaterThan(0)
    for (const id of multiline) expect(acpActivityId(id)).not.toContain('\n')
  })

  it('agent_message_chunk 一条 messageId 都没有 —— itemId 只能自己合成', () => {
    const chunks = updatesOf(records).filter(update => update.sessionUpdate === 'agent_message_chunk')
    expect(chunks.length).toBeGreaterThan(0)
    for (const chunk of chunks) expect(chunk.messageId).toBeUndefined()
  })

  it('messages 模式下 c1 恰好 2 条 text(工具调用前后各一条)', () => {
    const texts = replay(of('c1'), 'messages').filter(event => event.kind === 'text')
    expect(texts).toHaveLength(2)
    for (const text of texts) expect(text.kind === 'text' && text.text.trim().length).toBeGreaterThan(0)
  })

  it('c4both 的 MCP 调用带出工具身份(spike 里 server 名叫 spike-wechat)', () => {
    const calls = replay(of('c4both'), 'append').filter(event => event.kind === 'tool_call')
    const ping = calls.filter(event => event.kind === 'tool_call' && event.tool === 'ping' && event.server === 'spike-wechat')
    expect(ping.length).toBeGreaterThan(0)
  })
})
