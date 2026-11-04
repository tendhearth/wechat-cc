import type { MatterKind, MatterState, MatterStatus, MatterTurnStatus } from '../../ports/matters'

/**
 * matters/legacy-status.ts — 线上的旧 `Matter.status`(open / replied / done / archived)从这件事现算(M6b,设计稿
 * docs/superpowers/specs/2026-11-05-m6-read-side-design.md)。`matters.status` 列照旧写到 M6e,读这一侧只走这里。
 *
 * 规格是「和列逐行一样」:列只有三处写口 —— 建行(恒 open)、归档 / 取消归档、一起做的任务(终态 / 安静下来 / 主人说话)。
 * 所以:
 *   - 归档 ⇒ archived(和种类无关)。
 *   - 不是任务(对话 / 终端 / CC 自己做的事)⇒ open:它们的列从来没人改过,统一状态做完了(终端会话结束)列也还是 open。
 *   - 任务按任务自己的状态(写列的式子看的就是它):中断 ⇒ open;做完 / 没做成 / 停了 ⇒ done;
 *     还在跑(running)、这一轮已经收了、球在主人手里(state = open)、**而且列记着 replied** ⇒ replied;其余 ⇒ open。
 *     「答完了、闲着」(旧 phase 'replied')只有 settleQuiet 知道:执行者先交了结果、后台还在干活时,轮已经收了、
 *     state 也回到 open,但它要等运行时真闲下来(没有后台、没有待拍板)才写 replied(Codex 评审 P2)。
 *     这份「准备好了」除了列哪儿都没落库 ⇒ 这一位照旧读列(storedReplied);M6e 删列之前要先把它落成 matter 上的事实。
 *   - 读不到任务那一行(只有 matter 的库)⇒ 用统一状态:done / failed / cancelled ⇒ done。
 * 纯函数:不碰 db。列表筛选的 SQL 版本在 adapters/store/matters-store.ts(测试逐格对过这里)。
 */

/** 一起做的任务自己的状态(workbench_tasks.status)。 */
export type LegacyTaskStatus = 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

const TASK_FINISHED: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled'])
const STATE_FINISHED: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled'])

/**
 * 「任务 → 旧状态」唯一的式子(原来工作台归档与「一件事」服务各抄一份)。replied = 这一轮做完、只差主人下一句。
 */
export function legacyTaskStatus(task: { archived: boolean; /** LegacyTaskStatus(线上的视图里是 string)。 */status: string; replied: boolean }): MatterStatus {
  if (task.archived) return 'archived'
  if (task.status === 'interrupted') return 'open'
  if (TASK_FINISHED.has(task.status)) return 'done'
  return task.replied ? 'replied' : 'open'
}

/** 工作台的任务视图(带 phase)⇒ 旧状态:写列的那几处用它。 */
export const legacyStatusOfTaskView = (view: { archivedAt?: number | null; status: string; phase?: string }): MatterStatus =>
  legacyTaskStatus({ archived: view.archivedAt != null, status: view.status, replied: view.phase === 'replied' })

export interface LegacyStatusInput {
  kind: MatterKind
  state: MatterState
  archivedAt: number | null
  /** 这件事最近一轮(seq 最大)的状态;一轮都没有 ⇒ null。 */
  latestTurn: MatterTurnStatus | null
  /** kind = task 时任务那一行的状态;没有那一行 ⇒ null / 不给。 */
  taskStatus?: LegacyTaskStatus | null
  /** 列里记的是不是 replied(settleQuiet 写的「答完了、闲着」):唯一还读列的一位,M6e 前换成 matter 上的事实。 */
  storedReplied: boolean
}

export function legacyStatus(input: LegacyStatusInput): MatterStatus {
  if (input.archivedAt != null) return 'archived'
  if (input.kind !== 'task') return 'open'
  const repliedNow = input.storedReplied && input.state === 'open' && input.latestTurn === 'completed'
  const status = input.taskStatus
  if (!status) return STATE_FINISHED.has(input.state) ? 'done' : repliedNow ? 'replied' : 'open'
  return legacyTaskStatus({ archived: false, status, replied: status === 'running' && repliedNow })
}
