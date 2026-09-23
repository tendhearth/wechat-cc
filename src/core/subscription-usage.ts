/**
 * subscription-usage — 订阅类执行者(Claude Code / Codex)的**真实**额度窗口。
 *
 * 2026-09-16 之前 provider-quota.ts 只能从失败文本里"认出"额度耗尽;主人指出这是可以
 * 直接读到的,当天真机验证:
 *   - Codex:`codex app-server` 的 JSON-RPC `account/rateLimits/read`(不用碰 OAuth token)
 *     → primary / secondary 窗口的 usedPercent / windowDurationMins / resetsAt,以及 planType。
 *   - Claude:Claude Code 自己登录的 OAuth 凭据(macOS Keychain `Claude Code-credentials`,
 *     否则 `~/.claude/.credentials.json`)→ `GET https://api.anthropic.com/api/oauth/usage`
 *     (`anthropic-beta: oauth-2025-04-20`)→ five_hour / seven_day 的 utilization / resets_at。
 * 两条都不是厂商对第三方承诺稳定的公开 API:解析全部宽松、失败一律 null,绝不把凭据写进
 * 日志或错误信息。本文件只做解析、凭据读取与带 TTL 的缓存;I/O 全部注入。
 */
export type UsageProviderId = 'claude' | 'codex'
export interface UsageWindow { name: string; usedPercent: number; resetsAt: number | null; durationMins: number | null }
export interface UsageSnapshot { providerId: UsageProviderId; plan: string | null; windows: UsageWindow[]; exhausted: boolean; fetchedAt: number }

const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null
const obj = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
const windowName = (mins: number | null): string => mins === null ? 'window' : mins <= 300 ? '5h' : mins >= 10080 ? 'weekly' : `${Math.round(mins / 60)}h`
/** Codex 的 resetsAt 是 unix 秒;Claude 的 resets_at 是 ISO 字符串。都转成毫秒。 */
const epochMs = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isFinite(t) ? t : null }
  return null
}
const exhaustedBy = (windows: UsageWindow[], now: number): boolean => windows.some(w => w.usedPercent >= 100 && (w.resetsAt === null || w.resetsAt > now))

/** `account/rateLimits/read` 的 result → 快照。只看顶层 limit(细分模型的 rateLimitsByLimitId 先不展示)。 */
export function parseCodexRateLimits(result: unknown, now: number): UsageSnapshot {
  const limits = obj(obj(result)?.rateLimits)
  const windows: UsageWindow[] = []
  for (const key of ['primary', 'secondary'] as const) {
    const w = obj(limits?.[key]); if (!w) continue
    const used = num(w.usedPercent); if (used === null) continue
    const mins = num(w.windowDurationMins)
    windows.push({ name: windowName(mins), usedPercent: used, resetsAt: epochMs(w.resetsAt), durationMins: mins })
  }
  const plan = typeof limits?.planType === 'string' ? limits.planType : null
  return { providerId: 'codex', plan, windows, exhausted: exhaustedBy(windows, now), fetchedAt: now }
}

/** `/api/oauth/usage` 的 body → 快照。只认 five_hour / seven_day;其余键(实验、null)忽略。 */
export function parseClaudeUsage(body: unknown, now: number, plan: string | null): UsageSnapshot {
  const b = obj(body)
  const windows: UsageWindow[] = []
  for (const [key, name, mins] of [['five_hour', '5h', 300], ['seven_day', 'weekly', 10080]] as const) {
    const w = obj(b?.[key]); if (!w) continue
    const used = num(w.utilization); if (used === null) continue
    windows.push({ name, usedPercent: used, resetsAt: epochMs(w.resets_at), durationMins: mins })
  }
  return { providerId: 'claude', plan, windows, exhausted: exhaustedBy(windows, now), fetchedAt: now }
}

export interface ClaudeCredentialDeps {
  platform: NodeJS.Platform
  /** macOS:`security find-generic-password -s "Claude Code-credentials" -w` 的输出。 */
  keychain: () => string
  /** 其他平台:~/.claude/.credentials.json 的内容。 */
  readFile: () => string
  now: () => number
}
/** 读 Claude Code 的 OAuth access token(只在内存里过一下);过期的当没有 —— Claude Code 自己会刷新。 */
export function readClaudeOAuthToken(deps: ClaudeCredentialDeps): { token: string; plan: string | null } | null {
  let raw = ''
  if (deps.platform === 'darwin') { try { raw = deps.keychain() } catch { raw = '' } }
  if (!raw.trim()) { try { raw = deps.readFile() } catch { return null } }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return null }
  const oauth = obj(obj(parsed)?.claudeAiOauth) ?? obj(parsed)
  const token = oauth?.accessToken
  if (typeof token !== 'string' || !token) return null
  const expiresAt = num(oauth?.expiresAt)
  if (expiresAt !== null && expiresAt <= deps.now()) return null
  return { token, plan: typeof oauth?.subscriptionType === 'string' ? oauth.subscriptionType : null }
}

export interface UsageMonitorDeps {
  sources: Partial<Record<UsageProviderId, () => Promise<UsageSnapshot | null>>>
  ttlMs?: number
  now?: () => number
}
export interface UsageMonitor {
  /** 缓存新鲜就直接给;过期或没有就去取(取失败 → null,不抛)。 */
  get(providerId: UsageProviderId): Promise<UsageSnapshot | null>
  /** 同步取缓存(哪怕过期),过期时顺手在后台刷新。给同步的登记处 / 列表用。 */
  cached(providerId: UsageProviderId): UsageSnapshot | null
}
export function makeUsageMonitor(deps: UsageMonitorDeps): UsageMonitor {
  const now = deps.now ?? Date.now, ttl = deps.ttlMs ?? 60_000
  const cache = new Map<UsageProviderId, UsageSnapshot>()
  const inflight = new Map<UsageProviderId, Promise<UsageSnapshot | null>>()
  const fresh = (id: UsageProviderId): UsageSnapshot | null => { const s = cache.get(id); return s && now() - s.fetchedAt < ttl ? s : null }
  const refresh = (id: UsageProviderId): Promise<UsageSnapshot | null> => {
    const running = inflight.get(id); if (running) return running
    const source = deps.sources[id]
    if (!source) return Promise.resolve(null)
    const p = (async () => {
      try { const s = await source(); if (s) cache.set(id, s); return s ?? cache.get(id) ?? null }
      catch { return cache.get(id) ?? null }
      finally { inflight.delete(id) }
    })()
    inflight.set(id, p)
    return p
  }
  return {
    get: id => { const s = fresh(id); return s ? Promise.resolve(s) : refresh(id) },
    cached: id => { const s = cache.get(id) ?? null; if (!fresh(id) && deps.sources[id]) void refresh(id); return s },
  }
}
