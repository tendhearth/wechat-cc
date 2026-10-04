/**
 * 「已经在跑的任务」网络一变不安全怎么办(主人 2026-10-03 拍板,docs/reference/network-guard.md 主人已定):
 *
 *   - 信号来自 bx:**永远不停、不暂停**。bx 是 fail-closed,隧道一断在跑的进程本来就出不去,不会漏;
 *     动它不会更安全,反而 bx 自动恢复那 10 秒的波动会把跑了很久的任务打断。只拦新的启动 / 续接 /
 *     追加输入(闸门负责)。
 *   - 信号来自 probe(没装 bx,不保证 fail-closed):**连续两次**读到不安全 ⇒ **暂停**(SIGSTOP 整棵
 *     进程树,不是停)需要保护的执行者;不需要保护的(国内 / 自建 / Cursor auto)照跑。
 *   - 读到安全(或改用 bx)⇒ 放开(SIGCONT),计时器从那一刻接着走。
 *   - 暂停到顶(guard.json `max_suspend_minutes`,缺省 30)还没恢复 ⇒ 按收工停下,在发起的那一面告诉主人
 *     「网络一直没恢复，任务已停止，可以接着做」。
 *
 * 调度器每读一次(onReading)就喂进来一次。纯状态机在 makeExecutorPausePolicy;
 * 计时(到顶 / 守护被关掉时放开)在 makeNetworkSuspendController,时钟可注入(测试用假时钟)。
 */
import type { GuardState } from './scheduler'

export const PROBE_UNSAFE_READS_BEFORE_PAUSE = 2
/** 暂停上限的缺省值(分钟);guard.json `max_suspend_minutes` 可改。 */
export const DEFAULT_MAX_SUSPEND_MINUTES = 30
/** 暂停到顶时那一句(主人原话)。 */
export const SUSPEND_CAP_MESSAGE = '网络一直没恢复，任务已停止，可以接着做'

export type PauseAction = 'none' | 'suspend' | 'resume'

export interface ExecutorPausePolicy {
  observe(s: GuardState): PauseAction
  /** 守护被关掉 / daemon 要放开所有冻住的:回到「没暂停」,返回之前是不是在暂停。 */
  release(): boolean
  readonly suspended: boolean
}

export function makeExecutorPausePolicy(threshold = PROBE_UNSAFE_READS_BEFORE_PAUSE): ExecutorPausePolicy {
  let consecutive = 0, suspended = false
  return {
    get suspended() { return suspended },
    observe(s) {
      // bx 来源从不暂停;已经在暂停(之前是 probe)而改用了 bx ⇒ bx fail-closed,放开是安全的。
      if (s.source !== 'probe' || s.safe) {
        consecutive = 0
        if (!suspended) return 'none'
        suspended = false
        return 'resume'
      }
      consecutive++
      if (suspended || consecutive < threshold) return 'none'
      suspended = true
      return 'suspend'
    },
    release() {
      consecutive = 0
      const was = suspended
      suspended = false
      return was
    },
  }
}

export interface NetworkSuspendDeps {
  /** 冻住需要保护的执行者(冻不住的退回停)+ 关掉需要保护的对话会话。 */
  suspend(s: GuardState): void
  /** 放开冻住的。 */
  resume(): void
  /** 到顶:按收工停下冻住的,通知用 SUSPEND_CAP_MESSAGE。 */
  stopSuspended(message: string): void
  /** 暂停上限(毫秒),每次进入暂停时读一次(guard.json 热生效)。 */
  maxSuspendMs(): number
  /** 守护总开关;暂停期间被关掉 ⇒ 放开(关了就什么都不判)。缺省视为开着。 */
  isEnabled?(): boolean
  log(tag: string, line: string): void
  /** 暂停期间多久看一次总开关;缺省 30s(和 probe 的节拍一样)。 */
  enabledPollMs?: number
}

export interface NetworkSuspendController {
  observe(s: GuardState): void
  readonly suspended: boolean
  dispose(): void
}

export function makeNetworkSuspendController(deps: NetworkSuspendDeps, policy: ExecutorPausePolicy = makeExecutorPausePolicy()): NetworkSuspendController {
  let cap: ReturnType<typeof setTimeout> | undefined
  let watch: ReturnType<typeof setInterval> | undefined
  const disarm = () => {
    if (cap) clearTimeout(cap); cap = undefined
    if (watch) clearInterval(watch); watch = undefined
  }
  const safely = (what: string, fn: () => void) => {
    try { fn() } catch (err) { deps.log('GUARD', `${what} failed: ${err instanceof Error ? err.message : String(err)}`) }
  }
  const resume = (why: string) => {
    disarm()
    deps.log('GUARD', `network protected again (${why}) — resuming suspended tasks`)
    safely('resume', () => deps.resume())
  }
  return {
    get suspended() { return policy.suspended },
    observe(s) {
      const action = policy.observe(s)
      if (action === 'resume') { resume(s.source === 'bx' ? 'bx' : 'probe safe'); return }
      if (action !== 'suspend') return
      let ms = DEFAULT_MAX_SUSPEND_MINUTES * 60_000
      try { const v = deps.maxSuspendMs(); if (Number.isFinite(v) && v > 0) ms = v } catch { /* 缺省 */ }
      deps.log('GUARD', `network unprotected [probe, ${PROBE_UNSAFE_READS_BEFORE_PAUSE} reads] — suspending protected tasks (cap ${Math.round(ms / 60_000)} min)`)
      safely('suspend', () => deps.suspend(s))
      disarm()
      cap = setTimeout(() => {
        cap = undefined
        if (watch) clearInterval(watch); watch = undefined
        deps.log('GUARD', `still unprotected after ${Math.round(ms / 60_000)} min — stopping suspended tasks`)
        // 策略仍记着「在暂停」:这一段不安全期不会再冻一次;读到安全时那一下 resume 是空操作。
        safely('stop suspended', () => deps.stopSuspended(SUSPEND_CAP_MESSAGE))
      }, Math.min(ms, 2_147_483_647))
      cap.unref?.()
      if (deps.isEnabled) {
        watch = setInterval(() => {
          let on = true
          try { on = deps.isEnabled!() } catch { on = true }
          if (!on && policy.release()) resume('guard disabled')
        }, deps.enabledPollMs ?? 30_000)
        watch.unref?.()
      }
    },
    dispose: disarm,
  }
}
