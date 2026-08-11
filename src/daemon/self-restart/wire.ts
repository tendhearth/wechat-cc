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
import { readGitHead, readGitLockfileBlob, readGitWorktreeDirty } from './git-head'

/** 空闲要求:最近这么久没有任何入站消息。 */
export const IDLE_QUIET_MS = 120_000

/** poll 新鲜度要求:最近这么久内 wechat poll 成功过(spec 2026-08-11 §4)。 */
export const POLL_FRESH_MS = 120_000

/**
 * "陈旧但被拦下"诊断日志的节流窗口(code review I2②,2026-08-11)——把这套
 * 机制"终身静默失效"的可能性变成一个可观测症状的最便宜手段:HEAD 确认动过
 * (即真的有新代码在等)、但某个安全闸门把这次重启拦下时,每小时最多记一行
 * INFO。空闲机器 HEAD 不动 ⇒ 从不触发这条路径 ⇒ 不产生噪音;真的卡住的机器
 * 会在 channel.log 里留下每小时一行的痕迹,而不是永远无声。
 */
const STALE_BLOCKED_LOG_THROTTLE_MS = 60 * 60_000

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
  readDirty?: typeof readGitWorktreeDirty
  /**
   * 是否有工作在跑(busy 登记处,spec 2026-08-11 §5)——覆盖不经
   * SessionManager 的长任务,是 anyInFlight() 之外的另一条在途信号。
   * 抛异常时外层 catch 兜底 ⇒ 不重启(失败方向安全)。
   */
  busy: () => boolean
  /** 最近一次 wechat poll 成功距今 ms;null = 从未成功/取不到 ⇒ 不重启。 */
  lastPollSuccessAgoMs: (nowMs: number) => number | null
}

export function makeSelfRestartCheck(deps: SelfRestartDeps): () => Promise<void> {
  const readHead = deps.readHead ?? readGitHead
  const readLockBlob = deps.readLockBlob ?? readGitLockfileBlob
  const readDirty = deps.readDirty ?? readGitWorktreeDirty
  // 重启是异步的(优雅关闭要时间),期间 tick 还会继续跑 —— 不加这个闩,
  // 每 60 秒都会再请求一次重启。
  let requested = false
  // 节流状态放闭包内存(与 `requested` 同级)—— 每个 makeSelfRestartCheck
  // 实例(=daemon 进程的一次生命周期)独立计时,不落盘、不跨重启累积。
  let lastStaleBlockedLogAtMs: number | null = null

  // 只在 HEAD 已确认陈旧(currentHead !== loadedHead,已过 shouldSelfRestart
  // 的"陈旧"判定)但被后续某个安全闸门拦下时调用。`reason` 标出是哪道闸门拦
  // 的(lockfile_drift / dirty_worktree / recheck_raced),其余字段是拦下那
  // 一刻的信号快照 —— 与判定逻辑读的是同一批 deps,不是重新采样一份可能对
  // 不上的状态。节流:每 STALE_BLOCKED_LOG_THROTTLE_MS 最多一行。
  function logStaleBlocked(reason: string, nowMs: number): void {
    if (lastStaleBlockedLogAtMs !== null && nowMs - lastStaleBlockedLogAtMs < STALE_BLOCKED_LOG_THROTTLE_MS) return
    lastStaleBlockedLogAtMs = nowMs
    const inflight = deps.anyInFlight()
    const busyNow = deps.busy()
    const quietMs = deps.quietFor(nowMs)
    const pollAgoMs = deps.lastPollSuccessAgoMs(nowMs)
    const quietStr = Number.isFinite(quietMs) ? `${Math.round(quietMs / 1000)}s` : 'inf'
    const pollAgoStr = pollAgoMs === null ? 'null' : `${Math.round(pollAgoMs / 1000)}s`
    deps.log('SELF_RESTART', `stale but blocked (${reason}): inflight=${inflight} busy=${busyNow} quiet=${quietStr} pollAgo=${pollAgoStr}`)
  }

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
      const ago = deps.lastPollSuccessAgoMs(nowMs)
      const fresh = ago !== null && ago <= POLL_FRESH_MS
      const idle = !deps.anyInFlight() && !deps.busy() && deps.quietFor(nowMs) >= IDLE_QUIET_MS && fresh
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
      if (deps.bootLockBlob === null || currentLockBlob === null || deps.bootLockBlob !== currentLockBlob) {
        logStaleBlocked('lockfile_drift', deps.now())
        return
      }

      // Dirty-worktree guard —— 见 readGitWorktreeDirty 的文档注释。HEAD 动了
      // 不等于磁盘上的代码能跑;半截的工作树会让新进程起不来,而 launchd 会
      // 每 10 秒重试一次,把 bot 彻底打下线。问不出来(null)一律当脏。
      const dirty = await readDirty({ cwd: deps.cwd })
      if (dirty !== 'clean') {
        logStaleBlocked('dirty_worktree', deps.now())
        return
      }

      // 到这里为止已经花了最多 ~9 秒在三次 git 调用上,而空闲是在最开头
      // 采样的。退出是不可撤销的,所以临门再查一次 —— 这期间进来的入站/
      // App 请求、busy 登记处的新工作、或 poll 新鲜度过期,都会被这一查
      // 拦下。
      const nowMs2 = deps.now()
      const ago2 = deps.lastPollSuccessAgoMs(nowMs2)
      if (deps.anyInFlight() || deps.busy() || deps.quietFor(nowMs2) < IDLE_QUIET_MS || ago2 === null || ago2 > POLL_FRESH_MS) {
        logStaleBlocked('recheck_raced', nowMs2)
        return
      }

      requested = true
      deps.log('SELF_RESTART', `code on disk moved ${deps.loadedHead?.slice(0, 7)} → ${currentHead?.slice(0, 7)}; idle, restarting to load it`)
      deps.requestRestart()
    } catch {
      // 静默:这套机制绝不能成为新的故障源。
    }
  }
}
