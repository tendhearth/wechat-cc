import type { Matter, MatterKind, MatterLifecycle, MatterState, MatterTurnStatus } from '../../ports/matters'
import type { LegacyMatterStatus } from './wire-status'

/**
 * matters/legacy-status.ts — 线上的旧 `Matter.status`(open / replied / done / archived)从这件事现算(M6b,设计稿
 * docs/superpowers/specs/2026-11-05-m6-read-side-design.md)。M6e(v102)起 `matters.status` 列删了,线上这个字段只剩
 * packages/protocol/src/wire-compat.ts 那一行在推,推的就是这里(`wireMatter` 把它插回原来的位置,逐字节同以前)。
 *
 * 规格是「和删掉的那一列逐行一样」:列以前只有三处写口 —— 建行(恒 open)、归档 / 取消归档、一起做的任务(终态 / 安静下来 / 主人说话)。
 * 所以:
 *   - 归档 ⇒ archived(和种类无关)。
 *   - 不是任务(对话 / 终端 / CC 自己做的事)⇒ open:它们的列从来没人改过,统一状态做完了(终端会话结束)列也还是 open。
 *   - 任务按任务自己的状态(写列的式子看的就是它):中断 ⇒ open;做完 / 没做成 / 停了 ⇒ done;
 *     还在跑(running)、这一轮已经收了、球在主人手里(state = open)、**而且最近一轮上有 ready 步** ⇒ replied;其余 ⇒ open。
 *     「答完了、闲着」(旧 phase 'replied')只有 settleQuiet 知道:执行者先交了结果、后台还在干活时,轮已经收了、
 *     state 也回到 open,但它要等运行时真闲下来(没有后台、没有待拍板)才说「好了」(Codex 评审 P2)。
 *     M6e 前半起它落成这件事最近一轮上的一步(ready-step.ts,`ready:<turnId>`);新一轮开始最近一轮就换了,自然不算。
 *   - 读不到任务那一行(只有 matter 的库)⇒ 用统一状态:done / failed / cancelled ⇒ done。
 * 纯函数:不碰 db。列表筛选的 SQL 版本在 adapters/store/matters-store.ts(测试逐格对过这里)。
 */

export { LEGACY_MATTER_STATUSES, type LegacyMatterStatus } from './wire-status'

/** 一起做的任务自己的状态(workbench_tasks.status)。 */
export type LegacyTaskStatus = 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

const TASK_FINISHED: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled'])
const STATE_FINISHED: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled'])

/**
 * 「任务 → 旧状态」唯一的式子(原来工作台归档与「一件事」服务各抄一份)。replied = 这一轮做完、只差主人下一句。
 */
export function legacyTaskStatus(task: { archived: boolean; /** LegacyTaskStatus(线上的视图里是 string)。 */status: string; replied: boolean }): LegacyMatterStatus {
  if (task.archived) return 'archived'
  if (task.status === 'interrupted') return 'open'
  if (TASK_FINISHED.has(task.status)) return 'done'
  return task.replied ? 'replied' : 'open'
}

/**
 * 一起做的任务 ⇒ 这件事的归档 / 结局(以前写列的那几处,v102 起只写 archived_at 与 state):归档 ⇒ archived;
 * 做完 / 没做成 / 停了 ⇒ done;其余(在跑、排队、中断)⇒ open。以前写 replied 的那一处现在写 open(两者对 archived_at / state 一样)。
 */
export const taskLifecycle = (task: { archived: boolean; status: string }): MatterLifecycle =>
  task.archived ? 'archived' : TASK_FINISHED.has(task.status) ? 'done' : 'open'
/** 工作台的任务视图 ⇒ 归档 / 结局。 */
export const lifecycleOfTaskView = (view: { archivedAt?: number | null; status: string }): MatterLifecycle =>
  taskLifecycle({ archived: view.archivedAt != null, status: view.status })

export interface LegacyStatusInput {
  kind: MatterKind
  state: MatterState
  archivedAt: number | null
  /** 这件事最近一轮(seq 最大)的状态;一轮都没有 ⇒ null。 */
  latestTurn: MatterTurnStatus | null
  /** kind = task 时任务那一行的状态;没有那一行 ⇒ null / 不给。 */
  taskStatus?: LegacyTaskStatus | null
  /** 最近一轮上有没有 ready 步(settleQuiet 的「答完了、闲着」,ready-step.ts)。 */
  latestReady: boolean
}

export function legacyStatus(input: LegacyStatusInput): LegacyMatterStatus {
  if (input.archivedAt != null) return 'archived'
  if (input.kind !== 'task') return 'open'
  const repliedNow = input.latestReady && input.state === 'open' && input.latestTurn === 'completed'
  const status = input.taskStatus
  if (!status) return STATE_FINISHED.has(input.state) ? 'done' : repliedNow ? 'replied' : 'open'
  return legacyTaskStatus({ archived: false, status, replied: status === 'running' && repliedNow })
}

/**
 * 线上的 Matter(带旧 status)= 这件事 + 现算的旧状态,status 插回它以前的位置(projectPath 之后),出口 JSON 逐字节同删列以前。
 * 线上 status 只经这里产出(wire-compat.ts 第一行)。
 */
export type WireMatter<M extends Matter = Matter> = M & { status: LegacyMatterStatus }
export function wireMatter<M extends Matter>(matter: M, status: LegacyMatterStatus): WireMatter<M> {
  const { id, kind, title, projectPath, ...rest } = matter
  return { id, kind, title, projectPath, status, ...rest } as unknown as WireMatter<M>
}
