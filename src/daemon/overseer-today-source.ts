/**
 * overseer-today-source.ts — 把「今天」的两路来源读出来交给纯函数(core/overseer-today.ts)。
 *
 * 终端:登记处(含已结束的、带中继开出去的码);一起做:工作台未归档任务 + 待决。
 * 任一路读不到(没接 / 抛)⇒ 记为 unavailable,另一路照算 —— 整张不因一路出错而挂。
 * 微信「日报」、GET /v1/overseer/today、手机 /m/api/today 都调同一个函数。只读,只在被问时算。
 */
import { buildOverseerToday, TODAY_WINDOW_MS, type OverseerToday, type TodayAttentionInput, type TodayCcDecided, type TodayJobs, type TodayTaskInput } from '../core/overseer-today'
import type { CliDigestView } from '../core/cli-session-digest'

/** 工作台里用得到的两个只读入口(WorkbenchService 结构上满足;测试可给假的)。 */
export interface TodayWorkbench {
  list(query: { archived?: 'exclude' | 'only' | 'all'; limit?: number }): { tasks: readonly TodayTaskInput[] }
  attention(): { tasks: readonly TodayAttentionInput[] }
}

export interface OverseerTodaySourceDeps {
  /** 终端登记处(含已结束的)。缺省 ⇒ 终端读不到。 */
  terminal?: () => CliDigestView[]
  /** 工作台;晚绑定(main.ts 里它在微信处理器之后才建)。缺省 / 返回 null ⇒ 一起做读不到。 */
  workbench?: () => TodayWorkbench | null | undefined
  localMachine?: string
  /** 放行规则的留痕:从 since 起 CC 替主人批了几条 + 最近几条。缺省 / 抛 ⇒ 不画那一行。 */
  ccDecided?: (since: number) => TodayCcDecided
  /** 定时任务:从 since 起跑了几个 / 说了几个 / 被停的。缺省 / 抛 ⇒ 不画。 */
  jobs?: (since: number) => TodayJobs
  now?: () => number
  log?: (tag: string, line: string) => void
}

/** 一次最多看这么多条:登记处 500 行封顶,工作台按最近更新取前 100(窗外的本来就不出现)。 */
export const TODAY_TERMINAL_LIMIT = 200
export const TODAY_TASK_LIMIT = 100

export function makeOverseerTodaySource(deps: OverseerTodaySourceDeps): () => OverseerToday {
  const read = <T>(what: string, fn: () => T): T | null => {
    try { return fn() }
    catch (err) { deps.log?.('OVERSEER', `${what} failed: ${err instanceof Error ? err.message : String(err)}`); return null }
  }
  return () => {
    const wb = deps.workbench?.() ?? null
    const now = (deps.now ?? Date.now)()
    return buildOverseerToday({
      now,
      ccDecided: deps.ccDecided ? read('permission decisions', () => deps.ccDecided!(now - TODAY_WINDOW_MS)) : null,
      jobs: deps.jobs ? read('scheduled jobs', () => deps.jobs!(now - TODAY_WINDOW_MS)) : null,
      terminal: deps.terminal ? read('terminal', deps.terminal) : null,
      tasks: wb ? read('workbench list', () => wb.list({ archived: 'exclude', limit: TODAY_TASK_LIMIT }).tasks) : null,
      attention: wb ? read('workbench attention', () => wb.attention().tasks) : null,
      localMachine: deps.localMachine,
    })
  }
}
