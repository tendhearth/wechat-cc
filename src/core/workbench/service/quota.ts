/**
 * quota 域:各执行者的额度/限流登记处 + 「交给谁继续」的候选。
 * 从 service.ts 逐字搬来(spec 2026-09-27-workbench-service-split §3 第 3 项);只认 ctx。
 * 登记处本体交回 service.ts(execute / requireInput / attention 直接 note / clear / exhausted),
 * 所以这里返回的是**同一个实例**,不是快照。
 */
import { makeQuotaRegistry, type QuotaState } from '../../provider-quota'
import { isWorkbenchExecutorCapabilities, isWorkbenchProviderId } from '../executor-capabilities'
import type { ServiceCtx } from './ctx'

export interface QuotaDomain {
  /** 登记处本体:execute / requireInput / attention 直接用 note / clear / exhausted。 */
  quota: ReturnType<typeof makeQuotaRegistry>
  fallbackExecutor(exhaustedId:string): string|null
  providerQuota(): Record<string,QuotaState>
  quotaExhausted(providerId:string): QuotaState|null
}

export function makeQuotaDomain(ctx:ServiceCtx):QuotaDomain {
  /** 各执行者的额度/限流状态(provider-quota.ts):从失败里认出来、记住、再避开。 */
  const quota=makeQuotaRegistry(Date.now,ctx.deps.usage)
  /** 除了 exhaustedId 之外、已准入且没耗尽的原生执行者 —— "交给谁继续"的候选。 */
  function fallbackExecutor(exhaustedId:string):string|null {
    for(const id of ctx.deps.registry.list()){
      if(id===exhaustedId||!isWorkbenchProviderId(id))continue
      const p=ctx.deps.registry.get(id);if(!p||!isWorkbenchExecutorCapabilities(p.opts.workbench)||p.opts.workbench.background!=='tracked')continue
      if(quota.exhausted(id))continue
      return id
    }
    return null
  }

  return {
    quota,fallbackExecutor,
    /** 各执行者的额度/限流状态快照;没登记的不在里面。 */
    providerQuota():Record<string,QuotaState>{return quota.snapshot()},
    /** 这家现在还能用吗;null = 能。 */
    quotaExhausted(providerId:string):QuotaState|null{return quota.exhausted(providerId)},
  }
}
