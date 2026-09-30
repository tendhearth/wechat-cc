/**
 * 手机「洞察」路由的拼装(spec 2026-09-30-tendhearth-app-v1 §5.1–5.2):取一件事的详情,
 * 待批准的每一条交给批准说明,事件流交给进展概括;两者并行。聊天事项没有任务 ⇒ 什么也不算。
 */
import type { ApprovalExplanation, ApprovalInput } from './phone-explain'
import type { InsightLang } from './phone-insight-llm'
import type { ProgressInput, ProgressSummary } from './phone-progress'

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
}): PhoneInsight {
  return {
    async forMatter(id, lang) {
      const d = await deps.detail(id) as Detail
      if (!d.task) return { explanations: {}, progress: null }
      const task = d.task
      const events = Array.isArray(d.events) ? d.events : []
      const last = events[events.length - 1]
      const [pairs, progress] = await Promise.all([
        Promise.all((d.permissions ?? []).map(async p => [p.id, await deps.explainer.explain({ taskId: p.taskId, id: p.id, tool: p.tool, description: p.description, path: task.path, lang })] as const)),
        deps.summarizer.summarize({ taskId: task.id, versionKey: `${task.updatedAt}:${events.length}:${last?.createdAt ?? 0}`, title: task.title, phase: task.phase ?? task.status ?? '', events, lang }),
      ])
      return { explanations: Object.fromEntries(pairs), progress }
    },
  }
}
