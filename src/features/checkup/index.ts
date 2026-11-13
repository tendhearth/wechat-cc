import type { DaemonModule, ModuleCtx } from '../../daemon/modules/container'
import type { InternalApiLifecycle } from '../../daemon/internal-api/lifecycle'
import { makeCheckupService, type CheckupServiceDeps, type CheckupService } from './service'
import { checkupRoutes } from './routes'
export { makeCheckupService } from './service'
export { makeCheckupTurn } from './runner'
export type { CheckupService, CheckupServiceDeps, CheckupOptions } from './service'

export function checkupFeature(o:{needs:readonly string[];deps(ctx:ModuleCtx):CheckupServiceDeps}):DaemonModule<CheckupService> {
  return {name:'checkup',optional:true,needs:['internal-api',...o.needs],init(ctx){
    const service=makeCheckupService(o.deps(ctx))
    ctx.get<InternalApiLifecycle>('internal-api').mount('checkup',checkupRoutes(service))
    ctx.interval('small-probe',60*60_000,()=>service.probeIfDue())
    ctx.own('cancel-checkup',()=>service.stop())
    return service
  }}
}
