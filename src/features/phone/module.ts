/**
 * 手机接进 daemon 的那一份(模块清单在 index.ts):它要的从上游模块里填。只有 daemon-modules.ts import 这个文件。
 */
import { log } from '../../lib/log'
import type { DaemonModule } from '../../daemon/modules/container'
import type { WiredDeps } from '../../daemon/wiring'
import { phoneFeature } from './index'

/**
 * 这里只挂桌面「连接手机」那两条 `/v1/phone/*`;出码要的设置面板在 wired 里建(手机那一簇的装配还在 wiring/wire-phone.ts)
 * ⇒ 经 lazy 现取,没建好照旧 503 phone_not_wired。
 */
export function phoneModule(): DaemonModule {
  return phoneFeature({
    needs: [],
    lazy: ['wired'],
    deps: (ctx) => {
      const wired = ctx.late<WiredDeps>('wired')
      return { phoneConnect: () => wired()?.phoneConnect ?? null, log: (t, l) => log(t, l) }
    },
  })
}
