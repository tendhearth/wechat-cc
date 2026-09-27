// 从 cli.ts 逐字搬出的四个纯函数(2026-09-27 cli 拆分 Task 1),行为不变。
export function parseBoolValue(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined
  if (value === 'true' || value === '1' || value === 'yes' || value === 'on') return true
  if (value === 'false' || value === '0' || value === 'no' || value === 'off') return false
  return undefined
}

export function parseTimeoutMsFlag(raw: unknown): { ok: true; value?: number } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true }
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, error: `invalid value: ${String(raw)} (expected a positive number of milliseconds)` }
  }
  return { ok: true, value }
}

export function parseBudgetUsdFlag(raw: unknown): { ok: true; value?: number } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true }
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, error: `invalid value: ${String(raw)} (expected a positive number of dollars)` }
  }
  return { ok: true, value }
}

export function parseCountFlag(raw: unknown, min: number): { ok: true; value?: number } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true }
  const value = Number(raw)
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min) {
    return { ok: false, error: `invalid value: ${String(raw)} (expected an integer ≥ ${min})` }
  }
  return { ok: true, value }
}
