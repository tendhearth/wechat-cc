import { permissionCwd, PermissionDisplaySchema, permissionDisplay, PHONE_ANSWER_MAX_JSON, type PermissionDisplay } from '@wechat-cc/protocol'
import { labelJoin, t, type Lang } from '../i18n'
import type { MatterDetailT, ApprovalExplanationT } from '../backend/types'
import { directHeaderView } from './direct-header'

export type ApprovalView =
  | { kind: 'choose'; items: Array<{ requestId: string; kind: 'permission' | 'question'; summary: string }> }
  | { kind: 'none' }
  | { kind: 'question'; requestId: string; runId: string
      items: Array<{ id: string; header: string; question: string; options: Array<{ label: string; description: string }>; multiSelect: boolean; allowOther: boolean }> }
  | { kind: 'card'; requestId: string; runId: string; title: string; what: string; scope: string; effect: string
      tool: string; display: PermissionDisplay; rawFull: string; projectPath: string; cwd?: string; executor: string; executorName: string
      canAllowTask?: boolean; canDenyWithReason: boolean; scripts?: MatterDetailT['permissions'][number]['scripts'] }

const firstLine = (s: string, max: number) => (s.replace(/\r\n?/g, '\n').split('\n', 1)[0] ?? '').slice(0, max)

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
    const { current: executor, name: executorName } = directHeaderView(detail, 'en')
    const format = executor === 'claude' ? 'claude' : executor === 'openai' ? 'api' : 'text'
    const display = PermissionDisplaySchema.safeParse(p.display).data ?? permissionDisplay(p.tool, p.description, format)
    const cwd = permissionCwd(p.cwd)
    const projectPath = detail.task?.path || detail.matter.projectPath || ''
    const model = ex?.source === 'model' ? ex : undefined
    return {
      kind: 'card', requestId: p.id, runId, tool: p.tool, display, projectPath, ...(cwd ? { cwd } : {}), executor, executorName,
      title: model?.title.trim() || '', what: model?.what ?? '', scope: model?.scope ?? '', effect: model?.effect ?? '',
      rawFull: p.description,
      canDenyWithReason: p.canDenyWithReason === true, ...(p.canAllowTask ? { canAllowTask: true } : {}), ...(p.scripts ? { scripts: p.scripts } : {}),
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
      ...questions.map(x => ({ requestId: x.id, kind: 'question' as const, summary: labelJoin(x.questions[0]?.header ?? '', x.questions[0]?.question ?? '').slice(0, 80) })),
    ],
  }
}

type Body = PermissionDisplay['body']

export function permissionAction(body: Body | undefined, tool: string, actor: string, lang: Lang) {
  if (!body || body.kind === 'fields' || body.kind === 'text') {
    const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
    return t(lang, mcp ? 'approval.actor.mcp' : 'approval.actor.tool', { actor, service: mcp?.[1] ?? '', tool: mcp?.[2] ?? tool })
  }
  return t(lang, body.kind === 'edit' && body.changes.length > 1 ? 'approval.actor.multiEdit'
    : body.kind === 'patch' && body.files.length === 1 ? 'approval.actor.patchOne' : `approval.actor.${body.kind}`,
  { actor, n: body.kind === 'edit' ? body.changes.length : body.kind === 'patch' ? body.files.length : 1 })
}

export function approvalHeading(v: Extract<ApprovalView, { kind: 'card' }>, lang: Lang) {
  const body = v.display.body
  const action = permissionAction(body, v.tool, v.executorName || t(lang, 'approval.executor'), lang)
  const title = v.title || t(lang, body.kind === 'fields' || body.kind === 'text' ? 'approval.ask.tool'
    : body.kind === 'patch' && body.files.length === 1 ? 'approval.ask.edit' : `approval.ask.${body.kind}`)
  return { action, title }
}

/** Only shorten descendants. Keep the original spelling and separators in the visible suffix. */
export function approvalRelativePath(path: string, cwd: string): string {
  const windows = /^(?:[a-z]:[\\/]|\\\\)/i.test(cwd)
  const normalize = (value: string) => windows ? value.replace(/\\/g, '/').toLowerCase() : value
  const base = cwd.replace(windows ? /[\\/]+$/ : /\/+$/, '')
  if (!cwd || /^[a-z]:$/i.test(cwd) || path.split(windows ? /[\\/]/ : '/').includes('..')) return path
  return normalize(path).startsWith(`${normalize(base)}/`) && path.length > base.length + 1 ? path.slice(base.length + 1) : path
}

export function approvalDirectory(cwd: string | undefined, projectPath: string, lang: Lang): string {
  return cwd ? t(lang, 'approval.executionFolder', { path: cwd })
    : projectPath ? t(lang, 'approval.projectFolder', { path: projectPath }) : ''
}

export function approvalLines(value: string): string[] {
  if (!value) return []
  const lines = value.replace(/\r\n?/g, '\n').split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
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

/** 批准 / 回答提交失败码 ⇒ 页内提示。revoked 单列:手机已不再配对,「稍后再试」是错的(横幅由 ConnectionNotice 讲)。 */
export function approvalOutcome(error: string): 'handled' | 'ccBusy' | 'uncertain' | 'revoked' | 'failed' {
  if (error === 'stale') return 'handled'
  if (error === 'busy') return 'ccBusy'
  if (error === 'uncertain') return 'uncertain'
  if (error === 'revoked') return 'revoked'
  return 'failed'
}
