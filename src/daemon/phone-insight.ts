/**
 * 手机「洞察」路由的拼装(spec 2026-09-30-tendhearth-app-v1 §5.1–5.2):取一件事的详情,
 * 待批准的每一条交给批准说明,事件流交给进展概括;两者并行。聊天事项没有任务 ⇒ 什么也不算。
 *
 * 路由有自己的截止时间(默认 8 秒):协议客户端 15 秒没流量就断线,而便宜模型的预算可能到 30 秒。
 * 截止时间先到的那一项就用原文回退;底层调用照旧跑完,结果进说明/概括自己的缓存,下次打开就是模型版。
 */
import { rawExplanation, type ApprovalExplanation, type ApprovalInput } from './phone-explain'
import type { InsightLang } from './phone-insight-llm'
import { rawProgress, type ProgressInput, type ProgressSummary } from './phone-progress'

export const INSIGHT_DEADLINE_MS = 8_000

export interface PhoneInsight {
  forMatter(id: string, lang: InsightLang): Promise<{ explanations: Record<string, ApprovalExplanation>; progress: ProgressSummary | null }>
}

type Detail = {
  task: { id: string; title: string; path: string; phase?: string; status?: string; updatedAt: number } | null
  events: Array<{ kind: string; text: string; createdAt: number }>
  permissions: Array<{ id: string; taskId: string; tool: string; description: string }>
}

export function makePhoneInsight(deps: {
  detail(id: string): Promise<unknown> | unknown
  explainer: { explain(p: ApprovalInput): Promise<ApprovalExplanation> }
  summarizer: { summarize(p: ProgressInput): Promise<ProgressSummary> }
  deadlineMs?: number
}): PhoneInsight {
  const deadlineMs = deps.deadlineMs ?? INSIGHT_DEADLINE_MS
  /** 截止前拿到就用;截止了(或底层抛错)就用 fallback。底层的迟到拒绝在这里被吞掉,不会成为未处理拒绝。 */
  function withDeadline<T>(work: () => Promise<T>, fallback: () => T): Promise<T> {
    let pr: Promise<T>
    try { pr = Promise.resolve(work()) } catch { return Promise.resolve(fallback()) }
    pr.catch(() => {})
    let timer: ReturnType<typeof setTimeout> | undefined
    return Promise.race([
      pr.catch(() => fallback()),
      new Promise<T>(res => { timer = setTimeout(() => res(fallback()), deadlineMs) }),
    ]).finally(() => { if (timer) clearTimeout(timer) })
  }
  return {
    async forMatter(id, lang) {
      const d = await deps.detail(id) as Detail
      if (!d.task) return { explanations: {}, progress: null }
      const task = d.task
      const events = Array.isArray(d.events) ? d.events : []
      const last = events[events.length - 1]
      const [pairs, progress] = await Promise.all([
        Promise.all((d.permissions ?? []).map(async p => {
          const input: ApprovalInput = { taskId: p.taskId, id: p.id, tool: p.tool, description: p.description, path: task.path, lang }
          return [p.id, await withDeadline(() => deps.explainer.explain(input), () => rawExplanation(input))] as const
        })),
        (() => {
          const input: ProgressInput = { taskId: task.id, versionKey: `${task.updatedAt}:${events.length}:${last?.createdAt ?? 0}`, title: task.title, phase: task.phase ?? task.status ?? '', events, lang }
          return withDeadline(() => deps.summarizer.summarize(input), () => rawProgress(input))
        })(),
      ])
      return { explanations: Object.fromEntries(pairs), progress }
    },
  }
}
