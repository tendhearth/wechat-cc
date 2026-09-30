import { PHONE_ANSWER_MAX_JSON } from '@wechat-cc/protocol'
import type { MatterDetailT, ApprovalExplanationT } from '../backend/types'

export type ApprovalView =
  | { kind: 'choose'; items: Array<{ requestId: string; kind: 'permission' | 'question'; summary: string }> }
  | { kind: 'none' }
  | { kind: 'question'; requestId: string; runId: string
      items: Array<{ id: string; header: string; question: string; options: Array<{ label: string; description: string }>; multiSelect: boolean; allowOther: boolean }> }
  | { kind: 'card'; requestId: string; runId: string; title: string; what: string; scope: string; effect: string
      aiSummary: boolean; rawFirstLine: string; rawFull: string; workingDir: string; showRawInline: boolean
      /** 首行之后还有几行(结尾空行不算);首行是否被截到 120 字。 */
      rawMoreLines: number; rawFirstLineCut: boolean }

const firstLine = (s: string, max: number) => (s.split('\n')[0] ?? '').slice(0, max)

export function approvalView(detail: MatterDetailT, explanations: Record<string, ApprovalExplanationT>, requestId?: string): ApprovalView {
  const perms = detail.permissions
  const questions = detail.questions
  const runId = detail.runId
  if (!runId || perms.length + questions.length === 0) return { kind: 'none' }

  const questionView = (q: (typeof questions)[number]): ApprovalView => ({
    kind: 'question', requestId: q.id, runId,
    items: q.questions.map(x => ({ id: x.id, header: x.header, question: x.question, options: x.options, multiSelect: x.multiSelect, allowOther: x.allowOther })),
  })
  const cardView = (p: (typeof perms)[number]): ApprovalView => {
    const ex = explanations[p.id]
    const workingDir = detail.task?.path ?? ''
    const aiSummary = ex?.source === 'model'
    const lines = p.description.replace(/\n+$/, '').split('\n')
    return {
      kind: 'card', requestId: p.id, runId,
      title: ex?.title ?? p.tool, what: ex?.what ?? p.description, scope: ex?.scope ?? workingDir, effect: ex?.effect ?? '',
      aiSummary, rawFirstLine: firstLine(p.description, 120), rawFull: p.description, workingDir, showRawInline: aiSummary,
      rawMoreLines: lines.length - 1, rawFirstLineCut: (lines[0] ?? '').length > 120,
    }
  }

  if (requestId !== undefined) {
    const p = perms.find(x => x.id === requestId)
    if (p) return cardView(p)
    const q = questions.find(x => x.id === requestId)
    return q ? questionView(q) : { kind: 'none' }
  }
  if (perms.length + questions.length === 1) return perms[0] ? cardView(perms[0]) : questionView(questions[0]!)
  return {
    kind: 'choose',
    items: [
      ...perms.map(x => ({ requestId: x.id, kind: 'permission' as const, summary: `${x.tool}: ${firstLine(x.description, 80)}`.slice(0, 80) })),
      ...questions.map(x => ({ requestId: x.id, kind: 'question' as const, summary: `${x.questions[0]?.header ?? ''}: ${x.questions[0]?.question ?? ''}`.slice(0, 80) })),
    ],
  }
}

type QuestionItem = Extract<ApprovalView, { kind: 'question' }>['items'][number]

/** 与 daemon validateUserInputAnswers 一致:每条回答 ≤ 4000 字、多选至多 8 个。 */
export const ANSWER_MAX_CHARS = 4000
export const ANSWER_MAX_MULTI = 8

/**
 * 把问答表单的选择拼成 answers。形状跟 daemon 一致:每题都是 string[](单选 ⇒ [x],多选 ⇒ 1–8 个且不重复)。
 * 「其他」填了字就算一个回答(单选时它顶替选项,多选时追加,与已选标签相同则去重);超过 4000 字截断。
 * 有任何一题没答或多选超过 8 个 ⇒ null(提交按钮不可用)。
 */
export function buildAnswers(items: QuestionItem[], picked: Record<string, string[]>, other: Record<string, string>): Record<string, string[]> | null {
  const out: Record<string, string[]> = {}
  for (const it of items) {
    const chosen = (picked[it.id] ?? []).filter(l => it.options.some(o => o.label === l))
    const extra = it.allowOther ? (other[it.id] ?? '').trim().slice(0, ANSWER_MAX_CHARS) : ''
    const all = it.multiSelect ? [...chosen, ...(extra ? [extra] : [])] : [extra || chosen[0] || '']
    const uniq = [...new Set(all.filter(a => a.trim() !== ''))]
    if (uniq.length === 0 || uniq.length > (it.multiSelect ? ANSWER_MAX_MULTI : 1)) return null
    out[it.id] = uniq
  }
  return out
}

/** 点一个选项:单选互斥、再点取消;多选增删,已满 8 项时原样返回(不再加)。 */
export function togglePick(cur: string[], label: string, multi: boolean): string[] {
  if (!multi) return cur[0] === label ? [] : [label]
  if (cur.includes(label)) return cur.filter(x => x !== label)
  return cur.length >= ANSWER_MAX_MULTI ? cur : [...cur, label]
}

/** 多选已选满 8 项 ⇒ 显示「最多选 8 项」(这时再填「其他」也会超,提交按钮不可用)。 */
export function multiLimitReached(multi: boolean, chosen: string[]): boolean {
  return multi && chosen.length >= ANSWER_MAX_MULTI
}

/** 页面第一次解析出具体请求时把它钉住;之后只认这一个,它不在了 ⇒ none(已处理),绝不换成别的请求。 */
export function pinnedRequest(param: string | undefined, pinned: string | undefined, v: ApprovalView): string | undefined {
  if (param) return param
  if (pinned) return pinned
  return v.kind === 'card' || v.kind === 'question' ? v.requestId : undefined
}

/** 与 daemon POST /m/api/matter/answer 的上限一致:超了就在手机上拦下,不发。 */
export function answersTooLong(answers: Record<string, string[]> | null): boolean {
  return answers !== null && JSON.stringify(answers).length > PHONE_ANSWER_MAX_JSON
}
