/** Pricing composes the pure invented plan with this run's configured limits. */
import {checkupEstimateSummary,type CheckupEstimate} from '@wechat-cc/protocol'
import {buildInterviewPlan,CHECKUP_MAX_QUESTION_OUTPUT,type InterviewOptions} from '../../domain/checkup-interview'
import {buildCheckupPlan,type PlanOptions} from '../../domain/butler-checkup'
import {checkupLimits,type CheckupLimits,type CheckupBudgetMode} from '../../domain/checkup-budget'
export function estimateInterview(o:InterviewOptions&{windowKnown?:boolean;limits?:CheckupLimits;budgetMode?:CheckupBudgetMode}):Omit<CheckupEstimate,'targetKey'> {
  const p=buildInterviewPlan(o),limits=o.limits??checkupLimits(o.full)
  // No per-model history yet: two typical steps, 250 visible tokens and
  // 1200 reasoning tokens per step. Realistic headroom for unknown models.
  const requests=Math.min(p.samples.length*2,limits.maxRequests)
  const quote={requests,...limits,inputTokens:p.samples.reduce((sum,s)=>sum+2*(s.estimatedTokens+(o.systemTokens??0)+1450),0),outputTokens:Math.min(requests*1450,limits.maxOutputTokens),windowKnown:o.windowKnown??false}
  return {...quote,summary:checkupEstimateSummary(quote,o.full,o.budgetMode==='question'?CHECKUP_MAX_QUESTION_OUTPUT:undefined)}
}

export function estimateCheckup(o: PlanOptions & { windowKnown?: boolean }): Omit<CheckupEstimate,'targetKey'> {
  const plan = buildCheckupPlan(o), samples = [...plan.memory, ...plan.tools]
  const requests = plan.memory.length + plan.tools.length * 2
  const quote={requests,...checkupLimits(o.full),inputTokens:samples.reduce((n,s)=>n+2*(s.estimatedTokens+1450),0),outputTokens:requests*1450,windowKnown:o.windowKnown??false}
  return {...quote,summary:checkupEstimateSummary(quote,o.full)}
}
