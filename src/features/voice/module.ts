/**
 * 语音(出站 TTS)接进 daemon 的那一份(模块清单在 index.ts)。只有 daemon-modules.ts import 这个文件。
 */
import type { DaemonModule } from '../../daemon/modules/container'
import { WECHAT_PORTS as W, type WechatVoice } from '../../ports/wechat'
import { voiceFeature } from './index'

/** 语音口还是 ilink 适配器造的那一份(发送绑着 ilink),这里原样交过去。 */
export function voiceModule(): DaemonModule<void> {
  return voiceFeature({
    needs: [W.voice],
    deps: (ctx) => ({ voice: ctx.get<WechatVoice>(W.voice) }),
  })
}
