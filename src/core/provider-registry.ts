/**
 * provider-registry — central catalogue of available agent providers
 * (RFC 03 §3.3, Appendix D).
 *
 * Daemon registers `claude` and `codex` at boot; coordinator looks up
 * by ProviderId when dispatching. Adding a new provider in the future
 * is a single `registry.register(id, provider, opts)` call from
 * bootstrap.ts — no changes to Conversation/Mode/Coordinator/SessionManager
 * (the open string ProviderId design from §3.3 makes this work).
 *
 * The registry is intentionally not a singleton; it's constructed and
 * passed via deps. Tests can build their own with mock providers.
 */
import type { AgentProvider, CheapEval } from './agent-provider'
import type { ProviderId } from './conversation'

export interface ProviderRegistration {
  /** Human-readable name; used by mode-commands prompts and dashboard. */
  displayName: string
  /**
   * Returns true if a stored thread/session id can still be resumed
   * (i.e. the provider's on-disk transcript is intact). SessionManager
   * checks this before passing a stale resume id to the SDK.
   */
  canResume: (cwd: string, threadId: string) => boolean
}

export interface ProviderRegistry {
  register(id: ProviderId, provider: AgentProvider, opts: ProviderRegistration): void
  get(id: ProviderId): { provider: AgentProvider; opts: ProviderRegistration } | null
  has(id: ProviderId): boolean
  list(): ProviderId[]
  /**
   * Resolve a cheapEval callback from registered providers, picked by
   * cost-tier preference (cheapest first). Returns null if no registered
   * provider implements cheapEval. Caller is provider-agnostic — let
   * the registry decide which provider runs the one-shot eval.
   *
   * Preference order is hardcoded inside the resolver because cost
   * comparison is fundamentally cross-provider (we can't compare
   * Anthropic's haiku to OpenAI's mini purely from interface metadata).
   */
  getCheapEval(): CheapEval | null
  /**
   * Resolve the STRONG one-shot eval of a SPECIFIC provider (the default
   * provider, for the /chat verdict) — unlike getCheapEval, no cross-provider
   * cost picking. Returns null if that provider isn't registered or doesn't
   * implement strongEval; caller falls back to getCheapEval().
   */
  getStrongEval(id: ProviderId): CheapEval | null
}

// Cheapest known to most expensive. Claude haiku ≈ $0.001/1K input tokens
// and ~1s latency via in-process SDK; Codex mini ≈ $0.002/1K and ~3-5s
// per call (CLI subprocess overhead). agy rides Google AI Pro subscription
// quota (no per-token API cost) — spec §2 slots it after openai, before
// claude. Future providers append here.
const CHEAP_EVAL_PREFERENCE: ProviderId[] = ['openai', 'agy', 'claude', 'codex', 'gemini']

/** How long a cheapEval provider sits out after throwing. Long enough to
 *  stop hammering a dead credential every 25-minute ingest cycle, short
 *  enough that a re-login is picked up within minutes. */
const CHEAP_EVAL_COOLDOWN_MS = 10 * 60_000

export function createProviderRegistry(opts?: { now?: () => number }): ProviderRegistry {
  const now = opts?.now ?? Date.now
  const entries = new Map<ProviderId, { provider: AgentProvider; opts: ProviderRegistration }>()
  // cheapEval failover state — per-registry (= per-daemon-lifetime), never persisted.
  const cheapEvalCooldownUntil = new Map<ProviderId, number>()
  const registry: ProviderRegistry = {
    register(id, provider, opts) {
      if (entries.has(id)) throw new Error(`provider already registered: ${id}`)
      entries.set(id, { provider, opts })
    },
    get(id) {
      return entries.get(id) ?? null
    },
    has(id) {
      return entries.has(id)
    },
    list() {
      return Array.from(entries.keys())
    },
    getCheapEval() {
      // Preferred order first, then any other registered provider. The
      // implementations are arrow-like (close over `opts`, never `this`),
      // so calling them unbound is safe.
      const candidates: Array<{ id: ProviderId; fn: CheapEval }> = []
      for (const id of CHEAP_EVAL_PREFERENCE) {
        const ce = entries.get(id)?.provider.cheapEval
        if (ce) candidates.push({ id, fn: ce })
      }
      for (const [id, entry] of entries) {
        if (CHEAP_EVAL_PREFERENCE.includes(id)) continue
        if (entry.provider.cheapEval) candidates.push({ id, fn: entry.provider.cheapEval })
      }
      if (candidates.length === 0) return null
      if (candidates.length === 1) return candidates[0]!.fn

      // Runtime failover (2026-08-24): the static preference order once froze
      // the entire ingest pipeline — agy sat at slot 2 with a dead credential
      // and every extract/judge call failed for hours without ever trying the
      // healthy providers behind it. A throwing provider goes on cooldown and
      // the call falls through; only when EVERY candidate fails does the
      // error propagate (callers' watermark-preserving retry semantics rely
      // on that).
      return async (prompt: string) => {
        let lastErr: unknown = new Error('no cheapEval provider available')
        let attempted = 0
        for (const c of candidates) {
          const until = cheapEvalCooldownUntil.get(c.id) ?? 0
          if (until > now()) continue
          attempted++
          try {
            return await c.fn(prompt)
          } catch (err) {
            cheapEvalCooldownUntil.set(c.id, now() + CHEAP_EVAL_COOLDOWN_MS)
            lastErr = err
          }
        }
        if (attempted === 0) {
          // Everyone is cooling down — try the first candidate anyway rather
          // than failing on a stale blacklist.
          cheapEvalCooldownUntil.delete(candidates[0]!.id)
          return candidates[0]!.fn(prompt)
        }
        throw lastErr
      }
    },
    getStrongEval(id) {
      return entries.get(id)?.provider.strongEval ?? null
    },
  }
  return registry
}
