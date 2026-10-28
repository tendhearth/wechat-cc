/**
 * 贴纸接进 daemon 的那一份(模块清单在 index.ts):它要的从地基 / 上游模块里填。只有 daemon-modules.ts import 这个文件。
 */
import { log } from '../../lib/log'
import type { DaemonModule } from '../../daemon/modules/container'
import type { Foundation } from '../../daemon/foundation'
import { WECHAT_PORTS as W, type WechatSend } from '../../ports/wechat'
import { stickersFeature, type StickersFeature } from './index'

/** 表情库全 daemon 一份,bootstrap(提示词)和 wired 都要它。 */
export function stickersModule(f: Foundation): DaemonModule<StickersFeature> {
  const { stateDir } = f
  return stickersFeature({
    needs: [W.send],
    deps: (ctx) => {
      const wxSend = ctx.get<WechatSend>(W.send)
      return {
        stateDir, log: (t, l) => log(t, l),
        ilink: { sendFile: (c, p) => wxSend.sendFile(c, p), noteSentMedia: (c, m) => wxSend.noteSentMedia?.(c, m) },
      }
    },
  })
}
