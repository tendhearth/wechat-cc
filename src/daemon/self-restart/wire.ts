/**
 * self-restart 接线 —— 每个 tick 做一次"我是不是在跑旧代码"的检查。
 *
 * 挂在 bootstrap 里既有的 60 秒 idle-sweep timer 上,不新增定时器;触发的是
 * main.ts 既有的 requestRestart(优雅关闭 → exit(0) → launchd KeepAlive 重生),
 * 不新增重启机制。
 *
 * 危险的隐含假设(必须留下痕迹):整套机制成立的前提是 launchd plist 的
 * `KeepAlive` 是**布尔形式** `true` —— 干净退出(exit 0)也会被拉起。若哪天
 * 改成 `{ SuccessfulExit: false }` 字典形式,daemon 退出后**不会**被 launchd
 * 拉起,本机制会把主人的 bot 直接关掉而不是重启。
 *
 * 整个函数吞掉自己的一切异常:它跑在 daemon 的周期回调里,从这里抛出去会
 * 打断那个 tick 上的其它工作。
 */
import { shouldSelfRestart, BOOT_GRACE_MS } from './stale-code'
import { readGitHead, readGitLockfileBlob } from './git-head'

/** 空闲要求:最近这么久没有任何入站消息。 */
export const IDLE_QUIET_MS = 120_000

export interface SelfRestartDeps {
  cwd: string
  loadedHead: string | null
  now: () => number
  bootAtMs: number
  anyInFlight: () => boolean
  quietFor: (nowMs: number) => number
  requestRestart: () => void
  log: (tag: string, line: string) => void
  readHead?: typeof readGitHead
  /**
   * `bun.lock`'s blob hash at HEAD, captured once at THIS process's boot
   * (bootstrap/index.ts reads it alongside loadedHead). Task 3 review #2:
   * if this drifts from the current blob by check-time, HEAD moved AND the
   * lockfile changed — `bun install` may not have caught up with the new
   * dependency tree yet (the common case: a manual `git pull` outside
   * `wechat-cc update`, which does its own stop→install→start). Restarting
   * into a mismatched node_modules would crash-loop under launchd's
   * KeepAlive until install finishes. `null` (unreadable at boot) makes the
   * guard below refuse to restart forever — same "can't prove it's safe ⇒
   * don't move" posture as `loadedHead === null`.
   */
  bootLockBlob: string | null
  readLockBlob?: typeof readGitLockfileBlob
}

export function makeSelfRestartCheck(deps: SelfRestartDeps): () => Promise<void> {
  const readHead = deps.readHead ?? readGitHead
  const readLockBlob = deps.readLockBlob ?? readGitLockfileBlob
  // 重启是异步的(优雅关闭要时间),期间 tick 还会继续跑 —— 不加这个闩,
  // 每 60 秒都会再请求一次重启。
  let requested = false

  return async function check(): Promise<void> {
    try {
      if (requested) return
      // Cheap in-memory guards BEFORE any git spawn (Task 3 review #3) —
      // skip the `git rev-parse` subprocess (otherwise ~1440/day at this
      // 60s cadence) whenever the outcome is already decided without one:
      // non-git checkout, still inside the boot-grace window, or not idle.
      // Pure reorder — every one of these is a strict prerequisite of
      // shouldSelfRestart's own checks, so the final decision is unchanged.
      if (deps.loadedHead === null) return
      const nowMs = deps.now()
      if (nowMs - deps.bootAtMs < BOOT_GRACE_MS) return
      const idle = !deps.anyInFlight() && deps.quietFor(nowMs) >= IDLE_QUIET_MS
      if (!idle) return

      const currentHead = await readHead({ cwd: deps.cwd })
      if (!shouldSelfRestart({
        loadedHead: deps.loadedHead,
        currentHead,
        idle,
        nowMs,
        bootAtMs: deps.bootAtMs,
        lastRestartAtMs: null,
      })) return

      // Lockfile-drift guard (Task 3 review #2) — see bootLockBlob's doc
      // comment above. Any uncertainty here (either blob unreadable) ⇒
      // don't restart; let `wechat-cc update`'s own install step handle it.
      const currentLockBlob = await readLockBlob({ cwd: deps.cwd })
      if (deps.bootLockBlob === null || currentLockBlob === null || deps.bootLockBlob !== currentLockBlob) return

      requested = true
      deps.log('SELF_RESTART', `code on disk moved ${deps.loadedHead?.slice(0, 7)} → ${currentHead?.slice(0, 7)}; idle, restarting to load it`)
      deps.requestRestart()
    } catch {
      // 静默:这套机制绝不能成为新的故障源。
    }
  }
}
