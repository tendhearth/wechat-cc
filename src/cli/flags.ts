// 从 cli.ts 逐字搬出的四个纯函数(2026-09-27 cli 拆分 Task 1),行为不变。
export function parseBoolValue(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined
  if (value === 'true' || value === '1' || value === 'yes' || value === 'on') return true
  if (value === 'false' || value === '0' || value === 'no' || value === 'off') return false
  return undefined
}

/**
 * `--timeout-ms` / `--health-timeout-ms` 的解析(自维护三件套共用)。
 *
 * WHY 不再用 `Number(x)` + `Number.isFinite` 悄悄兜底:`--timeout-ms abc`
 * 以前是 NaN ⇒ 当成「没传」⇒ 按缺省值跑完一整轮真机自检,人以为自己设了
 * 30 秒上限,其实等了四分钟。`--timeout-ms 0` / 负数同理(缺省顶上)。
 * 数值开关写错了就当场报错退 1,别替用户猜。
 */
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

/** `--max-reruns` / `--timeout-min` 这类计数开关:写错了当场报错,别替用户猜。 */
export function parseCountFlag(raw: unknown, min: number): { ok: true; value?: number } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true }
  const value = Number(raw)
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min) {
    return { ok: false, error: `invalid value: ${String(raw)} (expected an integer ≥ ${min})` }
  }
  return { ok: true, value }
}
