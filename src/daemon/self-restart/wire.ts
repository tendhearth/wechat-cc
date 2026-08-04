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
import { shouldSelfRestart } from './stale-code'
import { readGitHead } from './git-head'

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
}

export function makeSelfRestartCheck(deps: SelfRestartDeps): () => Promise<void> {
  const readHead = deps.readHead ?? readGitHead
  // 重启是异步的(优雅关闭要时间),期间 tick 还会继续跑 —— 不加这个闩,
  // 每 60 秒都会再请求一次重启。
  let requested = false

  return async function check(): Promise<void> {
    try {
      if (requested) return
      const nowMs = deps.now()
      const currentHead = await readHead({ cwd: deps.cwd })
      const idle = !deps.anyInFlight() && deps.quietFor(nowMs) >= IDLE_QUIET_MS
      if (!shouldSelfRestart({
        loadedHead: deps.loadedHead,
        currentHead,
        idle,
        nowMs,
        bootAtMs: deps.bootAtMs,
        lastRestartAtMs: null,
      })) return

      requested = true
      deps.log('SELF_RESTART', `code on disk moved ${deps.loadedHead?.slice(0, 7)} → ${currentHead?.slice(0, 7)}; idle, restarting to load it`)
      deps.requestRestart()
    } catch {
      // 静默:这套机制绝不能成为新的故障源。
    }
  }
}
