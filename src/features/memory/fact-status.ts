/**
 * 待办「不对」、MCP 的 superseded 也是一种收回(架构终态 G5,主人 10-26 第 1 条;设计稿 §2.3)。
 *
 * 联系人事实在主库(G7 起;店面 changeFactStatus 记事件),待办页 / 手机 / MCP 经 FactsApi.setFactStatus 改它的状态;这里包一层:
 * 状态真的改成了 `rejected`(主人点「不对」)或 `superseded`(MCP 说被取代了),就把这件事的说法交给 retract ——
 * 记忆、笔记、总览里同一句话也一路收回,和在记忆页删一行一样。`resolved`(已办)**不是**收回:办完了不等于没发生过。
 */
export interface FactStatusSetter { setFactStatus(id: number, status: string, now: number): object }
export interface FactLookup { factById(id: number): { predicate: string; value: string; status: string } | null }

const VERDICT: Record<string, 'wrong' | 'outdated' | undefined> = { rejected: 'wrong', superseded: 'outdated' }

/** 待办在页面上显示的那句(knowledge.md 蒸馏也是这么拼的)。 */
export const factSentence = (f: { predicate: string; value: string }) => `${f.predicate} ${f.value}`.trim()

export function retractOnFactStatus<F extends FactStatusSetter>(facts: F, d: FactLookup & { retract: (text: string, verdict: 'wrong' | 'outdated') => void }): F {
  return {
    ...facts,
    setFactStatus(id: number, status: string, now: number) {
      const before = d.factById(id)
      const res = facts.setFactStatus(id, status, now) as { ok?: boolean }
      const verdict = VERDICT[status]
      if (res?.ok && verdict && before && before.status !== status) d.retract(factSentence(before), verdict)
      return res
    },
  }
}
