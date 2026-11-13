import type { DaemonModule } from '../../daemon/modules/container'
import type { Foundation } from '../../daemon/foundation'
import type { Bootstrap } from '../../daemon/bootstrap'
import { ownerChatIdOf } from '../../daemon/owner-chat'
import { providerCallTarget } from '../../app/provider-registry'
import { APP_VERSION } from '../../lib/app-version'
import { makeCheckupStore, checkupAddress } from '../../adapters/store/checkup-store'
import { DEFAULT_CHECKUP_WINDOW } from '../../domain/butler-checkup'
import { checkupFeature, makeCheckupTurn, type CheckupService } from './index'

export function checkupModule(f:Foundation):DaemonModule<CheckupService> {
  return checkupFeature({needs:['bootstrap'],deps(ctx){
    const boot=ctx.get<Bootstrap>('bootstrap')
    return {
      store:makeCheckupStore(f.stateDir),version:APP_VERSION,
      resolveTarget(o={}) {
        const owner=ownerChatIdOf(f.stateDir), mode=owner?boot.conversationStore.get(owner)?.mode:null
        const provider=o.providerId ?? (mode?.kind==='solo'?mode.provider:mode?.kind==='primary_tool'?mode.primary:boot.defaultProviderId)
        const model=o.model ?? (!o.providerId && mode?.kind==='solo'?mode.model:undefined) ?? boot.currentModelFor?.(provider)
        const entry=boot.registry.get(provider)
        const target=providerCallTarget(entry?.provider,provider,'session',model?{model}:{})
        return {provider,model:model??target.model??'default',address:checkupAddress(target.baseUrl??'default'),windowTokens:DEFAULT_CHECKUP_WINDOW,windowKnown:false}
      },
      run:makeCheckupTurn(id=>boot.registry.get(id)?.provider??null),
    }
  }})
}
