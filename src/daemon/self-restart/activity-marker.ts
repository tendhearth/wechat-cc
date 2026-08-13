/**
 * activity-marker — 进程内的"最近一次入站"时刻(spec 2026-08-03 §2)。
 *
 * 只在内存里,不落盘、不查库:它唯一的用途是回答"现在是不是有人正在跟 bot
 * 说话",进程重启后从零开始正是想要的语义。
 */
export interface ActivityMarker {
  mark(): void
  /** 距上次 mark 的毫秒数;从未 mark 过 ⇒ Infinity(视为很久没人说话)。 */
  quietFor(nowMs: number): number
}

export function makeActivityMarker(deps: { now: () => number }): ActivityMarker {
  let lastAtMs: number | null = null
  return {
    mark() { lastAtMs = deps.now() },
    quietFor(nowMs) {
      return lastAtMs === null ? Number.POSITIVE_INFINITY : nowMs - lastAtMs
    },
  }
}
