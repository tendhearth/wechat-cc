/**
 * llm-health.ts — the LLM-channel physical (2026-08-25, owner: 「用户绑定
 * wechat,通道肯定 ok,但 cc 调用 llm 通道,是否能检测呢?」).
 *
 * The dashboard's 「连接正常」 only proves the WECHAT side (ilink heartbeat).
 * The brain side — claude/codex/cursor/agy auth — could be dead and nothing
 * showed it until a user message failed. `dial()` actually calls each
 * registered provider (one tiny cheapEval, 「只回复:ok」) and classifies:
 *   ok           — round-trip succeeded (latency recorded)
 *   auth_failed  — credentials stale; `hint` carries the provider's own
 *                  fix-it line (capability's authFailHint, e.g. 「跑一次
 *                  cursor-agent login」)
 *   timeout      — no answer within timeoutMs
 *   error        — anything else (binary missing, network, …)
 *   ok:null      — provider exposes no eval surface to probe (untested)
 *
 * USER-INITIATED ONLY (owner ruling 2026-08-25): a dial round happens
 * exclusively when the user clicks 测试连接 — never at boot, never on a
 * timer or cache TTL. Unprompted automated calls on a flaky network are
 * exactly the shape that trips provider risk-control (封号 risk). `cached()`
 * returns the last user-initiated result and NEVER dials.
 */
import type { ProviderId } from '../core/conversation'
import { looksLikeAuthFailure } from '../lib/auth-failure'

export interface LlmProbeResult {
  provider: string
  /** true=ok, false=broken, null=no probe surface on this provider. */
  ok: boolean | null
  latency_ms: number
  error?: string
  auth_failed?: boolean
  hint?: string
}

export interface LlmHealthReport {
  checked_at: string
  default_provider: string
  results: LlmProbeResult[]
}

export interface LlmHealthDeps {
  registry: {
    list(): ProviderId[]
    get(id: ProviderId): { provider: { cheapEval?: (p: string) => Promise<string>; strongEval?: (p: string) => Promise<string> } } | null
  }
  defaultProviderId: ProviderId
  /** Provider-specific fix-it line (bootstrap wires capabilitiesFor(...).authFailHint). */
  hintFor?: (id: ProviderId) => string | undefined
  timeoutMs?: number
  now?: () => number
  log: (tag: string, line: string) => void
}

export interface LlmHealth {
  /** Last user-initiated report, or null. NEVER dials. */
  cached(): LlmHealthReport | null
  /** One user-initiated dial round (concurrent callers coalesce). */
  dial(): Promise<LlmHealthReport>
}

/** 人话 setup hints for providers that are NOT registered — surfaces in the
 *  desktop 大脑 card so「桌面版不知道在哪里配置」has an answer per provider. */
export const PROVIDER_SETUP_HINTS: Record<string, string> = {
  claude: '安装 Claude Code 并在终端登录一次(claude)',
  codex: '安装 codex CLI 并登录一次',
  cursor: '终端跑:curl https://cursor.com/install -fsS | bash,然后 cursor-agent login(用 Cursor 订阅账号)',
  agy: '安装 Antigravity CLI(agy)并登录一次(Google AI Pro 订阅)',
  openai: '把 WECHAT_OPENAI_API_KEY 写进 ~/.claude/channels/wechat/daemon.env,并配置 openaiBaseUrl/openaiModel',
  gemini: '把 GEMINI_API_KEY 写进 ~/.claude/channels/wechat/daemon.env',
}

/** Known providers not currently registered, each with its setup hint. */
export function unconfiguredHints(registered: string[]): Array<{ provider: string; how: string }> {
  const have = new Set(registered)
  return Object.entries(PROVIDER_SETUP_HINTS)
    .filter(([id]) => !have.has(id))
    .map(([provider, how]) => ({ provider, how }))
}

const PROBE_PROMPT = '只回复两个字母:ok'
const TIMEOUT_SENTINEL: unique symbol = Symbol('llm-probe-timeout')

/** 健康探针用**宽档**(码 + 厂商散文)—— 它只是报告,不直接惊动主人,
 *  所以宁可多认一点。词汇来自 lib/auth-failure,不再自己写一份。
 *  仍然导出:诊断采集要如实调用它本体(见 diagnostics/failure-shapes)。 */
export const LLM_HEALTH_AUTH_RE = { test: (t: string) => looksLikeAuthFailure(t) }
const AUTH_RE = LLM_HEALTH_AUTH_RE

export function makeLlmHealth(deps: LlmHealthDeps): LlmHealth {
  const timeoutMs = deps.timeoutMs ?? 45_000
  const now = deps.now ?? (() => Date.now())
  let cached: LlmHealthReport | null = null
  let inFlight: Promise<LlmHealthReport> | null = null

  async function probeOne(id: ProviderId): Promise<LlmProbeResult> {
    const entry = deps.registry.get(id)
    const fn = entry?.provider.cheapEval ?? entry?.provider.strongEval
    if (!fn) return { provider: id, ok: null, latency_ms: 0, error: 'no_probe_surface' }
    const start = now()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const r = await Promise.race([
        fn(PROBE_PROMPT),
        new Promise<typeof TIMEOUT_SENTINEL>(resolve => { timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs) }),
      ])
      if (r === TIMEOUT_SENTINEL) {
        return { provider: id, ok: false, latency_ms: now() - start, error: 'timeout' }
      }
      return { provider: id, ok: true, latency_ms: now() - start }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const auth = AUTH_RE.test(msg)
      const hint = auth ? deps.hintFor?.(id) : undefined
      return {
        provider: id, ok: false, latency_ms: now() - start,
        error: msg.slice(0, 200), auth_failed: auth,
        ...(hint ? { hint } : {}),
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  async function runProbe(): Promise<LlmHealthReport> {
    const results = await Promise.all(deps.registry.list().map(probeOne))
    const report: LlmHealthReport = {
      checked_at: new Date().toISOString(),
      default_provider: deps.defaultProviderId,
      results,
    }
    for (const r of results) {
      if (r.ok === false) deps.log('LLM_HEALTH', `${r.provider}: ${r.auth_failed ? 'AUTH FAILED' : r.error}`)
    }
    cached = report
    return report
  }

  return {
    cached() {
      return cached
    },
    async dial() {
      // Coalesce concurrent callers onto one dial round.
      if (!inFlight) {
        inFlight = runProbe().finally(() => { inFlight = null })
      }
      return inFlight
    },
  }
}
