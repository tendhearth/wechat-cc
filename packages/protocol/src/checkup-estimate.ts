import type { CheckupEstimate } from './checkup'
/** Shared by all three clients through the estimate response. */
export function checkupEstimateSummary(q:Pick<CheckupEstimate,'outputTokens'|'maxOutputTokens'|'maxRequests'>,full=false):string {
  const amount=(n:number,approx=false)=>n>=10_000?`${approx?Math.round(n/10_000):n/10_000} 万`:`${n}`
  return `预计用 ${amount(q.outputTokens,true)}左右、最多不超过 ${amount(q.maxOutputTokens)}输出 token，大约 ${full?'8–15':'3–6'} 分钟。最多发 ${q.maxRequests} 次请求（含重试），到上限就停。只用编造的对话。`
}
