import type { MatterDetailT, ApprovalExplanationT } from '../backend/types'

export type ApprovalView =
  | { kind: 'choose'; items: Array<{ requestId: string; kind: 'permission' | 'question'; summary: string }> }
  | { kind: 'none' }
  | { kind: 'question'; requestId: string; runId: string
      items: Array<{ id: string; header: string; question: string; options: Array<{ label: string; description: string }>; multiSelect: boolean; allowOther: boolean }> }
  | { kind: 'card'; requestId: string; runId: string; title: string; what: string; scope: string; effect: string
      aiSummary: boolean; rawFirstLine: string; rawFull: string; workingDir: string; showRawInline: boolean }

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
    return {
      kind: 'card', requestId: p.id, runId,
      title: ex?.title ?? p.tool, what: ex?.what ?? p.description, scope: ex?.scope ?? workingDir, effect: ex?.effect ?? '',
      aiSummary, rawFirstLine: firstLine(p.description, 120), rawFull: p.description, workingDir, showRawInline: aiSummary,
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
