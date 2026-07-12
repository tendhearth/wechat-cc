import type { STTProvider } from './types'
import { Buffer } from 'node:buffer'

export interface HttpSTTProviderOptions {
  /** Full endpoint URL, e.g. 'http://vps:8001/v1/audio/transcriptions'. */
  baseUrl: string
  /** Model id, e.g. 'Systran/faster-whisper-small' or 'whisper-1'. */
  model: string
  /** Optional. Omit for a local/LAN gateway; required for real OpenAI. */
  apiKey?: string
}

export interface HttpSTTProviderDeps {
  /** Injectable for tests. Defaults to global fetch. */
  fetch?: typeof fetch
}

/** Map an error/status to a short, actionable reason (mirrors http-tts). */
function reasonFor(detail: string): string {
  const status = /\b(\d{3})\b/.exec(detail)?.[1]
  return status === '401' ? 'unauthorized (check api key)'
    : status === '404' ? 'endpoint not found (check base_url)'
    : status === '429' ? 'rate limited'
    : /^5\d\d/.test(status ?? '') ? 'stt service error'
    : /ECONNREFUSED|fetch failed/i.test(detail) ? 'cannot connect (is the whisper server running?)'
    : 'unknown'
}

export function makeHttpSTTProvider(opts: HttpSTTProviderOptions, deps?: HttpSTTProviderDeps): STTProvider {
  const doFetch = deps?.fetch ?? fetch

  async function transcribe(audio: Buffer, mime: string): Promise<{ text: string }> {
    const form = new FormData()
    // `.` extension is fine — whisper servers sniff the content; the mime type
    // on the Blob is what matters. Name it by a rough type for server logs.
    const ext = mime.includes('webm') ? 'webm' : mime.includes('ogg') ? 'ogg' : mime.includes('mp3') || mime.includes('mpeg') ? 'mp3' : 'wav'
    form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), `audio.${ext}`)
    form.append('model', opts.model)
    const headers: Record<string, string> = {}
    if (opts.apiKey) headers['Authorization'] = `Bearer ${opts.apiKey}`
    // NB: do NOT set Content-Type — fetch sets the multipart boundary itself.
    const res = await doFetch(opts.baseUrl, { method: 'POST', headers, body: form })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`HTTP STT ${res.status}: ${body.slice(0, 200)}`)
    }
    const json = (await res.json()) as { text?: unknown }
    if (typeof json.text !== 'string') {
      throw new Error('HTTP STT: response missing `text`')
    }
    return { text: json.text }
  }

  async function test(): Promise<{ ok: true } | { ok: false; reason: string; detail?: string }> {
    try {
      // A 0.1s of silence WAV is enough to exercise the endpoint end-to-end.
      await transcribe(silentWav(), 'audio/wav')
      return { ok: true }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return { ok: false, reason: reasonFor(detail), detail }
    }
  }

  return { name: 'http_stt' as const, transcribe, test }
}

/** Minimal 16 kHz mono 16-bit PCM WAV of ~0.1s silence — a valid probe clip. */
function silentWav(): Buffer {
  const sampleRate = 16000
  const samples = Math.floor(sampleRate * 0.1)
  const dataLen = samples * 2
  const buf = Buffer.alloc(44 + dataLen)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataLen, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)          // PCM
  buf.writeUInt16LE(1, 22)          // mono
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataLen, 40)    // the rest is already zero-filled = silence
  return buf
}
