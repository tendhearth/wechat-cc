/**
 * STT provider abstraction for wechat-cc inbound voice (voice arc Stage 2).
 *
 * Mirror of tts/types.ts. v1 has one impl: makeHttpSTTProvider — the
 * OpenAI-compatible `/v1/audio/transcriptions` shape (multipart audio → {text}),
 * covering a gateway whisper server (faster-whisper-server / speaches / real
 * OpenAI) with the same config the TTS side already uses for the gateway.
 */
import type { Buffer } from 'node:buffer'

export interface STTProvider {
  readonly name: 'http_stt'
  /** Transcribe an audio clip to text. `mime` is the clip's content type (e.g. audio/wav, audio/webm). */
  transcribe(audio: Buffer, mime: string): Promise<{ text: string }>
  /** Reachability check used by save_stt_config before persisting. Mirrors TTSProvider.test(). */
  test(): Promise<{ ok: true } | { ok: false; reason: string; detail?: string }>
}
