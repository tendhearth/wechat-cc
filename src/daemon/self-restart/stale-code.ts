/**
 * stale-code — 该不该为了加载新代码而自我重启(spec 2026-08-03 §1/§5)。
 *
 * WHY: daemon 从 git checkout 运行,bun 在进程启动时加载源码。所以
 * `wechat-cc update` 之后运行中的进程仍是旧的,直到有人重启 —— 这不是边缘
 * 情况,是每次更新后的默认状态。2026-08-03 实测:连接健康的全部修复躺在磁盘
 * 上,而当天两次断线跑的仍是 7 月 27 日启动的旧进程。
 *
 * 纯函数、零 I/O、注入一切。每一处不确定都倒向"不动作"。
 */

/** 进程启动后这么久内不自我重启 —— 挡住任何"起来就重启"的病态循环。 */
export const BOOT_GRACE_MS = 300_000

/** 两次自我重启之间的最小间隔,防 HEAD 被外部持续改动导致反复重启。 */
export const MIN_RESTART_INTERVAL_MS = 600_000

export interface StaleCheckInput {
  /** 本进程启动时加载的 commit;读不到为 null。 */
  loadedHead: string | null
  /** checkout 当前的 commit;读不到为 null。 */
  currentHead: string | null
  /** 当前是否空闲(无在途会话 且 最近无入站)。 */
  idle: boolean
  nowMs: number
  bootAtMs: number
  /** 本进程此前触发过自我重启的时刻;从未触发为 null。 */
  lastRestartAtMs: number | null
}

export function shouldSelfRestart(input: StaleCheckInput): boolean {
  // 读不到任何一侧都不动作:宁可永远不重启,也不能因为一次 git 读取抖动
  // 就把主人的 bot 踢下线。
  if (input.loadedHead === null || input.currentHead === null) return false
  if (input.loadedHead === input.currentHead) return false
  if (!input.idle) return false
  if (input.nowMs - input.bootAtMs < BOOT_GRACE_MS) return false
  if (input.lastRestartAtMs !== null
    && input.nowMs - input.lastRestartAtMs < MIN_RESTART_INTERVAL_MS) return false
  return true
}
