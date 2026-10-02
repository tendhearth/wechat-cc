/**
 * 「要不要停掉已经在跑的执行者」的判据(2026-10-02 评审修订)。
 *
 *   - 信号来自 bx:**永远不停**。bx 是 fail-closed,隧道一断在跑的进程本来就
 *     出不去,不会漏;停掉不会更安全,反而 bx 自动恢复那 10 秒的波动会把跑了
 *     很久的任务杀掉。只拦新的启动 / 续接 / 追加输入(闸门负责)。
 *   - 信号来自老的 probe(没装 bx,不保证 fail-closed):连续两次读到不安全才停,
 *     每段不安全期只停一次;读到安全(或换成 bx)就重新计数。
 *
 * 调度器每读一次(onReading)就喂进来一次;observe 返回 true 的那一下去停。
 */
import type { GuardState } from './scheduler'

export const PROBE_UNSAFE_READS_BEFORE_PAUSE = 2

export function makeExecutorPausePolicy(threshold = PROBE_UNSAFE_READS_BEFORE_PAUSE): { observe(s: GuardState): boolean } {
  let consecutive = 0
  return {
    observe(s) {
      if (s.source !== 'probe' || s.safe) { consecutive = 0; return false }
      consecutive++
      return consecutive === threshold
    },
  }
}
