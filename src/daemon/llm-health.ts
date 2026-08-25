/**
 * llm-health.ts — the LLM-channel physical (2026-08-25, owner: 「用户绑定
 * wechat,通道肯定 ok,但 cc 调用 llm 通道,是否能检测呢?」).
 *
 * The dashboard's 「连接正常」 only proves the WECHAT side (ilink heartbeat).
 * The brain side — claude/codex/cursor/agy auth — could be dead and nothing
 * showed it until a user message failed. This module actually DIALS each
 * registered provider (one tiny cheapEval, 「只回复:ok」) and classifies:
 *   ok           — round-trip succeeded (latency recorded)
 *   auth_failed  — credentials stale; `hint` carries the provider's own
 *                  fix-it line (capability's authFailHint, e.g. 「跑一次
 *                  cursor-agent login」)
 *   timeout      — no answer within timeoutMs
 *   error        — anything else (binary missing, network, …)
 *   ok:null      — provider exposes no eval surface to probe (untested)
 *
 * Cost control: results are cached (default 5 min) — the desktop can poll
 * freely; a real re-dial happens only on TTL lapse or an explicit
 * fresh=true (the 「体检」 button).
 */
import type { ProviderId } from '../core/conversation'

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
  ttlMs?: number
  now?: () => number
  log: (tag: string, line: string) => void
}

export interface LlmHealth {
  probe(fresh: boolean): Promise<LlmHealthReport>
}

const PROBE_PROMPT = '只回复两个字母:ok'
const TIMEOUT_SENTINEL: unique symbol = Symbol('llm-probe-timeout')

const AUTH_RE = /auth_failed|not logged in|login required|credential|unauthenticated|请.*登录/i

export function makeLlmHealth(deps: LlmHealthDeps): LlmHealth {
  const timeoutMs = deps.timeoutMs ?? 45_000
  const ttlMs = deps.ttlMs ?? 5 * 60_000
  const now = deps.now ?? (() => Date.now())
  let cached: { at: number; report: LlmHealthReport } | null = null
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
    cached = { at: now(), report }
    return report
  }

  return {
    async probe(fresh) {
      if (!fresh && cached && now() - cached.at < ttlMs) return cached.report
      // Coalesce concurrent callers onto one dial round.
      if (!inFlight) {
        inFlight = runProbe().finally(() => { inFlight = null })
      }
      return inFlight
    },
  }
}
