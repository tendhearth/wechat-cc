export const NOTEBOOK_DEFAULTS = {
  quietMs: 10 * 60_000,
  cooldownMs: 6 * 60 * 60_000,
  dailyLimit: 2,
  checkIntervalMs: 60 * 60_000,
  failureBaseMs: 60 * 60_000,
  failureMaxMs: 24 * 60 * 60_000,
  timeoutMs: 20_000,
  openingTimeoutMs: 3_000,
}
export type NotebookConfig = { [K in keyof typeof NOTEBOOK_DEFAULTS]: number }
