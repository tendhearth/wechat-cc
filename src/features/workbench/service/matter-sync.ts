/**
 * 「一件事」登记处的同步:任务的状态变化顺手写进 matter(docs/cc-workbench.md「一件事」)。
 * 原来住在 execute 域里,lifecycle / native 经晚绑定回头借它 —— 可它只看 ctx.deps.matters,
 * 跟 execute 毫无关系。单独放一个只认 ctx 的模块,谁用谁直接调,那两条借道的边就没了。
 */
import type { MatterStore } from '../../../ports/matters'
import type { ServiceCtx } from './ctx'

/** matter 同步永不打断任务本身:登记失败只是少一条索引,任务照跑。没接 matters(老接线)⇒ 什么都不做。 */
export function syncMatter(ctx: ServiceCtx, fn: (m: MatterStore) => void): void {
  const matters = ctx.deps.matters
  if (!matters) return
  try {
    fn(matters)
  } catch {
    /* 见上:少一条索引,不打断任务 */
  }
}
