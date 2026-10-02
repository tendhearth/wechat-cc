/**
 * 主人拍板的那张表(2026-10-02,守护 v2),逐格编码。新发起的调用:
 *
 * | 网络信号                                   | 需要保护的调用(Claude…) | 国内 / 自建 |
 * |--------------------------------------------|-------------------------|-------------|
 * | bx 在保护                                   | 放行                    | 放行        |
 * | 没装 bx + 探测通                            | 放行                    | 放行        |
 * | 没装 bx + 探测不通                          | 暂停                    | 放行        |
 * | 没装 bx + 还没有探测结果                    | 等一下再暂停            | 放行        |
 * | 装了 bx 但 off / recovering / 读不出        | 暂停                    | 放行        |
 * | 同上,但 guard.json signal_source='probe'   | 跟着探测走              | 放行        |
 *
 * 测试里永远注入 bx 读取 / 探测,不碰真的 bx、不发任何隧道外的流量。
 */
import { describe, it, expect, vi } from 'vitest'
import { makeGuardRuntime } from './runtime'
import { initialState, type GuardState } from './scheduler'
import type { GuardLifecycle } from './lifecycle'
import { defaultGuardConfig, type GuardConfig } from './store'
import { decideCall, type CallTarget } from '../../lib/network-gate'
import type { BxVerdict } from './bx'

const PROTECTED: CallTarget = { provider: 'claude', purpose: 'turn' }
const DOMESTIC: CallTarget = { provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', purpose: 'turn' }
const SELF_HOSTED: CallTarget = { provider: 'openai', baseUrl: 'http://192.168.1.20:8080/v1', purpose: 'turn' }

const BX_OK: BxVerdict = { safe: true, protection: 'protected', tunnelHealthy: true, detail: 'bx 保护中' }
const BX_OFF: BxVerdict = { safe: false, protection: 'off', tunnelHealthy: false, detail: 'bx 未保护(protection_state=off)' }
const BX_RECOVERING: BxVerdict = { safe: false, protection: 'recovering', tunnelHealthy: true, detail: 'bx 未保护(protection_state=recovering)' }
const BX_UNREADABLE: BxVerdict = { safe: false, protection: null, tunnelHealthy: null, detail: 'bx 没在运行或读不出状态(exit 1)' }

function probeState(reachable: boolean): GuardState {
  return { ...initialState(), source: 'probe', reachable, safe: reachable, detail: reachable ? '探测可达' : '探测失败(timeout)', lastChecked: new Date().toISOString() }
}
function lifecycle(state: GuardState): GuardLifecycle {
  return { name: 'guard', stop: async () => {}, current: () => state, pokeNow: async () => state }
}

interface Row {
  name: string
  bx: BxVerdict | null              // null = 没装 bx
  probe: 'ok' | 'failed' | 'none'   // none = 还没有任何探测结果
  signalSource?: GuardConfig['signal_source']
  expectProtected: 'allow' | 'pause' | 'wait-then-pause'
}

const ROWS: Row[] = [
  { name: 'bx 在保护', bx: BX_OK, probe: 'none', expectProtected: 'allow' },
  { name: '没装 bx + 探测通', bx: null, probe: 'ok', expectProtected: 'allow' },
  { name: '没装 bx + 探测不通', bx: null, probe: 'failed', expectProtected: 'pause' },
  { name: '没装 bx + 还没有探测结果', bx: null, probe: 'none', expectProtected: 'wait-then-pause' },
  { name: '装了 bx 但 off(探测其实通 —— 不回落到 google)', bx: BX_OFF, probe: 'ok', expectProtected: 'pause' },
  { name: '装了 bx 但 recovering', bx: BX_RECOVERING, probe: 'ok', expectProtected: 'pause' },
  { name: '装了 bx 但读不出', bx: BX_UNREADABLE, probe: 'ok', expectProtected: 'pause' },
  { name: '装了 bx(off)+ signal_source=probe + 探测通 ⇒ 跟探测走', bx: BX_OFF, probe: 'ok', signalSource: 'probe', expectProtected: 'allow' },
  { name: '装了 bx(on)+ signal_source=probe + 探测不通 ⇒ 跟探测走', bx: BX_OK, probe: 'failed', signalSource: 'probe', expectProtected: 'pause' },
]

const WAIT_MS = 60

function runtimeFor(row: Row) {
  const readBx = vi.fn(async () => row.bx ?? BX_UNREADABLE)
  const probeOnce = vi.fn(() => new Promise<{ reachable: boolean }>(() => {}))  // 永远等不到
  const rt = makeGuardRuntime({
    stateDir: '/nonexistent',
    log: () => {},
    config: () => ({ ...defaultGuardConfig(), enabled: true, signal_source: row.signalSource ?? 'auto' }),
    findBx: () => (row.bx ? '/fake/bx' : null),
    readBx,
    probeOnce,
    agentConfig: () => null,
    env: {},
    firstProbeWaitMs: WAIT_MS,
  })
  if (row.probe !== 'none') rt.ref.set(lifecycle(probeState(row.probe === 'ok')))
  return { rt, readBx, probeOnce }
}

describe('owner table — new calls (protected vs domestic / self-hosted)', () => {
  it.each(ROWS)('$name', async (row) => {
    const { rt, readBx } = runtimeFor(row)
    // 国内 / 自建:永远放行,而且根本不看信号(不读 bx、不等探测)。
    const t0 = Date.now()
    for (const t of [DOMESTIC, SELF_HOSTED]) {
      const d = await decideCall(rt.gate, t)
      expect(d).toMatchObject({ allowed: true, protectedCall: false, verdict: null })
    }
    expect(Date.now() - t0).toBeLessThan(WAIT_MS)
    expect(readBx).not.toHaveBeenCalled()

    // 需要保护的:按表走。
    const t1 = Date.now()
    const d = await decideCall(rt.gate, PROTECTED)
    const took = Date.now() - t1
    expect(d.protectedCall).toBe(true)
    if (row.expectProtected === 'allow') expect(d.allowed).toBe(true)
    else {
      expect(d.allowed).toBe(false)
      if (row.expectProtected === 'wait-then-pause') {
        expect(took).toBeGreaterThanOrEqual(WAIT_MS - 5)
        expect(d.verdict).toMatchObject({ source: 'probe', safe: false })
      }
    }
    // signal_source=probe 时 bx 一次都不读。
    if (row.signalSource === 'probe') expect(readBx).not.toHaveBeenCalled()
  })

  it('no probe result yet, but the first probe lands inside the wait ⇒ allow (bounded wait, not a blind refusal)', async () => {
    const rt = makeGuardRuntime({
      stateDir: '/nonexistent', log: () => {},
      config: () => ({ ...defaultGuardConfig(), enabled: true }),
      findBx: () => null, readBx: async () => BX_UNREADABLE,
      probeOnce: () => new Promise(r => setTimeout(() => r({ reachable: true }), 10)),
      agentConfig: () => null, env: {}, firstProbeWaitMs: 2_000,
    })
    expect((await decideCall(rt.gate, PROTECTED)).allowed).toBe(true)
  })

  it('fail-open fixed: the scheduler\'s initial state is NOT safe', () => {
    expect(initialState()).toMatchObject({ safe: false, reachable: false, lastChecked: null })
  })

  it('guard disabled ⇒ everything allowed, signal never read', async () => {
    const readBx = vi.fn(async () => BX_OFF)
    const rt = makeGuardRuntime({ stateDir: '/x', log: () => {}, config: () => ({ ...defaultGuardConfig(), enabled: false }), findBx: () => '/fake/bx', readBx, agentConfig: () => null, env: {} })
    expect((await decideCall(rt.gate, PROTECTED)).allowed).toBe(true)
    expect(readBx).not.toHaveBeenCalled()
  })
})

describe('classification through the daemon gate (endpoint + model resolution)', () => {
  function rt(over: { env?: NodeJS.ProcessEnv; agent?: Record<string, unknown>; guard?: Partial<GuardConfig> } = {}) {
    return makeGuardRuntime({
      stateDir: '/nonexistent', log: () => {},
      config: () => ({ ...defaultGuardConfig(), enabled: true, ...over.guard }),
      findBx: () => '/fake/bx', readBx: async () => BX_OFF,
      agentConfig: () => (over.agent ?? null) as never, env: over.env ?? {},
    })
  }
  it('Claude Code with ANTHROPIC_BASE_URL pointing to a gateway ⇒ unprotected; opt-in switch ⇒ protected', async () => {
    expect((await decideCall(rt({ env: { ANTHROPIC_BASE_URL: 'https://gw.example.com' } }).gate, PROTECTED)).allowed).toBe(true)
    expect((await decideCall(rt({ env: { ANTHROPIC_BASE_URL: 'https://gw.example.com' }, guard: { protect_custom_gateways: true } }).gate, PROTECTED)).allowed).toBe(false)
    expect((await decideCall(rt().gate, PROTECTED)).allowed).toBe(false)
  })
  it('openai provider takes its endpoint from agent-config: Kimi .cn vs .ai', async () => {
    const t: CallTarget = { provider: 'openai', purpose: 'turn' }
    expect((await decideCall(rt({ agent: { openaiBaseUrl: 'https://api.moonshot.cn/v1' } }).gate, t)).allowed).toBe(true)
    expect((await decideCall(rt({ agent: { openaiBaseUrl: 'https://api.moonshot.ai/v1' } }).gate, t)).allowed).toBe(false)
    expect((await decideCall(rt({ agent: { openaiBaseUrl: 'http://localhost:11434/v1' } }).gate, t)).allowed).toBe(true)
  })
  it('Cursor with no per-call model falls back to agent-config cursorModel, then auto', async () => {
    const t: CallTarget = { provider: 'cursor', purpose: 'turn' }
    expect((await decideCall(rt().gate, t)).allowed).toBe(true)                                         // auto
    expect((await decideCall(rt({ agent: { cursorModel: 'gpt-5' } }).gate, t)).allowed).toBe(false)      // 全局选了 GPT
    expect((await decideCall(rt({ agent: { cursorModel: 'gpt-5' } }).gate, { ...t, model: 'composer-2' })).allowed).toBe(true)  // 这一轮钉了 composer
  })
  it('unknown Cursor model ⇒ protected by default, guard.json trust releases it', async () => {
    const t: CallTarget = { provider: 'cursor', model: 'kimi-k2', purpose: 'turn' }
    expect((await decideCall(rt().gate, t)).allowed).toBe(false)
    expect((await decideCall(rt({ guard: { trust: ['cursor:kimi-k2'] } }).gate, t)).allowed).toBe(true)
  })
})

describe('health (守护 v2)', () => {
  it('reports per-provider classification; paused only when a protected provider is in use', async () => {
    const r = makeGuardRuntime({
      stateDir: '/nonexistent', log: () => {},
      config: () => ({ ...defaultGuardConfig(), enabled: true }),
      findBx: () => '/fake/bx', readBx: async () => BX_OFF,
      agentConfig: () => ({ openaiBaseUrl: 'https://api.deepseek.com/v1', openaiModel: 'deepseek-chat' }) as never, env: {},
    })
    r.ref.set(lifecycle({ ...initialState(), source: 'bx', safe: false, reachable: false, detail: BX_OFF.detail, lastChecked: new Date().toISOString() }))
    r.setProvidersInUse(() => [{ id: 'openai', model: 'deepseek-chat' }, { id: 'cursor', model: 'auto' }])
    expect(r.health()).toMatchObject({ safe: false, protected_in_use: false, paused: false })
    r.setProvidersInUse(() => [{ id: 'openai', model: 'deepseek-chat' }, { id: 'claude', model: null }])
    const h = r.health()
    expect(h).toMatchObject({ safe: false, protected_in_use: true, paused: true })
    expect(h.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'openai', protected: false, kind: 'domestic' }),
      expect.objectContaining({ id: 'claude', protected: true, label: 'Claude' }),
    ]))
  })
})
