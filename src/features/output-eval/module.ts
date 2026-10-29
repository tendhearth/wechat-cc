/**
 * 输出评测接进 daemon 的那一份(模块清单在 index.ts)。只有 daemon-modules.ts import 这个文件。
 */
import { rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../../lib/log'
import type { DaemonModule } from '../../daemon/modules/container'
import type { Foundation } from '../../daemon/foundation'
import type { Bootstrap } from '../../daemon/bootstrap'
import type { InternalApiLifecycle } from '../../daemon/internal-api/lifecycle'
import { outputEvalFeature } from './index'

export function outputEvalModule(f: Foundation): DaemonModule<void> {
  const { stateDir } = f
  return outputEvalFeature({
    needs: ['bootstrap'],
    deps: (ctx) => {
      const boot = ctx.get<Bootstrap>('bootstrap')
      const api = ctx.get<InternalApiLifecycle>('internal-api')
      return {
        registry: boot.registry,
        defaultProviderId: () => boot.defaultProviderId,
        buildInstructions: (p, tp, chatId, model) => boot.buildInstructions(p, tp, chatId, model),
        ...(boot.currentModelFor ? { currentModelFor: boot.currentModelFor } : {}),
        mintSessionToken: (tier, key, o) => api.mintSessionToken(tier, key, o),
        invalidateSession: (key) => api.invalidateSession(key),
        // 只删空目录(rmdir):万一里面真有东西,留着别动
        forgetChat: (chatId) => { try { rmdirSync(join(stateDir, 'memory', chatId)) } catch { /* 没建 / 不空 */ } },
        log: (t, l) => log(t, l),
      }
    },
  })
}
