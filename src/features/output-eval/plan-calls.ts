import { randomBytes, randomUUID } from 'node:crypto'
import type { z } from 'zod'
import { MatterPlanRequest, WorkbenchEntryResultResponse } from '../../../packages/protocol/src/desktop-api'
import { matterToolFailure } from '../../../packages/protocol/src/workbench-errors'
import { PlanInputError, resolvePlanTarget } from '../../adapters/workbench/matter-plan-input'
import type { RecordMatterPlan } from '../../daemon/internal-api/token-registry'
import type { EvalPlanCall } from '../../domain/output-eval'

function recordFields(body: unknown): EvalPlanCall {
  const input = body && typeof body === 'object' ? body as Record<string, unknown> : {}
  const legs: EvalPlanCall['legs'] = []
  if (Array.isArray(input.legs)) {
    for (const leg of input.legs) {
      if (typeof leg?.executor === 'string' && typeof leg?.brief === 'string') {
        legs.push({ executor: leg.executor, brief: [...leg.brief].slice(0, 200).join('') })
      }
    }
  }
  return {
    title: typeof input.title === 'string' ? input.title : '',
    project: typeof input.project === 'string' ? input.project : null,
    resolvedProject: null,
    legs,
  }
}

export function makeMatterPlanRecorder(path: string, calls: EvalPlanCall[]) {
  let active = true
  const record: RecordMatterPlan = (query, body, projects, executors) => {
    // Authentication may have finished before the request body arrived.
    if (!active) return { status: 403, body: matterToolFailure('matter_ledger_forbidden', false) }
    const call = recordFields(body)
    calls.push(call)
    const parsed = MatterPlanRequest.safeParse(body)
    if (!parsed.success || query.size) {
      const failure = matterToolFailure('invalid_matter_plan', false)
      call.error = failure.error
      return { status: 400, body: failure }
    }
    const input = parsed.data
    try {
      const resolved = resolvePlanTarget(input, projects(), path)
      if (resolved.target.kind === 'project') call.resolvedProject = resolved.projectName
      // 生产会拒的执行者,这里也拒:不然模型编一个名字,评测照样回「已受理」(独立评审)。
      // 问的是工作台(路由传进来的 availableExecutors),不是对话那张登记表 —— 两张表里同名的 codex / claude 不是同一个东西,
      // 对话那张不带工作台能力,拿它核会把真能干活的执行者全判成没登记(11-19 真机评测抓到)。
      const available = executors()
      if (!input.legs.every(leg => available.includes(leg.executor))) throw new Error('unavailable_provider')
      const id = randomBytes(4).toString('hex')
      const acceptedAt = Date.now()
      const result: z.infer<typeof WorkbenchEntryResultResponse> = {
        receipt: { requestId: input.requestId ?? randomUUID(), taskId: id, matterId: id, runId: randomUUID(), acceptedAt },
        task: {
          id, title: input.title, path: resolved.projectPath, providerId: input.legs[0]!.executor,
          status: 'queued', workspaceKind: resolved.target.kind === 'managed' ? 'managed' : 'project',
          createdAt: acceptedAt, updatedAt: acceptedAt, error: null, archivedAt: null,
          phase: 'queued', canArchive: false, waitingFor: null,
        },
      }
      return { status: 202, body: result }
    } catch (error) {
      const failure = matterToolFailure(error instanceof Error ? error.message : '', false, 'plan',
        error instanceof PlanInputError ? error.projects : undefined)
      call.error = failure.error
      return { status: 409, body: failure }
    }
  }
  return { record, stop: () => { active = false } }
}
