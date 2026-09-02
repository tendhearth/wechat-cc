import { parseArtImpulse, type ArtImpulse } from './art-impulse'
import type { ArtImpulsePlanner, AtelierContext } from './atelier-runtime'

const MAX_ITEM = 240
const MAX_ITEMS = 6

function bounded(value: string, limit = MAX_ITEM): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').trim().slice(0, limit)
}

function boundedList(values: readonly string[]): string[] {
  return values.filter(value => typeof value === 'string').slice(0, MAX_ITEMS).map(value => bounded(value))
}

/**
 * Build the only prompt sent to the selected chat/cheap-eval provider for an
 * atelier decision. It contains derived context, never raw chat history.
 */
export function buildAtelierPlannerPrompt(context: AtelierContext): string {
  const observations = boundedList(context.recentObservations)
  const threads = boundedList(context.activeThreads)
  const works = context.recentWorks.slice(0, MAX_ITEMS).map(work => ({
    createdAt: bounded(work.createdAt, 40),
    subject: work.subject ? bounded(work.subject) : undefined,
    surface: work.surface ? bounded(work.surface) : undefined,
    medium: work.medium ? bounded(work.medium) : undefined,
  }))
  return [
    '你是 CC 画室的创作规划器。你不是画笔，也不是表情包生成器。',
    '请根据下面有限的衍生观察，判断此刻是否有真实的创作冲动。没有就只输出：{"shouldPaint":false}。',
    '如果要画，允许含混、隐喻和非具象表达；选择画面主体、表面、材料、动作和构图。不要把感受翻译成固定情绪标签，不要求画 CC 自己。',
    '只输出严格 JSON，不要 Markdown、解释、额外字段。shouldPaint=true 时必须提供 feeling、whyNow、subject、surface、medium、gesture、composition、shareIntent；shareIntent 只能是 now、later、private。',
    'whyNow 是仅供本机连续性记录的私密原因，保持简短；它不会发送给画笔。所有字段都不得包含姓名、联系方式、地址、网址、聊天原句或身份编号。',
    '【当前时间】', JSON.stringify(bounded(context.nowLocal, 80)),
    '【近期观察】', JSON.stringify(observations),
    '【进行中的主题】', JSON.stringify(threads),
    '【近期作品的视觉摘要】', JSON.stringify(works),
    '【CC 的表达倾向】', JSON.stringify(bounded(context.personaExcerpt, 500)),
  ].join('\n')
}

export class AtelierPlannerError extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'AtelierPlannerError'
  }
}

export interface JsonAtelierPlannerDeps {
  evaluate: (prompt: string) => Promise<string | unknown>
}

/** Adapt any chat provider's cheap evaluator to the common planner contract. */
export function makeJsonAtelierPlanner(deps: JsonAtelierPlannerDeps): ArtImpulsePlanner {
  return {
    async plan(context): Promise<ArtImpulse> {
      const parsed = parseArtImpulse(await deps.evaluate(buildAtelierPlannerPrompt(context)))
      if (!parsed.ok) throw new AtelierPlannerError(parsed.reason)
      return parsed.value
    },
  }
}
