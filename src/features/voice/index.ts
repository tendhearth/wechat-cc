/**
 * 语音(出站 TTS)—— 一个功能一个目录(架构终态 A5)。CC 用主人配好的声音把一句话念出来:
 * 当文件发到微信(reply_voice / 本轮回复的语音附件),或者把音频交回 App(/v1/companion/speak)。
 *
 *  - `types` / `http-tts` / `qwen` / `fetch-timeout`:合成器(OpenAI 兼容的自建网关 / 通义 DashScope)和统一的超时;
 *  - `voice-config`:voice-config.json 的读写(0600,原子写);
 *  - `routes.ts`:`/v1/voice/*`、`/v1/wechat/reply_voice`、`/v1/companion/speak`,以及和它们同一个语音口的
 *    STT 三条(路由表标了 module: 'voice');
 *  - 这个文件:模块清单。它要的东西(`VoiceRoutesDeps`)由组装的地方(daemon-modules.ts)从上游模块里填。
 *
 * 语音口本身(合成 → 经 ilink 上传发送、网络闸门、媒体镜像)还由 ilink 适配器造(`src/daemon/ilink/voice.ts`):
 * 发送那一步绑着 ilink 的 context_token、账号路由和媒体上传,等 A6 拆 `IlinkAdapter` 窄口时再说;
 * 它经这个文件拿合成器和配置。入站语音转文字(`inbound/mw-transcribe-voice.ts`、`src/daemon/stt`)不归这里。
 * 可选模块:坏了只降级,语音那几条路由回 module_degraded。
 */
import type { DaemonModule, ModuleCtx } from '../../daemon/modules/container'
// 只要 mount 这一口(同画室):ilink/voice.ts 经这个文件拿合成器,引 internal-api/lifecycle 容易成环。
import type { InternalApi } from '../../daemon/internal-api/types'
import { voiceRoutes, type VoiceRoutesDeps } from './routes'

export { loadVoiceConfig, saveVoiceConfig, type VoiceConfig } from './voice-config'
export { makeHttpTTSProvider } from './http-tts'
export { makeQwenProvider } from './qwen'
export type { TTSProvider } from './types'
export type { VoiceRoutesDeps } from './routes'

export function voiceFeature(o: { needs: readonly string[]; deps: (ctx: ModuleCtx) => VoiceRoutesDeps }): DaemonModule<void> {
  return {
    name: 'voice',
    optional: true,
    needs: ['internal-api', ...o.needs],
    init(ctx) {
      ctx.get<Pick<InternalApi, 'mount'>>('internal-api').mount('voice', voiceRoutes(o.deps(ctx)))
    },
  }
}
