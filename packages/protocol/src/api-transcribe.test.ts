import { describe, expect, it } from 'vitest'
import { PHONE_API_SCHEMAS, PHONE_TRANSCRIBE_MAX_BYTES, PHONE_TRANSCRIBE_MAX_SECONDS, PHONE_TRANSCRIBE_MIMES } from './index'
import { b64Encode } from './messages'
import { makeV2Channel } from './v2'
import { sealV1 } from './v1'

/** 中继一帧的上限(apps/relay/src/limits.ts maxFrameBytes);中继转给 daemon 时外面再包一层 {stream,frame},留 4 KiB。 */
const RELAY_FRAME_BYTES = 512 * 1024
const ENVELOPE_SLACK = 4 * 1024

describe('按住说话(2026-10-18)', () => {
  it('GET / POST 的成功与失败形状都登记了', () => {
    const g = PHONE_API_SCHEMAS['GET /m/api/chat/transcribe']!
    expect(g.parse({ ok: true, configured: false })).toEqual({ ok: true, configured: false })
    expect(() => g.parse({ ok: true })).toThrow()
    const p = PHONE_API_SCHEMAS['POST /m/api/chat/transcribe']!
    expect(p.parse({ ok: true, text: '明天提醒我交周报' })).toEqual({ ok: true, text: '明天提醒我交周报' })
    expect(p.parse({ ok: false, error: 'stt_not_configured' })).toEqual({ ok: false, error: 'stt_not_configured' })
    expect(() => p.parse({ ok: true })).toThrow()
  })

  it('60 秒 16 kHz 单声道 AAC 24 kbps 装得进上限(留出 m4a 封装)', () => {
    expect(PHONE_TRANSCRIBE_MAX_SECONDS).toBe(60)
    const audio = (24_000 / 8) * PHONE_TRANSCRIBE_MAX_SECONDS
    expect(audio + 8 * 1024).toBeLessThan(PHONE_TRANSCRIBE_MAX_BYTES)
    expect(PHONE_TRANSCRIBE_MIMES).toContain('audio/mp4')
  })

  it('上限那么大的一段,v2 / v1 密封后的整帧仍在中继一帧之内', () => {
    const body = JSON.stringify({ mime: 'audio/mp4', audioBase64: b64Encode(new Uint8Array(PHONE_TRANSCRIBE_MAX_BYTES).fill(0xab)) })
    const req = JSON.stringify({ t: 'req', rid: 'r'.repeat(36), method: 'POST', path: '/m/api/chat/transcribe', headers: { 'content-type': 'application/json' }, body, bodyEncoding: 'utf8' })
    const pt = new TextEncoder().encode(req)
    const key = new Uint8Array(32).fill(7)
    const v2 = JSON.stringify(makeV2Channel({ c2s: key, s2c: key }, 'client').seal(pt))
    const v1 = JSON.stringify(sealV1(key, new TextEncoder().encode(JSON.stringify({ path: '/m/api/chat/transcribe', method: 'POST', rid: 'r'.repeat(36), body }))))
    for (const frame of [v2, v1]) expect(frame.length + ENVELOPE_SLACK).toBeLessThan(RELAY_FRAME_BYTES)
  })
})
