import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeHealthRuntime } from '../health'
import { reportLlmTurnOutcome } from './wire-health'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wire-health-rt-')) })

function setup() {
  const t = { ms: 0 }
  const rt = makeHealthRuntime({
    stateDir: dir,
    now: () => t.ms,
    log: () => {},
    notify: () => {},
  })
  return { t, rt }
}

describe('reportLlmTurnOutcome (Task 9 review fix — business failures must not degrade llm)', () => {
  it('业务性失败不推进 llm degraded —— 停掉所有人的回复比烧 token 严重得多', () => {
    const { t, rt } = setup()
    // step budget exhausted (openai-agent-provider.ts) / max_turns-shaped
    // summary (claude-agent-provider.ts) — both are TurnRecord.outcome
    // 'error' with a message classify.ts can't attribute to network/auth,
    // so they fall into the 'unknown' bucket. Repeated well past the 60s
    // confirmation window, on the SAME dep, with no success in between —
    // if these counted as connectivity failures this would degrade 'llm'.
    for (let elapsed = 0; elapsed <= 90_000; elapsed += 10_000) {
      t.ms = elapsed
      reportLlmTurnOutcome(rt, 'error', 'step budget 24 exhausted')
    }
    expect(rt.health.shouldSuspend('llm')).toBe(false)
    expect(rt.health.get('llm').consecutiveFailures).toBe(0)

    // Same for the claude-agent-provider max_turns shape (a non-'success'
    // result subtype folded into an 'error' outcome with a plain-text
    // summary — no network/auth keywords in it either).
    for (let elapsed = 100_000; elapsed <= 200_000; elapsed += 10_000) {
      t.ms = elapsed
      reportLlmTurnOutcome(rt, 'error', 'Reached max_turns (40) before completing the task')
    }
    expect(rt.health.shouldSuspend('llm')).toBe(false)
    expect(rt.health.get('llm').consecutiveFailures).toBe(0)
  })

  it('真正的连接/认证失败仍然会推进 degraded', () => {
    const { t, rt } = setup()
    // Network-shaped failure (matches classify.ts's NETWORK_RE).
    t.ms = 0
    reportLlmTurnOutcome(rt, 'error', 'unknown certificate verification error')
    expect(rt.health.shouldSuspend('llm')).toBe(false) // still inside the 60s confirmation window
    t.ms = 60_000
    reportLlmTurnOutcome(rt, 'error', 'unknown certificate verification error')
    expect(rt.health.shouldSuspend('llm')).toBe(true)
  })

  it('真正的认证失败(401)也会推进 degraded', () => {
    const { t, rt } = setup()
    t.ms = 0
    reportLlmTurnOutcome(rt, 'error', '401 Unauthorized')
    expect(rt.health.shouldSuspend('llm')).toBe(false)
    t.ms = 60_000
    reportLlmTurnOutcome(rt, 'error', '401 Unauthorized')
    expect(rt.health.shouldSuspend('llm')).toBe(true)
  })

  it('auth_failed / timeout 结果类别本身不豁免分类 —— 判定只看错误文本的 kind', () => {
    const { t, rt } = setup()
    // outcome='auth_failed' with a message classify.ts recognizes as
    // llm_auth still counts (the coordinator's own auth_failed path already
    // sends its own throttled notice separately — this is an independent,
    // additive signal into the connection-health machine).
    t.ms = 0
    reportLlmTurnOutcome(rt, 'auth_failed', 'invalid api key')
    t.ms = 60_000
    reportLlmTurnOutcome(rt, 'auth_failed', 'invalid api key')
    expect(rt.health.shouldSuspend('llm')).toBe(true)
  })

  it("'completed' 清零并恢复", () => {
    const { t, rt } = setup()
    t.ms = 0
    reportLlmTurnOutcome(rt, 'error', 'unknown certificate verification error')
    t.ms = 60_000
    reportLlmTurnOutcome(rt, 'error', 'unknown certificate verification error')
    expect(rt.health.shouldSuspend('llm')).toBe(true)
    t.ms = 61_000
    reportLlmTurnOutcome(rt, 'completed', undefined)
    expect(rt.health.shouldSuspend('llm')).toBe(false)
    expect(rt.health.get('llm').consecutiveFailures).toBe(0)
  })

  it('带 provider 码的回合按码判:auth_rejected 进 llm_auth,通知不说登录;rate_limited 不推进', () => {
    const notes: Array<{ title: string; body: string }> = []
    const t = { ms: 0 }
    const rt = makeHealthRuntime({ stateDir: dir, now: () => t.ms, log: () => {}, notify: (n) => { notes.push(n) } })
    const msg = 'Failed to authenticate. API Error: 403 Request not allowed'
    reportLlmTurnOutcome(rt, 'error', 'API Error: 401 rate', 'rate_limited')
    expect(rt.health.get('llm').consecutiveFailures).toBe(0)
    reportLlmTurnOutcome(rt, 'auth_failed', msg, 'auth_rejected')
    t.ms = 60_000
    reportLlmTurnOutcome(rt, 'auth_failed', msg, 'auth_rejected')
    expect(rt.health.shouldSuspend('llm')).toBe(true)
    expect(rt.incidents.openOf('llm')?.kind).toBe('llm_auth')
    t.ms = 10 * 60_000   // 过了可操作故障的通知阈值
    reportLlmTurnOutcome(rt, 'auth_failed', msg, 'auth_rejected')
    expect(notes.length).toBeGreaterThan(0)
    expect(notes[0]!.title).toBe('模型认证没通过')
    for (const n of notes) expect(`${n.title}${n.body}`).not.toMatch(/登录|过期/)
  })
})
