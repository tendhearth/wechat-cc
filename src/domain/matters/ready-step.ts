import type { MatterItem, MatterTurn } from '../../ports/matters'

/**
 * matters/ready-step.ts —— 「答完了、闲着」落成这件事上的一步(M6e 前半,设计稿
 * docs/superpowers/specs/2026-11-05-m6-read-side-design.md §M6e)。
 *
 * 一起做的 settleQuiet 写 replied 的那一刻,同时往这件事最近那一轮(已收的那一轮)写一步 `system`,
 * key = `ready:<turnId>`、payload `{ready:true}`;(matter_id, item_key) 唯一 ⇒ 同一轮只一行。
 * 新一轮开始 ⇒ 最近一轮换了、自然不算,不用撤。
 *
 * 这一步是**内部事实**,主人看不见:时间线投影(WorkbenchTaskEvent / MatterEvent)、步列表、act 轮视图都滤掉它
 * (`isReadyStep`)。M6e 前半只双写 —— 旧 status 的 replied 照旧读列(legacy-status.ts),删列那一个 PR 再换读法。
 */
export const READY_STEP_PREFIX = 'ready:'
export const readyStepKey = (turnId: string): string => READY_STEP_PREFIX + turnId
export const READY_STEP_PAYLOAD: Readonly<Record<string, unknown>> = Object.freeze({ ready: true })

/** 这一步是不是「答完了、闲着」那一步(内部事实,不进任何给人看的投影)。 */
export const isReadyStep = (item: Pick<MatterItem, 'kind' | 'key'>): boolean =>
  item.kind === 'system' && typeof item.key === 'string' && item.key.startsWith(READY_STEP_PREFIX)

/** 最近一轮(seq 最大)有没有 ready 步。一轮都没有 ⇒ false。SQL 版本:matters-store.ts 的 LATEST_TURN_READY_SQL。 */
export function latestTurnReady(turns: readonly Pick<MatterTurn, 'id' | 'seq'>[], items: readonly Pick<MatterItem, 'kind' | 'key'>[]): boolean {
  let latest: Pick<MatterTurn, 'id' | 'seq'> | null = null
  for (const t of turns) if (!latest || t.seq > latest.seq) latest = t
  if (!latest) return false
  const key = readyStepKey(latest.id)
  return items.some(i => i.kind === 'system' && i.key === key)
}
