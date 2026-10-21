/**
 * wire-idle-sweep.ts — 每分钟一拍:空闲会话清扫 + 自重启检查。从 bootstrap/index.ts 搬出(复查 10-21),
 * 同时补上关机时停这个定时器(以前起了没人停,关机后还会清扫一个已经停掉的 SessionManager)。
 *
 * Periodic idle sweep — without this, idleEvictMs is dead config (the
 * method exists but was never called from production paths). 30 min of
 * inactivity is the limit before a session is dropped; the next dispatch
 * spawns a fresh subprocess that re-reads keychain credentials. Required
 * to avoid the long-running-daemon OAuth-staleness path that surfaces as
 * the claude binary streaming "Not logged in · Please run /login" as
 * assistant text. unref() so the timer never keeps the event loop alive
 * (matters for tests that build a real bootstrap and then exit).
 *
 * selfRestartCheck rides this SAME 60s tick (no new timer) — see the
 * self-restart block in index.ts. It swallows its own errors, so no .catch here.
 */
import type { BootstrapCtx } from './types'

export const IDLE_SWEEP_MS = 60_000

export function wireIdleSweep(
  ctx: Pick<BootstrapCtx, 'log' | 'teardown'>,
  parts: { sessionManager: { sweepIdle(): Promise<unknown> }; selfRestartCheck: (() => Promise<void> | void) | null },
): void {
  const timer = setInterval(() => {
    parts.sessionManager.sweepIdle().catch(err => {
      ctx.log('IDLE_SWEEP', `error: ${err instanceof Error ? err.message : String(err)}`)
    })
    void parts.selfRestartCheck?.()
  }, IDLE_SWEEP_MS)
  timer.unref()
  ctx.teardown.add('IDLE_SWEEP', 'timer', () => clearInterval(timer))
}
