import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDelegateDispatch } from './delegate'
import { makeFakeSession } from '../../core/test-helpers'
import type { AgentProvider } from '../../core/agent-provider'
import { TIER_PROFILES } from '../../core/user-tier'

// Bug #86 regression seam — spy on the real factory so we can assert it is
// NEVER invoked when no codexPathOverride is supplied. This is the only way
// to observe "construction was skipped" from outside delegate.ts: the real
// createCodexAgentProvider eagerly constructs the SDK (new Codex() inside
// its factory), which is exactly what crashes boot in a compiled bundle
// (findCodexPath() can't resolve @openai/codex from /$bunfs). Mocking it
// here means these tests don't depend on that codepath actually throwing —
// they assert the conditional construction directly.
const createCodexAgentProviderMock = vi.fn((_opts?: unknown) => ({ spawn: vi.fn() }) as unknown as AgentProvider)
vi.mock('../../core/codex-agent-provider', () => ({
  createCodexAgentProvider: (opts?: unknown) => createCodexAgentProviderMock(opts),
}))

function tmpState(): string {
  return mkdtempSync(join(tmpdir(), 'delegate-'))
}

describe('buildDelegateDispatch — openai/Kimi peer wiring', () => {
  it('reports unknown_peer for openai when the backend is NOT configured', async () => {
    // No agent-config.json in the temp state dir → openaiBaseUrl/openaiModel
    // undefined → the bare openai delegate is never built (null), regardless
    // of any ambient WECHAT_OPENAI_API_KEY.
    const dispatch = buildDelegateDispatch({ stateDir: tmpState() })
    const r = await dispatch('openai', 'hi')
    expect(r.ok).toBe(false)
    // 2026-09-02:错误串现在会点名本机实际可用的 provider —— 旧断言是全等,
    // 那会把「说清楚」这件事锁死。见 delegate.ts 的 availablePeers。
    if (!r.ok) expect(r.reason).toContain('unknown_peer: openai')
  })

  it('routes peer "openai" through the delegate map and returns its reply', async () => {
    // Inject a fake provider for openai (bypasses real construction / network),
    // proving the (peer → provider) routing handles openai. Before openai was
    // wired into the switch this returned unknown_peer.
    const fakeOpenai: AgentProvider = {
      spawn: async () => makeFakeSession({
        events: [
          { kind: 'text', text: 'kimi-here' },
          { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 },
        ],
      }),
    }
    const dispatch = buildDelegateDispatch({
      stateDir: tmpState(),
      delegateProviders: { openai: fakeOpenai },
    })
    const r = await dispatch('openai', 'ping')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.response).toBe('kimi-here')
  })

  it('surfaces a turn error event as ok:false instead of an empty success (collectTurn.error inspected)', async () => {
    // Providers surface failures as error EVENTS (openai auth failures, etc.)
    // rather than throwing — dispatch() must inspect result.error and NOT
    // just drain collectTurn into an always-ok:true empty response.
    const fakeOpenai: AgentProvider = {
      spawn: async () => makeFakeSession({
        events: [
          { kind: 'error', code: 'auth_failed', message: '401 unauthorized' },
        ],
      }),
    }
    const dispatch = buildDelegateDispatch({
      stateDir: tmpState(),
      delegateProviders: { openai: fakeOpenai },
    })
    const r = await dispatch('openai', 'ping')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('auth_failed')
  })

  it('still reports unknown_peer for a genuinely unknown provider', async () => {
    const dispatch = buildDelegateDispatch({ stateDir: tmpState() })
    const r = await dispatch('bogus-provider', 'hi')
    expect(r.ok).toBe(false)
    // 2026-09-02:错误串现在会点名本机实际可用的 provider —— 旧断言是全等,
    // 那会把「说清楚」这件事锁死。见 delegate.ts 的 availablePeers。
    if (!r.ok) expect(r.reason).toContain('unknown_peer: bogus-provider')
  })
})

// ─── codex delegate is conditional on a verified CLI (#86) ─────────────────
describe('buildDelegateDispatch — codex peer is conditional on codexPathOverride', () => {
  it('does NOT construct the codex provider when no codexPathOverride is passed (the boot-crash regression)', () => {
    createCodexAgentProviderMock.mockClear()
    buildDelegateDispatch({ stateDir: tmpState() })
    // The real factory eagerly constructs the SDK — never calling it at all
    // (not "call it and swallow the throw") is the fix: a refused/absent
    // codex CLI must not touch codex construction at boot.
    expect(createCodexAgentProviderMock).not.toHaveBeenCalled()
  })

  it('reports unknown_peer for codex when no codexPathOverride is passed', async () => {
    const dispatch = buildDelegateDispatch({ stateDir: tmpState() })
    const r = await dispatch('codex', 'hi')
    expect(r.ok).toBe(false)
    // 2026-09-02:错误串现在会点名本机实际可用的 provider —— 旧断言是全等,
    // 那会把「说清楚」这件事锁死。见 delegate.ts 的 availablePeers。
    if (!r.ok) expect(r.reason).toContain('unknown_peer: codex')
  })

  it('logs a BOOT-visible line when the codex delegate is skipped', () => {
    const log = vi.fn()
    buildDelegateDispatch({ stateDir: tmpState(), log })
    expect(log).toHaveBeenCalledWith('BOOT', expect.stringContaining('codex delegate not registered'))
  })

  it('DOES construct the codex provider when codexPathOverride is passed (verified CLI)', () => {
    createCodexAgentProviderMock.mockClear()
    const log = vi.fn()
    buildDelegateDispatch({ stateDir: tmpState(), codexPathOverride: '/usr/local/bin/codex', log })
    expect(createCodexAgentProviderMock).toHaveBeenCalledTimes(1)
    expect(createCodexAgentProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({ codexPathOverride: '/usr/local/bin/codex' }),
    )
    // No skip line when the delegate was actually built.
    expect(log).not.toHaveBeenCalledWith('BOOT', expect.stringContaining('codex delegate not registered'))
  })
})

// ─── busy-registry hold (spec 2026-08-11 §2, Task 4 step 3) ────────────────
describe('buildDelegateDispatch — busy-registry hold', () => {
  it('holds a token spanning spawn→dispatch→close, released after the session settles', async () => {
    const events: string[] = []
    const release = vi.fn(() => events.push('release'))
    const holdBusy = vi.fn((label: string) => { events.push(`hold:${label}`); return release })
    const fakeOpenai: AgentProvider = {
      spawn: async () => makeFakeSession({
        // At the moment the session actually does work, the hold must already
        // be active and not yet released — proves it spans the real work, not
        // just bookend log lines.
        onDispatch: () => {
          expect(holdBusy).toHaveBeenCalledTimes(1)
          expect(release).not.toHaveBeenCalled()
        },
        events: [
          { kind: 'text', text: 'kimi-here' },
          { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 },
        ],
      }),
    }
    const dispatch = buildDelegateDispatch({
      stateDir: tmpState(),
      delegateProviders: { openai: fakeOpenai },
      holdBusy,
    })
    const r = await dispatch('openai', 'ping')
    expect(r.ok).toBe(true)
    expect(holdBusy).toHaveBeenCalledWith('a2a-delegate')
    expect(release).toHaveBeenCalledTimes(1)
    expect(events).toEqual(['hold:a2a-delegate', 'release'])
  })

  it('releases the token even when the peer session throws (spawn failure)', async () => {
    const release = vi.fn()
    const holdBusy = vi.fn(() => release)
    const throwingOpenai: AgentProvider = { spawn: async () => { throw new Error('spawn boom') } }
    const dispatch = buildDelegateDispatch({
      stateDir: tmpState(),
      delegateProviders: { openai: throwingOpenai },
      holdBusy,
    })
    const r = await dispatch('openai', 'ping')
    expect(r.ok).toBe(false)
    expect(holdBusy).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('never holds a token for unknown_peer — the short-circuit before any session work', async () => {
    const holdBusy = vi.fn()
    const dispatch = buildDelegateDispatch({ stateDir: tmpState(), holdBusy })
    const r = await dispatch('bogus-provider', 'hi')
    expect(r.ok).toBe(false)
    // 2026-09-02:错误串现在会点名本机实际可用的 provider —— 旧断言是全等,
    // 那会把「说清楚」这件事锁死。见 delegate.ts 的 availablePeers。
    if (!r.ok) expect(r.reason).toContain('unknown_peer: bogus-provider')
    expect(holdBusy).not.toHaveBeenCalled()
  })

  it('a holdBusy that throws never breaks dispatch (defensive catch)', async () => {
    const holdBusy = vi.fn(() => { throw new Error('registry exploded') })
    const fakeOpenai: AgentProvider = {
      spawn: async () => makeFakeSession({
        events: [
          { kind: 'text', text: 'ok' },
          { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 },
        ],
      }),
    }
    const dispatch = buildDelegateDispatch({
      stateDir: tmpState(),
      delegateProviders: { openai: fakeOpenai },
      holdBusy,
    })
    const r = await dispatch('openai', 'ping')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.response).toBe('ok')
  })
})

// 2026-09-02 真机实验的产物。把 Windows 那台配成 hand(它跑 openai-compatible
// /Kimi,机器上既没有 claude 也没有 codex 的 CLI),然后从 Mac 委派一个任务:
//
//   {"ok":false,"reason":"Claude Code process exited with code 1"}
//
// 传输是通的(bearer 过了、路由到了、exec 真的跑了),断在**大脑替对方决定
// 用哪个 agent**:makeDelegateToHand 写死 `peer: 'claude'`,/a2a/exec 也默认
// 'claude'。于是**任何不装 claude/codex 的机器都当不了手**,而报错还是一句
// 看不出因果的「进程退出码 1」。
//
// 正确的语义:哪个 agent 跑在**那台机器上**,该由那台机器说了算。大脑可以
// 指定(「让 win 用 codex 跑」),但不指定时不该替它假设。
function tempState(cfg: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'wcc-delegate-peer-'))
  writeFileSync(join(dir, 'agent-config.json'), JSON.stringify(cfg))
  return dir
}

describe('dispatchDelegate —— peer 省略时用本机自己的默认 provider', () => {
  const fake = (tag: string): AgentProvider => ({
    spawn: async () => makeFakeSession({
      events: [{ kind: 'text', text: tag }, { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 1 }],
    }),
  })

  it('不给 peer → 走本机配置的 provider,而不是硬编码的 claude', async () => {
    const stateDir = tempState({ provider: 'openai' })
    const d = buildDelegateDispatch({
      stateDir,
      delegateProviders: { claude: fake('CLAUDE'), openai: fake('KIMI') },
    })
    const r = await d(undefined, 'hi')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.response).toContain('KIMI')
  })

  it('显式指定 peer 仍然生效(「让 win 用 codex 跑」)', async () => {
    const stateDir = tempState({ provider: 'openai' })
    const d = buildDelegateDispatch({
      stateDir,
      delegateProviders: { claude: fake('CLAUDE'), openai: fake('KIMI') },
    })
    const r = await d('claude', 'hi')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.response).toContain('CLAUDE')
  })

  it('本机配置的 provider 没建成 delegate → 回落到任何一个建成的,不是直接失败', async () => {
    // 例如配了 agy 但这台机器上 agy 的 delegate 没注册。有手总比没手好。
    const stateDir = tempState({ provider: 'agy' })
    const d = buildDelegateDispatch({ stateDir, claudeAvailable: false, delegateProviders: { openai: fake('KIMI') } })
    const r = await d(undefined, 'hi')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.response).toContain('KIMI')
  })

  it('要的 peer 这台机器上没有 → 错误里点名它到底有什么', async () => {
    // 旧行为是让它去 spawn 一个不存在的 CLI,拿回「进程退出码 1」——
    // 那条消息没有任何可行动的信息。
    const stateDir = tempState({ provider: 'openai' })
    const d = buildDelegateDispatch({ stateDir, delegateProviders: { openai: fake('KIMI') } })
    const r = await d('codex', 'hi')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain('codex')
      expect(r.reason).toContain('openai')   // 有什么要说出来
    }
  })
})

// 2026-09-02。owner:「应该要放权的,hand 的目的是连接自己的另一台
// wechat-cc 设备不是么」。对 —— 但放权的前提是路由**认得出**谁是自己的
// 机器,那道 `may_exec` 授权检查同时落在 a2a-server 上(见那边的用例)。
// 检查到位之后,按 provider 分档就只剩历史巧合:claude 早就是 trusted。
describe('delegate 的 tier —— 所有 provider 一视同仁', () => {
  it('非 claude 的 delegate 也拿 trusted(此前是 guest,连 fs_read 都没有)', async () => {
    const seen: Array<{ tierProfile: unknown }> = []
    const spy: AgentProvider = {
      spawn: async (_p, ctx) => {
        seen.push({ tierProfile: ctx.tierProfile })
        return makeFakeSession({ events: [{ kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 }] })
      },
    }
    const d = buildDelegateDispatch({ stateDir: tempState({ provider: 'openai' }), claudeAvailable: false, delegateProviders: { openai: spy } })
    await d(undefined, 'x')
    expect(seen[0]!.tierProfile).toBe(TIER_PROFILES.trusted)
  })

  it('trusted 档下 Read 是允许的 —— 这正是此前坏掉的那件事', () => {
    // GUEST_ALLOW 不含 fs_read,所以旧档下手连自己机器上的文件都读不了。
    expect(TIER_PROFILES.guest.deny.has('fs_read')).toBe(true)
    expect(TIER_PROFILES.trusted.allow.has('fs_read')).toBe(true)
  })

  it('但**不是 admin**:派来的活不能改我的 daemon 配置或重启我', () => {
    expect(TIER_PROFILES.trusted.deny.has('daemon_remediate')).toBe(true)
    expect(TIER_PROFILES.trusted.deny.has('config_admin')).toBe(true)
  })
})
