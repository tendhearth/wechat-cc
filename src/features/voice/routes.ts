/**
 * 语音的路由(出站 TTS 为主;App 语音转文字的三条也在这里,因为它们和 TTS 用的是同一个语音口 `WechatVoice`)。
 *   GET  /v1/voice/status          —— TTS 配置状态(不带 api_key)
 *   POST /v1/voice/save_config     —— 先试合成一句,通过才存
 *   POST /v1/wechat/reply_voice    —— 合成后当文件发到微信(模型的 reply_voice 工具)
 *   POST /v1/companion/speak       —— 合成后把音频交回调用方,不经微信(语音线第 1 步)
 *   POST /v1/companion/transcribe  —— App 那一路的语音 → 文字(语音线第 2 步)
 *   POST /v1/stt/save_config、GET /v1/stt/status —— 语音识别的配置
 * 由 voice 模块自己挂(internalApi.mount;路由表标了 module: 'voice')。模块没起来 ⇒ 路由层回 module_*,
 * 处理器里不再写 voice_not_wired;只有 STT 那三样在接口上是可选的,缺了照旧回 voice_not_wired。
 * 本轮回复的语音附件(POST /v1/turn/attach kind=voice)交付时经路由表复用这里的 reply_voice。
 */
import { errMsg, type RouteTable } from '../../daemon/internal-api/types'
import type { VoiceSaveConfigRequestT, WechatReplyVoiceRequestT } from '../../daemon/internal-api/schema'
import type { WechatVoice } from '../../ports/wechat'

export interface VoiceRoutesDeps {
  voice: WechatVoice
}

export function voiceRoutes(d: VoiceRoutesDeps): RouteTable {
  return {
    'GET /v1/voice/status': () => {
      // configStatus is sync, never throws — direct return.
      return { status: 200, body: d.voice.configStatus() }
    },
    'POST /v1/wechat/reply_voice': async (_q, body) => {
      // Body is pre-validated by index.ts via WechatReplyVoiceRequest schema.
      const { chat_id, text } = body as WechatReplyVoiceRequestT
      // Business rule: enforce 500-char cap with structured reason, not schema validation.
      // Schema is structural (shape), not business (value range).
      if (text.length > 500) {
        return { status: 200, body: { ok: false, reason: 'too_long', limit: 500 } }
      }
      try {
        const r = await d.voice.replyVoice(chat_id, text)
        return { status: 200, body: r }
      } catch (err) {
        return { status: 200, body: { ok: false, reason: 'unexpected_error', detail: errMsg(err) } }
      }
    },

    // ── companion speak (app-conversation-channel, voice arc Stage 1) ──
    // Synthesizes reply audio for arbitrary text via the daemon's voice
    // config and hands the bytes back to the caller (base64) instead of
    // ilink-sending — reuses d.voice.synthesizeSpeech, which mirrors
    // replyVoice's synth step exactly, minus the wechat upload/send.
    'POST /v1/companion/speak': async (_q, body) => {
      const { text } = body as { text?: unknown }
      if (typeof text !== 'string' || text.trim().length === 0) {
        return { status: 400, body: { error: 'text required' } }
      }
      if (text.length > 5000) {
        return { status: 400, body: { error: 'text too long' } }
      }
      try {
        const { audio, mime } = await d.voice.synthesizeSpeech(text)
        return { status: 200, body: { ok: true, audio_b64: audio.toString('base64'), mime } }
      } catch (err) {
        const m = errMsg(err)
        if (/no.?voice.?config|not configured/i.test(m)) {
          return { status: 422, body: { ok: false, error: 'no_voice_config' } }
        }
        return { status: 500, body: { ok: false, error: m } }
      }
    },

    // ── companion transcribe (app-conversation-channel, voice arc Stage 2) ──
    // Inbound audio (base64) → gateway STT → text. Mirror of /speak.
    'POST /v1/companion/transcribe': async (_q, body) => {
      if (!d.voice.transcribe) return { status: 503, body: { error: 'voice_not_wired' } }
      const { audio_b64, mime } = (body ?? {}) as { audio_b64?: unknown; mime?: unknown }
      if (typeof audio_b64 !== 'string' || audio_b64.length === 0) {
        return { status: 400, body: { error: 'audio_b64 required' } }
      }
      let audio: Buffer
      try {
        audio = Buffer.from(audio_b64, 'base64')
      } catch {
        return { status: 400, body: { error: 'audio_b64 must be valid base64' } }
      }
      if (audio.length === 0) return { status: 400, body: { error: 'audio_b64 decoded to empty' } }
      if (audio.length > 25 * 1024 * 1024) return { status: 413, body: { error: 'audio too large (max 25MB)' } }
      try {
        const { text } = await d.voice.transcribe(audio, typeof mime === 'string' && mime ? mime : 'audio/wav')
        return { status: 200, body: { ok: true, text } }
      } catch (err) {
        const m = errMsg(err)
        if (/no.?stt.?config/i.test(m)) return { status: 422, body: { ok: false, error: 'no_stt_config' } }
        return { status: 500, body: { ok: false, error: m } }
      }
    },

    'POST /v1/stt/save_config': async (_q, body) => {
      if (!d.voice.saveSTTConfig) return { status: 503, body: { error: 'voice_not_wired' } }
      const { base_url, model, api_key } = (body ?? {}) as { base_url?: unknown; model?: unknown; api_key?: unknown }
      try {
        const r = await d.voice.saveSTTConfig({
          ...(typeof base_url === 'string' ? { base_url } : {}),
          ...(typeof model === 'string' ? { model } : {}),
          ...(typeof api_key === 'string' ? { api_key } : {}),
        })
        return { status: 200, body: r }
      } catch (err) {
        return { status: 200, body: { ok: false, reason: 'unexpected_error', detail: errMsg(err) } }
      }
    },

    'GET /v1/stt/status': () => {
      if (!d.voice.sttStatus) return { status: 503, body: { error: 'voice_not_wired' } }
      return { status: 200, body: d.voice.sttStatus() }
    },

    'POST /v1/voice/save_config': async (_q, body) => {
      // Body is pre-validated by index.ts via VoiceSaveConfigRequest schema.
      const { provider, base_url, model, api_key, default_voice } = body as VoiceSaveConfigRequestT
      // saveConfig handles its own validation + test-synth; surface its
      // ok-true / ok-false-reason verbatim. Catch transport-level
      // unexpected errors and shape them into the same {ok:false,reason}
      // contract so the agent sees a structured failure.
      try {
        const r = await d.voice.saveConfig({
          provider,
          ...(base_url !== undefined ? { base_url } : {}),
          ...(model !== undefined ? { model } : {}),
          ...(api_key !== undefined ? { api_key } : {}),
          ...(default_voice !== undefined ? { default_voice } : {}),
        })
        return { status: 200, body: r }
      } catch (err) {
        return { status: 200, body: { ok: false, reason: 'unexpected_error', detail: errMsg(err) } }
      }
    },
  }
}
