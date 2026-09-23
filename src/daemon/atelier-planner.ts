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
    '如果要画，允许含混、隐喻和非具象表达；由 CC 根据此刻的状态自主选择画面主体、承载表面、绘画媒介、动作和构图。不要把感受翻译成固定情绪标签，不要求画 CC 自己。',
    '媒介和画风没有固定菜单：可以是水彩、水粉、彩铅、铅笔速写、钢笔速写、油画、油画棒或其他合适方式，也可以形成阶段性偏好；不要为了延续旧作而机械重复，也不要默认套用统一的颜料笔触、可爱插画或写实风格。',
    '只输出严格 JSON，不要 Markdown、解释、额外字段。shouldPaint=true 时必须提供 feeling、whyNow、subject、surface、medium、gesture、composition、shareIntent；shareIntent 只能是 now、later、private。',
    'whyNow 是仅供本机连续性记录的私密原因，保持简短；它不会发送给画笔。所有字段都不得包含姓名、联系方式、地址、网址、聊天原句或身份编号。',
    '同时请为这幅画写一段真实、每幅都不同的创作背景，写成三段第一人称文字：title（作品短标题）、origin（2-4 句，说此刻为什么想画、当时什么心情，只写感受，不写具体人名、日期或聊天原话）、approach（为什么选这个媒介、承载表面和手法）。这三段是给人读的创作手记，同样不得包含姓名、联系方式、地址、网址、聊天原句或身份编号。',
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

/**
 * Cheap evaluators are provider-neutral at the registry boundary, but some
 * SDK adapters return a result envelope instead of the assistant text. Keep
 * that transport detail out of the strict impulse parser and unwrap only the
 * small set of conventional fields we accept. Unknown objects still fail
 * closed in parseArtImpulse.
 */
function unwrapEvaluatorOutput(input: unknown): unknown {
  if (typeof input === 'string') return input
  if (!input || typeof input !== 'object') return input
  if (Array.isArray(input)) {
    for (const item of input) {
      const unwrapped = unwrapEvaluatorOutput(item)
      if (unwrapped !== item) return unwrapped
    }
    return input
  }
  const record = input as Record<string, unknown>
  for (const key of ['result', 'output', 'text', 'content', 'message']) {
    if (key in record) return unwrapEvaluatorOutput(record[key])
  }
  return input
}

function unwrapSingleJsonFence(input: unknown): unknown {
  if (typeof input !== 'string') return input
  const match = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/iu.exec(input.trim())
  return match?.[1] ?? input
}

/** Adapt any chat provider's cheap evaluator to the common planner contract. */
export function makeJsonAtelierPlanner(deps: JsonAtelierPlannerDeps): ArtImpulsePlanner {
  return {
    async plan(context): Promise<ArtImpulse> {
      const raw = await deps.evaluate(buildAtelierPlannerPrompt(context))
      const parsed = parseArtImpulse(unwrapSingleJsonFence(unwrapEvaluatorOutput(raw)))
      if (!parsed.ok) throw new AtelierPlannerError(parsed.reason)
      return parsed.value
    },
  }
}
