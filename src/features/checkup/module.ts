import type { DaemonModule } from '../../daemon/modules/container'
import type { Foundation } from '../../daemon/foundation'
import type { Bootstrap } from '../../daemon/bootstrap'
import { ownerChatIdOf } from '../../daemon/owner-chat'
import { providerCallTarget } from '../../app/provider-registry'
import { makeMtimeCachedConfigReader } from '../../lib/agent-config'
import { APP_VERSION } from '../../lib/app-version'
import { makeCheckupStore, checkupAddress } from '../../adapters/store/checkup-store'
import type { WorkbenchService } from '../workbench'
import type { MemoryFeature } from '../memory'
import { DEFAULT_CHECKUP_WINDOW } from '../../domain/butler-checkup'
import { checkupFeature, makeCheckupTurn, type CheckupService } from './index'

export function checkupModule(f:Foundation):DaemonModule<CheckupService> {
  return checkupFeature({needs:['bootstrap','memory','workbench'],deps(ctx){
    const boot=ctx.get<Bootstrap>('bootstrap'),config=makeMtimeCachedConfigReader(f.stateDir)
    return {
      holdBusy:boot.holdBusy,
      store:makeCheckupStore(f.stateDir),version:APP_VERSION,
      persona:()=>ctx.get<MemoryFeature>('memory').promptReads.personaFor(ownerChatIdOf(f.stateDir)??'checkup').content??'',
      executors:()=>ctx.get<WorkbenchService>('workbench').availableExecutors(),
      resolveTarget(o={}) {
        const owner=ownerChatIdOf(f.stateDir), mode=owner?boot.conversationStore.get(owner)?.mode:null
        const provider=o.providerId ?? (mode?.kind==='solo'?mode.provider:mode?.kind==='primary_tool'?mode.primary:boot.defaultProviderId)
        const model=o.model ?? (!o.providerId && mode?.kind==='solo'?mode.model:undefined) ?? boot.currentModelFor?.(provider)
        const entry=boot.registry.get(provider)
        const target=providerCallTarget(entry?.provider,provider,'session',model?{model}:{})
        const actualModel=o.model??target.model??model??'default',address=checkupAddress(target.baseUrl??'default')
        const configured=config().modelContextWindows?.filter(w=>w.provider===provider&&w.model===actualModel&&checkupAddress(w.address)===address)??[]
        const observed=entry?.provider.contextWindowTokens?.(actualModel)
        const capacity=Number.isSafeInteger(observed)&&observed!>=1024&&observed!<=10_000_000?observed:configured.length===1?configured[0]!.windowTokens:undefined
        return {provider,model:actualModel,address,windowTokens:capacity??DEFAULT_CHECKUP_WINDOW,windowKnown:capacity!==undefined}
      },
      async prepareTarget(o={}){
        const t=this.resolveTarget(o)
        if(!t.windowKnown)await boot.registry.get(t.provider)?.provider.prepareContextWindow?.(t.model)
      },
      run:makeCheckupTurn(id=>boot.registry.get(id)?.provider??null),
    }
  }})
}
