import { describe, it, expect, vi } from 'vitest'
import { Buffer } from 'node:buffer'
import { makeRoutes } from './routes'
import type { WechatVoiceDep } from '../wechat-tool-deps'

function routesWith(voice: Partial<WechatVoiceDep> | undefined) {
  return makeRoutes({
    deps: { voice } as never,
    getDelegate: () => null,
    maybePrefix: (_c: string, t: string) => t,
  })
}
function call(table: ReturnType<typeof makeRoutes>, key: string, body: unknown) {
  return table[key]!(new URLSearchParams(), body)
}
const b64 = Buffer.from('fake-audio').toString('base64')

describe('POST /v1/companion/transcribe', () => {
  it('returns {ok,text} on a valid clip', async () => {
    const transcribe = vi.fn(async () => ({ text: '你好世界' }))
    const res = await call(routesWith({ transcribe }), 'POST /v1/companion/transcribe', { audio_b64: b64, mime: 'audio/webm' })
    expect(res).toEqual({ status: 200, body: { ok: true, text: '你好世界' } })
    expect(transcribe).toHaveBeenCalledWith(expect.any(Buffer), 'audio/webm')
  })

  it('defaults mime to audio/wav when omitted', async () => {
    const transcribe = vi.fn(async () => ({ text: 'x' }))
    await call(routesWith({ transcribe }), 'POST /v1/companion/transcribe', { audio_b64: b64 })
    expect(transcribe).toHaveBeenCalledWith(expect.any(Buffer), 'audio/wav')
  })

  it('400 when audio_b64 missing', async () => {
    const res = await call(routesWith({ transcribe: async () => ({ text: '' }) }), 'POST /v1/companion/transcribe', {})
    expect(res.status).toBe(400)
  })

  it('503 when the voice dep lacks transcribe (not wired)', async () => {
    const res = await call(routesWith({}), 'POST /v1/companion/transcribe', { audio_b64: b64 })
    expect(res.status).toBe(503)
  })

  it('422 when unconfigured (provider throws no_stt_config)', async () => {
    const transcribe = vi.fn(async () => { throw new Error('no_stt_config') })
    const res = await call(routesWith({ transcribe }), 'POST /v1/companion/transcribe', { audio_b64: b64 })
    expect(res.status).toBe(422)
    expect((res.body as { error: string }).error).toBe('no_stt_config')
  })

  it('500 on an unexpected provider error', async () => {
    const transcribe = vi.fn(async () => { throw new Error('gateway exploded') })
    const res = await call(routesWith({ transcribe }), 'POST /v1/companion/transcribe', { audio_b64: b64 })
    expect(res.status).toBe(500)
  })
})

describe('GET /v1/stt/status', () => {
  it('returns sttStatus() verbatim', async () => {
    const status = { configured: true as const, provider: 'http_stt' as const, base_url: 'http://vps', model: 'm', saved_at: 'x' }
    const res = await call(routesWith({ sttStatus: () => status }), 'GET /v1/stt/status', undefined)
    expect(res).toEqual({ status: 200, body: status })
  })
  it('503 when not wired', async () => {
    expect((await call(routesWith({}), 'GET /v1/stt/status', undefined)).status).toBe(503)
  })
})

describe('POST /v1/stt/save_config', () => {
  it('forwards to saveSTTConfig and returns its result', async () => {
    const saveSTTConfig = vi.fn(async () => ({ ok: true as const, tested_ms: 12, base_url: 'http://vps', model: 'm' }))
    const res = await call(routesWith({ saveSTTConfig }), 'POST /v1/stt/save_config', { base_url: 'http://vps', model: 'm' })
    expect(res.status).toBe(200)
    expect((res.body as { ok: boolean }).ok).toBe(true)
    expect(saveSTTConfig).toHaveBeenCalledWith({ base_url: 'http://vps', model: 'm' })
  })
})
