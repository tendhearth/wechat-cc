import type { MatterDetailT, ApprovalExplanationT } from '../backend/types'

export type ApprovalView =
  | { kind: 'choose'; items: Array<{ requestId: string; summary: string }> }
  | { kind: 'none' }
  | { kind: 'card'; requestId: string; runId: string; title: string; what: string; scope: string; effect: string
      aiSummary: boolean; rawFirstLine: string; rawFull: string; workingDir: string; showRawInline: boolean }

const firstLine = (s: string, max: number) => (s.split('\n')[0] ?? '').slice(0, max)

export function approvalView(detail: MatterDetailT, explanations: Record<string, ApprovalExplanationT>, requestId?: string): ApprovalView {
  const perms = detail.permissions
  if (perms.length === 0 || !detail.runId) return { kind: 'none' }
  let p = perms[0]!
  if (requestId !== undefined) {
    const found = perms.find(x => x.id === requestId)
    if (!found) return { kind: 'none' }
    p = found
  } else if (perms.length > 1) {
    return { kind: 'choose', items: perms.map(x => ({ requestId: x.id, summary: `${x.tool}: ${firstLine(x.description, 80)}`.slice(0, 80) })) }
  }
  const ex = explanations[p.id]
  const workingDir = detail.task?.path ?? ''
  const aiSummary = ex?.source === 'model'
  return {
    kind: 'card', requestId: p.id, runId: detail.runId,
    title: ex?.title ?? p.tool, what: ex?.what ?? p.description, scope: ex?.scope ?? workingDir, effect: ex?.effect ?? '',
    aiSummary, rawFirstLine: firstLine(p.description, 120), rawFull: p.description, workingDir, showRawInline: aiSummary,
  }
}
