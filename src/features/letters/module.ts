/**
 * CC 的信接进 daemon 的那一份(模块清单在 index.ts):它要的从地基 / 上游模块里填。只有 daemon-modules.ts import 这个文件。
 */
import { log } from '../../lib/log'
import type { DaemonModule } from '../../daemon/modules/container'
import type { Foundation } from '../../daemon/foundation'
import type { Bootstrap } from '../../daemon/bootstrap'
import type { WiredDeps } from '../../daemon/wiring'
import { WECHAT_PORTS as W, type WechatSend } from '../../ports/wechat'
import { resolveCheapEval } from '../memory'
import { lettersFeature } from './index'

export function lettersModule(f: Foundation): DaemonModule<void> {
  const { stateDir, db } = f
  return lettersFeature({
    needs: ['bootstrap', 'wired', W.send],
    deps: (ctx) => {
      const boot = ctx.get<Bootstrap>('bootstrap')
      const wired = ctx.get<WiredDeps>('wired')
      const wxSend = ctx.get<WechatSend>(W.send)
      return {
        stateDir, db,
        providerFor: (c) => { const m = boot.coordinator.getMode(c); return m && m.kind === 'solo' ? m.provider : undefined },
        strongEval: (id) => (typeof boot.registry.getStrongEval === 'function' ? boot.registry.getStrongEval(id as never) : null),
        cheapEval: (c) => resolveCheapEval({ getMode: (x) => boot.coordinator.getMode(x), registry: boot.registry }, c),
        wechatSuspended: () => boot.health.health.shouldSuspend('wechat'),
        speech: wired.speech,
        sendText: (c, t) => wxSend.sendMessage(c, t),
        // 逐页发不逐页记;寄出之后整封记成主人对话里的一行(App 对话页看得见),微信不通时寄到 App(2026-10-18)。
        sendFile: (c, file) => wxSend.sendFile(c, file, { mirror: false }),
        mirror: (c, pages) => wxSend.noteSentMedia?.(c, pages.map(path => ({ kind: 'file' as const, path }))),
        app: () => wired.companionApp,
        holdBusy: (l) => boot.holdBusy(l), log: (t, l) => log(t, l),
      }
    },
  })
}
