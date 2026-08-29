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
// 确认的 auth 失败(登录过期)不会自愈,用更长冷却,少做无用重试。
// 只认 `auth_failed:` 前缀 —— 这是 assertNotAuthFailed 在 isAuthFail 确认
// 真登录问题后才加的确定信号。刻意不匹配裸 "authentication failed":agy
// CLI 把认证与超时打包成 "authentication failed or timed out"(2026-08-27:
// owner 确认 agy 能登录,这条其实是网络/超时,和同期 getUpdates cert /
// 隧道 churn 同源),那是瞬时错误,该走短冷却自愈,不能误判成登录过期。
const CHEAP_EVAL_AUTH_COOLDOWN_MS = 60 * 60_000
function isAuthError(err: unknown): boolean {
  return err instanceof Error && /auth_failed\b/i.test(err.message)
}

export function createProviderRegistry(opts?: {
  now?: () => number
  /**
   * 显式指定 cheapEval 的 provider (agent-config `cheap_eval_provider`)。
   * 外部集成反馈 #2 (2026-08-26):openai 在偏好序第一,配置 openai-compatible
   * provider 即静默劫持全部后台评估(记忆整理/moderator/introspect)——当
   * base_url 指向特化本地服务时,内部评估要么得到无意义回答、要么把费用记
   * 到意外的账上。指定后只用它(不参与 failover 轮替);未指定保持原偏好序。
   */
  cheapEvalProvider?: string
  /**
   * 后台 cheapEval 的网络预检(2026-08-29):开机 0.2s 的 introspect 补跑
   * 曾在代理未就绪时 spawn agy → agy 刷 token 撞超时 → 弹浏览器 OAuth 页。
   * failover 试某候选前先问一句「它的端点可达吗」,不可达直接跳过(不入
   * 冷却——网络恢复即重试),落到下一家。预检自身抛错按可达处理(fail-
   * open,探测机器坏了不能反过来卡死评估)。不影响 llm-health 的用户主动
   * 真拨(那条路直接调各 provider 的 cheapEval,不走这里)。daemon 侧用
   * net-probe 的端点表包一个带 TTL 缓存的实现注入;core 保持纯净。
   */
  cheapEvalPreflight?: (id: string) => Promise<boolean>
  log?: (line: string) => void
}): ProviderRegistry {
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
      // 显式指定优先 — 见 opts.cheapEvalProvider 文档。
      if (opts?.cheapEvalProvider) {
        const pinned = entries.get(opts.cheapEvalProvider as ProviderId)?.provider.cheapEval
        if (pinned) return pinned
        opts.log?.(`cheap_eval_provider=${opts.cheapEvalProvider} 未注册或无 cheapEval — 回落偏好序`)
      }
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
        let preflightSkipped = 0
        for (const c of candidates) {
          const until = cheapEvalCooldownUntil.get(c.id) ?? 0
          if (until > now()) continue
          if (opts?.cheapEvalPreflight) {
            let reachable = true
            try {
              reachable = await opts.cheapEvalPreflight(c.id)
            } catch {
              // fail-open: a broken probe must never block evals
            }
            if (!reachable) {
              preflightSkipped++
              opts.log?.(`cheapEval preflight: ${c.id} 端点不可达 — 跳过(不入冷却)`)
              continue
            }
          }
          attempted++
          try {
            return await c.fn(prompt)
          } catch (err) {
            const cd = isAuthError(err) ? CHEAP_EVAL_AUTH_COOLDOWN_MS : CHEAP_EVAL_COOLDOWN_MS
            cheapEvalCooldownUntil.set(c.id, now() + cd)
            lastErr = err
          }
        }
        if (attempted === 0) {
          // 网络预检把所有人都拦了 → 抛错让调用方按「本轮失败,下轮重试」
          // 处理(所有后台 judge 都有这个姿势),绝不硬闯——硬闯正是要防
          // 的那次 agy spawn。
          if (preflightSkipped > 0) {
            throw new Error('no reachable cheapEval provider (network preflight)')
          }
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
