/**
 * wire-idle-sweep.ts — 每分钟一拍:空闲会话清扫 + 自重启检查。一个模块(架构终态 A2):定时器经 `ctx.interval`,
 * start 段才开始计时、关机由容器停(以前起了没人停,关机后还会清扫一个已经停掉的 SessionManager)。
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
import type { DaemonModule } from '../modules/container'

export const IDLE_SWEEP_MS = 60_000

export interface IdleSweepParts {
  sessionManager: { sweepIdle(): Promise<unknown> }
  /** 自重启那一项检查(self-restart 模块关着 / 没起 ⇒ null)。 */
  selfRestartCheck: () => ((() => Promise<void> | void) | null)
  log: (tag: string, line: string) => void
}

/** `parts` 在 init 时才拿(它要的东西在上游模块里)。 */
export function idleSweepModule(opts: { needs: readonly string[]; wants?: readonly string[] }, parts: (ctx: { get<T>(n: string): T; maybe<T>(n: string): T | null }) => IdleSweepParts): DaemonModule<void> {
  return {
    name: 'idle-sweep',
    needs: opts.needs,
    ...(opts.wants ? { wants: opts.wants } : {}),
    init(ctx) {
      const p = parts(ctx)
      ctx.interval('tick', IDLE_SWEEP_MS, () => {
        p.sessionManager.sweepIdle().catch(err => {
          p.log('IDLE_SWEEP', `error: ${err instanceof Error ? err.message : String(err)}`)
        })
        void p.selfRestartCheck()?.()
      })
    },
  }
}
