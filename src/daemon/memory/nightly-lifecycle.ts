/** 每晚记忆整理的定时器:15 分钟看一次「该不该跑」,由 main.ts 挂载(2026-09-25)。 */
import { startCompanionScheduler } from '../companion/scheduler'
import type { Lifecycle } from '../../lib/lifecycle'
import type { MemoryNightlyRuntime } from './nightly-runtime'

export function registerMemoryNightly(d: {
  runtime: MemoryNightlyRuntime
  holdBusy?: (label: string) => () => void
  log: (tag: string, line: string) => void
  intervalMs?: number
}): Lifecycle {
  const scheduler = startCompanionScheduler({
    name: 'memory-nightly', intervalMs: d.intervalMs ?? 15 * 60_000, jitterRatio: 0,
    shouldRun: () => true, onTick: () => d.runtime.tick(), log: d.log,
    ...(d.holdBusy ? { holdBusy: d.holdBusy } : {}),
  })
  let stopped = false
  return { name: 'memory-nightly', stop: async () => { if (!stopped) { stopped = true; await scheduler.stop() } } }
}
