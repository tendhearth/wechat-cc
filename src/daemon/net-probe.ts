/**
 * net-probe.ts — 排障前置的网络体检 (2026-08-26, owner: 有些 provider 不能
 * 直接连,要先看网络访问质量,类似 ip111 那种前置).
 *
 * 国内环境下 provider 连不上,大多数时候是「国际出口不通(代理没开)」而
 * 不是「登录过期」——两者的修复指引完全不同,排障第一步必须先分清。
 *
 * 在 DAEMON 侧测(不是 webview):daemon 才是真正发 LLM 请求的进程,它的
 * 网络视角才算数。只做 HTTPS 可达性(HEAD,任何 HTTP 响应都算通,4xx 也
 * 是通——TCP/TLS 都握上了),不带 key、不调真实 API:零费用、零风险。
 * 触发一律来自用户点击(与「不自动外呼」红线同一姿态,虽然这里探测的
 * 是普通网站不是微信)。
 */

export interface ProbeTarget { id: string; label: string; url: string }
export interface ProbeResult { id: string; label: string; ok: boolean; latency_ms: number; status?: number }

const BASELINES: ProbeTarget[] = [
  { id: 'baseline_cn', label: '基础网络', url: 'https://www.baidu.com' },
  { id: 'internet', label: '国际访问', url: 'https://www.google.com/generate_204' },
]

/** provider id → 它真正要连的 API 域。codex 走 openai 端点;agy 走 google。 */
const PROVIDER_ENDPOINTS: Record<string, ProbeTarget> = {
  claude: { id: 'anthropic', label: 'Anthropic(Claude)', url: 'https://api.anthropic.com' },
  codex: { id: 'openai', label: 'OpenAI(Codex)', url: 'https://api.openai.com' },
  openai: { id: 'openai', label: 'OpenAI(Codex)', url: 'https://api.openai.com' },
  agy: { id: 'google_ai', label: 'Google AI(Gemini)', url: 'https://generativelanguage.googleapis.com' },
  gemini: { id: 'google_ai', label: 'Google AI(Gemini)', url: 'https://generativelanguage.googleapis.com' },
  cursor: { id: 'cursor', label: 'Cursor', url: 'https://cursor.com' },
}

/** 基线永远测;provider 端点按已注册列表选,去重。 */
export function probeTargetsFor(registered: string[]): ProbeTarget[] {
  const targets = [...BASELINES]
  const seen = new Set(targets.map(t => t.id))
  for (const pid of registered) {
    const ep = PROVIDER_ENDPOINTS[pid]
    if (ep && !seen.has(ep.id)) { seen.add(ep.id); targets.push(ep) }
  }
  return targets
}

const PROBE_TIMEOUT_MS = 6000

export async function runNetProbe(
  targets: ProbeTarget[],
  deps?: {
    fetcher?: (url: string, signal: AbortSignal) => Promise<{ status: number }>
    now?: () => number
  },
): Promise<ProbeResult[]> {
  const now = deps?.now ?? (() => Date.now())
  const fetcher = deps?.fetcher ?? (async (url: string, signal: AbortSignal) => {
    const r = await fetch(url, { method: 'HEAD', signal, redirect: 'manual' })
    return { status: r.status }
  })
  return Promise.all(targets.map(async (t): Promise<ProbeResult> => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
    const started = now()
    try {
      const r = await fetcher(t.url, ctrl.signal)
      return { id: t.id, label: t.label, ok: true, latency_ms: Math.max(0, now() - started), status: r.status }
    } catch {
      return { id: t.id, label: t.label, ok: false, latency_ms: Math.max(0, now() - started) }
    } finally {
      clearTimeout(timer)
    }
  }))
}

export type NetVerdict = 'ok' | 'no_international' | 'offline'

/** 排障结论:国际通 → 网络不背锅;国内通国际不通 → 十有八九是代理;全不通 → 断网。 */
export function verdictOf(results: ProbeResult[]): NetVerdict {
  const cn = results.find(r => r.id === 'baseline_cn')?.ok ?? false
  const intl = results.find(r => r.id === 'internet')?.ok ?? false
  if (intl) return 'ok'
  if (cn) return 'no_international'
  return 'offline'
}
