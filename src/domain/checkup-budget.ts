/** Run-owned allowance. Reserve before sending so even a full final response fits. */
export interface CheckupLimits { maxOutputTokens:number; maxRequests:number }
export type CheckupBudgetMode = 'request' | 'question'
// Short: 28 questions × 3 steps × 4096 must fit even when a provider reports
// no usage and every reservation stays charged in full (344,064).
export const CHECKUP_LIMITS = {
  short:{maxOutputTokens:350_000,maxRequests:120},
  full:{maxOutputTokens:1_000_000,maxRequests:400},
} as const
export type CheckupLimitSettings = {short?:Partial<CheckupLimits>;full?:Partial<CheckupLimits>}
export function checkupLimits(full:boolean,settings?:CheckupLimitSettings):CheckupLimits {
  const key=full?'full':'short',defaults=CHECKUP_LIMITS[key],overrides=settings?.[key]
  const valid=(n:unknown):n is number=>Number.isSafeInteger(n)&&Number(n)>0
  return {maxOutputTokens:valid(overrides?.maxOutputTokens)?overrides.maxOutputTokens:defaults.maxOutputTokens,maxRequests:valid(overrides?.maxRequests)?overrides.maxRequests:defaults.maxRequests}
}
export const checkupUsageLimit = () => Object.assign(new Error('checkup_usage_limit'),{code:'checkup_usage_limit'})
export interface CheckupReservation {
  maxOutputTokens:number
  maxRequests:number
  settle(usage:{outputTokens?:number;outputBytes?:number;requests?:number;exhausted?:boolean}):void
}
export interface CheckupBudget {
  readonly exhausted:boolean
  readonly usage:{requests:number;outputTokens:number}
  reserve(maxOutputTokens:number,maxRequests?:number,exact?:boolean):CheckupReservation
}
export function makeCheckupBudget(limits:CheckupLimits):CheckupBudget {
  let requests=0,outputTokens=0,chargedTokens=0
  const valid=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n)&&n>=0
  return {
    get exhausted(){return requests>=limits.maxRequests||chargedTokens>=limits.maxOutputTokens},
    get usage(){return {requests,outputTokens}},
    reserve(cap,slots=1,exact=false){
      // Native Claude traffic stays untouched. A whole isolated attempt must
      // fit before its subprocess opens; never shrink its turns or output cap.
      if(exact&&(slots>limits.maxRequests-requests||cap*slots>limits.maxOutputTokens-chargedTokens))throw checkupUsageLimit()
      const count=Math.min(slots,limits.maxRequests-requests,limits.maxOutputTokens-chargedTokens)
      const allowed=Math.min(cap,Math.floor((limits.maxOutputTokens-chargedTokens)/count))
      if(count<1||allowed<1||!Number.isFinite(allowed))throw checkupUsageLimit()
      requests+=count;outputTokens+=allowed*count;chargedTokens+=allowed*count
      let settled=false
      return {maxOutputTokens:allowed,maxRequests:count,settle(u){
        if(settled)return
        settled=true
        // Missing usage: estimate all response blocks, including reasoning and
        // tool arguments. An invisible exhausted response keeps its reservation.
        const used=valid(u.outputTokens)?Math.ceil(u.outputTokens):u.exhausted||!valid(u.outputBytes)?allowed*count:Math.min(allowed*count,Math.ceil(u.outputBytes/3))
        outputTokens+=used-allowed*count
        // A byte estimate cannot prove a tokenizer upper bound, especially for
        // private reasoning. Only complete provider usage refunds the hard gate.
        if(valid(u.outputTokens))chargedTokens+=used-allowed*count
        if(valid(u.requests))requests+=(exact?Math.ceil(u.requests):Math.min(count,Math.ceil(u.requests)))-count
      }}
    },
  }
}
