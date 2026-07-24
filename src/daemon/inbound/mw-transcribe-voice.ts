/**
 * mw-transcribe-voice — inbound STT (voice arc, symmetric to outbound TTS).
 * Runs AFTER mwAttachments (the .amr is now a real inbox file) and BEFORE
 * dispatch, so a transcribed voice message reaches the bot as text.
 *
 * A MATERIALIZED voice attachment (path ≠ PENDING_CDN_REF) is itself the
 * signal that WeChat gave us NO ASR text: poll-loop only builds the voice
 * attachment in the else-branch where `voice_item.text` was absent; when
 * WeChat's own ASR is present it goes straight into the message text and no
 * attachment is created. So there's nothing else to check.
 *
 * Fail-safe / zero-regression: STT unconfigured (transcribe throws
 * `no_stt_config`), a network error, or an empty transcript all leave
 * ctx.msg.text and the attachment UNTOUCHED — the bot still sees the .amr,
 * exactly as before STT existed. One clip's failure never aborts the others.
 */
import { readFile as fsReadFile } from 'node:fs/promises'
import type { Middleware, InboundCtx } from './types'
import { PENDING_CDN_REF } from '../media'

export interface TranscribeVoiceMwDeps {
  /** Injected = ilink.voice.transcribe (loads STT config, throws
   *  `no_stt_config` when unset). Absent → the middleware is a no-op. */
  transcribeVoice?: (audio: Buffer, mime: string) => Promise<{ text: string }>
  readFile?: (path: string) => Promise<Buffer>
  log: (tag: string, line: string) => void
}

/** Rough mime from the inbox filename ext (WeChat voice = .amr). whisper
 *  decodes by content, so this is only a best-effort hint for the server. */
function mimeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return ext === 'amr' ? 'audio/amr'
    : ext === 'mp3' ? 'audio/mpeg'
    : ext === 'ogg' ? 'audio/ogg'
    : ext === 'wav' ? 'audio/wav'
    : 'application/octet-stream'
}

export function makeMwTranscribeVoice(deps: TranscribeVoiceMwDeps): Middleware {
  const readFile = deps.readFile ?? ((p: string) => fsReadFile(p).then(b => Buffer.from(b)))
  return async (ctx: InboundCtx, next) => {
    const transcribe = deps.transcribeVoice
    const atts = ctx.msg.attachments
    if (transcribe && atts) {
      for (const att of atts) {
        if (att.kind !== 'voice' || !att.path || att.path === PENDING_CDN_REF) continue
        try {
          const buf = await readFile(att.path)
          const { text } = await transcribe(buf, mimeFor(att.path))
          const clean = (text ?? '').trim()
          if (!clean) continue
          const line = `[语音] ${clean}`
          // Replace the poll-loop placeholder; otherwise append a line.
          ctx.msg.text = (!ctx.msg.text || ctx.msg.text === '(non-text message)')
            ? line
            : `${ctx.msg.text}\n${line}`
          deps.log('STT', `transcribed ${att.path} (${clean.length} chars)`)
        } catch (err) {
          // Zero-regression: leave text + attachment as-is; the bot still
          // sees the .amr. Never abort the rest of the loop or the turn.
          deps.log('STT', `transcribe failed for ${att.path}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
    await next()
  }
}
