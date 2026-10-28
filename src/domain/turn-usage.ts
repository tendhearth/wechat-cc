/**
 * 每件事花了多少额度(第二轮对标 ★3,对标 Devin 的 per-session 用量):只记执行者自己在一轮结束时报的数,
 * 不估、不另外发请求。拿不准是不是累计的就只记 token、不记钱(cost 留空 ⇒ 界面写「这家不报」,不写 0)。
 */
export interface TurnUsage { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number; costUsd?: number }
export interface UsageTotals { turns: number; input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null; reasoning: number | null; costUsd: number | null }
const KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const
const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : undefined)
const clean = (u: TurnUsage): TurnUsage | undefined => {
  const out: TurnUsage = {}
  for (const k of [...KEYS, 'costUsd'] as const) { const v = n(u[k]); if (v !== undefined) out[k] = v }
  return Object.keys(out).length ? out : undefined
}

/** Claude SDK 的 result.usage(只取 token;total_cost_usd 在常驻会话里可能是累计的,不记)。 */
export function claudeResultUsage(u: unknown): TurnUsage | undefined {
  if (!u || typeof u !== 'object') return undefined
  const o = u as Record<string, unknown>
  return clean({ input: n(o.input_tokens), output: n(o.output_tokens), cacheRead: n(o.cache_read_input_tokens), cacheWrite: n(o.cache_creation_input_tokens) } as TurnUsage)
}

/** Codex app-server 的 TokenUsageBreakdown。 */
export function codexBreakdown(b: unknown): TurnUsage | undefined {
  if (!b || typeof b !== 'object') return undefined
  const o = b as Record<string, unknown>
  return clean({ input: n(o.inputTokens), output: n(o.outputTokens), cacheRead: n(o.cachedInputTokens), cacheWrite: n(o.cacheWriteInputTokens), reasoning: n(o.reasoningOutputTokens) } as TurnUsage)
}

/** 累计值 ⇒ 这一段的量。任何一项变小(会话重启 / 续接从 0 算起)⇒ 新的一段,直接用新的总数,不记负数。 */
/** openai 兼容(AI SDK v5 的 LanguageModelV2Usage):每一步(一次请求)自己的用量。 */
export function aiSdkUsage(u: unknown): TurnUsage | undefined {
  if (!u || typeof u !== 'object') return undefined
  const o = u as Record<string, unknown>
  return clean({ input: n(o.inputTokens), output: n(o.outputTokens), cacheRead: n(o.cachedInputTokens), reasoning: n(o.reasoningTokens) } as TurnUsage)
}

export function usageDelta(before: TurnUsage | undefined, after: TurnUsage | undefined): TurnUsage | undefined {
  if (!after) return undefined
  if (!before) return clean(after)
  if (KEYS.some(k => after[k] !== undefined && before[k] !== undefined && after[k]! < before[k]!)) return clean(after)
  const out: TurnUsage = {}
  for (const k of KEYS) if (after[k] !== undefined) out[k] = after[k]! - (before[k] ?? 0)
  return clean(out)
}

/** 两份用量相加(同一轮里多次调用);某一项两边都没有 ⇒ 仍然没有。 */
export function sumTurnUsage(a: TurnUsage | undefined, b: TurnUsage): TurnUsage {
  const out: TurnUsage = { ...(a ?? {}) }
  for (const k of [...KEYS, 'costUsd'] as const) if (b[k] !== undefined) out[k] = (out[k] ?? 0) + b[k]!
  return out
}

/** 合计:某一项一轮都没报 ⇒ null(「这家不报」),不是 0。 */
export function sumUsage(rows: TurnUsage[]): UsageTotals {
  const total: UsageTotals = { turns: rows.length, input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null, costUsd: null }
  for (const r of rows) for (const k of [...KEYS, 'costUsd'] as const) if (r[k] !== undefined) total[k] = (total[k] ?? 0) + r[k]!
  return total
}
