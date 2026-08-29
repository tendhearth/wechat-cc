/**
 * cheap-eval-preflight — 后台 cheapEval 的网络预检实现(2026-08-29)。
 *
 * 注入给 provider-registry 的 `cheapEvalPreflight` 缝(core 保持纯净,
 * 端点知识在 daemon 侧)。背景:开机 0.2s 的 introspect 补跑在代理未就绪
 * 时 spawn agy → agy 刷 OAuth token 撞网络超时 → print 模式误触交互式
 * OAuth、弹浏览器 Google 登录页(用户以为登录丢了,反复"重新登录")。
 *
 * 姿势与 net-probe 一致:HEAD 探 provider 的 API origin,任何 HTTP 响应
 * (4xx 也算)= TCP/TLS 握上了 = 可达;网络错误/超时 = 不可达。不带 key、
 * 不调真实 API,零费用。与「不自动外呼」ruling 的关系:这一次 HEAD 只在
 * 后台评估**本来就要发起**时出现,替掉的是一次完整的 CLI 冷启动 + OAuth
 * 往返——净效果是外呼更少,不是更多。
 *
 * 缓存按【端点】不按 provider(agy/gemini 共享 google 端点,一次探测两家
 * 受益):可达结果存 okTtl(默认 60s),不可达只存 failTtl(默认 15s)——
 * 网络恢复要尽快被看见。没有端点映射的 provider 一律放行(fail-open)。
 */
import { endpointFor } from '../net-probe'

export interface CheapEvalPreflightDeps {
  /** 自配 base_url(main.ts 同款晚绑定:目前只有 openai-compatible)。 */
  overrides?: () => Record<string, string>
  /** Test seam — 默认 HEAD fetch(redirect: manual,同 net-probe)。 */
  fetcher?: (url: string, signal: AbortSignal) => Promise<{ status: number }>
  now?: () => number
  okTtlMs?: number
  failTtlMs?: number
  timeoutMs?: number
  log?: (line: string) => void
}

const DEFAULT_OK_TTL_MS = 60_000
const DEFAULT_FAIL_TTL_MS = 15_000
const DEFAULT_TIMEOUT_MS = 3_000

export function makeCheapEvalPreflight(deps?: CheapEvalPreflightDeps): (id: string) => Promise<boolean> {
  const now = deps?.now ?? (() => Date.now())
  const okTtlMs = deps?.okTtlMs ?? DEFAULT_OK_TTL_MS
  const failTtlMs = deps?.failTtlMs ?? DEFAULT_FAIL_TTL_MS
  const timeoutMs = deps?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetcher = deps?.fetcher ?? (async (url: string, signal: AbortSignal) => {
    const r = await fetch(url, { method: 'HEAD', signal, redirect: 'manual' })
    return { status: r.status }
  })
  // endpoint url → { ok, until } (+ in-flight coalescing so一簇并发评估只探一次)
  const cache = new Map<string, { ok: boolean; until: number }>()
  const inFlight = new Map<string, Promise<boolean>>()

  async function probe(url: string): Promise<boolean> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      await fetcher(url, ctrl.signal)
      return true
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  return async (id: string): Promise<boolean> => {
    const ep = endpointFor(id, deps?.overrides?.())
    if (!ep) return true // 没有端点知识就不拦 — 让真实调用自己说话
    const cached = cache.get(ep.url)
    if (cached && cached.until > now()) return cached.ok
    const running = inFlight.get(ep.url)
    if (running) return running
    const p = (async () => {
      const ok = await probe(ep.url)
      cache.set(ep.url, { ok, until: now() + (ok ? okTtlMs : failTtlMs) })
      if (!ok) deps?.log?.(`preflight: ${ep.label} (${ep.url}) 不可达 — 后台评估暂避`)
      return ok
    })().finally(() => { inFlight.delete(ep.url) })
    inFlight.set(ep.url, p)
    return p
  }
}
