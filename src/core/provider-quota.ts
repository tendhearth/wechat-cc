/**
 * provider-quota — 执行者的额度/限流:从失败里认出来、记住、再主动避开。
 *
 * WHY(owner 2026-09-16):Codex 额度耗尽把一个任务打成 failed,主人在微信端零感知,
 * 管家还接着往它送要求。订阅类 CLI 没有可编程的用量口子(`codex` 只有 login/doctor,
 * `claude` 的 /usage 只在交互 TUI 里),网关的共享 key 也不报额度 —— 所以能做的是:
 * 认出"额度耗尽"和"限流"两类错误文本,按 provider 登记,带 TTL(Claude 的错误里
 * 常带重置时间戳,优先用它),让管家和 health 都能问一句"这家现在还能用吗"。
 *
 * 纯函数 + 内存登记处,零 I/O,时钟注入。
 */
export type QuotaKind = 'quota' | 'rate_limit'
export interface QuotaState { kind: QuotaKind; since: number; resetAt: number; message: string }

/** 额度耗尽默认按一小时算;订阅的滚动窗口通常以小时计,主人回来看到的"约 N 分钟后再试"宁可偏长。 */
export const QUOTA_TTL_MS = 60 * 60_000
/** 限流是分钟级的事。 */
export const RATE_LIMIT_TTL_MS = 5 * 60_000

const QUOTA = [
  /hit your usage limit/i, /reached your usage limit/i, /usage limit reached/i,
  /insufficient_quota/i, /exceeded your current quota/i, /quota exceeded/i, /out of credits/i, /credit balance is too low/i,
]
const RATE = [/rate.?limit/i, /\b429\b/, /too many requests/i, /overloaded/i]

export function classifyProviderError(text: string): QuotaKind | null {
  const t = (text ?? '').trim()
  if (!t) return null
  if (QUOTA.some(re => re.test(t))) return 'quota'
  if (RATE.some(re => re.test(t))) return 'rate_limit'
  return null
}

/** Claude Code 的额度错误形如 `Claude AI usage limit reached|<unix 秒>`;能读到就用它当重置时刻。 */
export function parseResetAt(text: string): number | null {
  const m = /\|(\d{9,13})\b/.exec(text)
  if (!m) return null
  const n = Number(m[1])
  return n < 1e12 ? n * 1000 : n
}

/**
 * 真实额度快照(subscription-usage.ts)接进来:窗口到 100% 就等于"耗尽",不用等任务失败。
 * 同步接口,给的是缓存(监视器自己在后台刷新)。
 */
export type UsageLookup = (providerId: string) => { exhausted: boolean; windows: Array<{ name: string; usedPercent: number; resetsAt: number | null }> } | null

export function makeQuotaRegistry(now: () => number = Date.now, usage?: UsageLookup) {
  const states = new Map<string, QuotaState>()
  const fromUsage = (id: string): QuotaState | null => {
    const s = usage?.(id)
    if (!s?.exhausted) return null
    const w = s.windows.find(w => w.usedPercent >= 100) ?? s.windows[0]
    const resetAt = w?.resetsAt ?? now() + QUOTA_TTL_MS
    if (resetAt <= now()) return null
    return { kind: 'quota', since: now(), resetAt, message: w ? `${w.name} 窗口已用 ${Math.round(w.usedPercent)}%` : '额度已用完' }
  }
  const live = (id: string): QuotaState | null => {
    const s = states.get(id)
    if (s && s.resetAt <= now()) states.delete(id)
    return (s && s.resetAt > now() ? s : null) ?? fromUsage(id)
  }
  return {
    /** 认出额度/限流就登记并返回类别;不是就返回 null、不登记。 */
    note(providerId: string, message: string): QuotaKind | null {
      const kind = classifyProviderError(message)
      if (!kind) return null
      const since = now()
      const resetAt = (kind === 'quota' ? parseResetAt(message) : null) ?? since + (kind === 'quota' ? QUOTA_TTL_MS : RATE_LIMIT_TTL_MS)
      states.set(providerId, { kind, since, resetAt, message: message.trim().slice(0, 300) })
      return kind
    },
    exhausted: (providerId: string): QuotaState | null => live(providerId),
    /** 一次成功回合 ⇒ 这家(从错误里认出的那份)恢复了;真实快照说耗尽的照旧耗尽。 */
    clear(providerId: string) { states.delete(providerId) },
    snapshot(): Record<string, QuotaState> {
      const out: Record<string, QuotaState> = {}
      for (const id of new Set([...states.keys(), 'claude', 'codex'])) { const s = live(id); if (s) out[id] = s }
      return out
    },
  }
}
export type QuotaRegistry = ReturnType<typeof makeQuotaRegistry>
