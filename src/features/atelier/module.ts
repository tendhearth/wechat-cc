/**
 * 画室接进 daemon 的那一份(模块清单在 index.ts):它要的从地基 / 上游模块里填。只有 daemon-modules.ts import 这个文件。
 */
import type { DaemonModule } from '../../daemon/modules/container'
import type { Foundation } from '../../daemon/foundation'
import { WECHAT_PORTS as W, type WechatSend } from '../../ports/wechat'
import { atelierFeature } from './index'

/** 路由自己挂;画一拍还在伙伴的反省那一拍里(wiring 经 makeAtelierTick 接)。 */
export function atelierModule(f: Foundation): DaemonModule<void> {
  const { stateDir } = f
  return atelierFeature({
    needs: [W.send],
    deps: (ctx) => ({ stateDir, ilink: ctx.get<WechatSend>(W.send) }),
  })
}
