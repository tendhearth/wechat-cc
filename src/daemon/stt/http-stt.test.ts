import { describe, it, expect, vi } from 'vitest'
import { Buffer } from 'node:buffer'
import { makeHttpSTTProvider } from './http-stt'

function okResponse(text: string) {
  return { ok: true, status: 200, json: async () => ({ text }), text: async () => '' } as unknown as Response
}
function errResponse(status: number, body = '') {
  return { ok: false, status, json: async () => ({}), text: async () => body } as unknown as Response
}

describe('makeHttpSTTProvider', () => {
  it('transcribes audio and returns the text', async () => {
    const fetchMock = vi.fn(async () => okResponse('你好世界'))
    const p = makeHttpSTTProvider({ baseUrl: 'http://vps/v1/audio/transcriptions', model: 'whisper-small' }, { fetch: fetchMock as unknown as typeof fetch })
    const r = await p.transcribe(Buffer.from('fake-audio'), 'audio/wav')
    expect(r).toEqual({ text: '你好世界' })
  })

  it('POSTs multipart with the model field (and no manual Content-Type)', async () => {
    let seen: { url?: string; init?: RequestInit } = {}
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => { seen = { url, init }; return okResponse('ok') })
    const p = makeHttpSTTProvider({ baseUrl: 'http://vps/v1/audio/transcriptions', model: 'faster-whisper-small', apiKey: 'k' }, { fetch: fetchMock as unknown as typeof fetch })
    await p.transcribe(Buffer.from('a'), 'audio/webm')
    expect(seen.url).toBe('http://vps/v1/audio/transcriptions')
    expect(seen.init?.method).toBe('POST')
    expect(seen.init?.body).toBeInstanceOf(FormData)
    const form = seen.init!.body as FormData
    expect(form.get('model')).toBe('faster-whisper-small')
    expect(form.get('file')).toBeInstanceOf(Blob)
    // Authorization set, Content-Type NOT set (fetch owns the boundary)
    expect((seen.init!.headers as Record<string, string>)['Authorization']).toBe('Bearer k')
    expect((seen.init!.headers as Record<string, string>)['Content-Type']).toBeUndefined()
  })

  it('throws with a mapped reason on non-2xx', async () => {
    const p = makeHttpSTTProvider({ baseUrl: 'http://vps', model: 'm' }, { fetch: (async () => errResponse(404, 'nope')) as unknown as typeof fetch })
    await expect(p.transcribe(Buffer.from('a'), 'audio/wav')).rejects.toThrow(/HTTP STT 404/)
  })

  it('throws when the response has no text field', async () => {
    const bad = { ok: true, status: 200, json: async () => ({ notext: 1 }), text: async () => '' } as unknown as Response
    const p = makeHttpSTTProvider({ baseUrl: 'http://vps', model: 'm' }, { fetch: (async () => bad) as unknown as typeof fetch })
    await expect(p.transcribe(Buffer.from('a'), 'audio/wav')).rejects.toThrow(/missing `text`/)
  })

  it('test() returns ok on a reachable endpoint', async () => {
    const p = makeHttpSTTProvider({ baseUrl: 'http://vps', model: 'm' }, { fetch: (async () => okResponse('')) as unknown as typeof fetch })
    expect(await p.test()).toEqual({ ok: true })
  })

  it('test() maps a 401 to unauthorized', async () => {
    const p = makeHttpSTTProvider({ baseUrl: 'http://vps', model: 'm' }, { fetch: (async () => errResponse(401)) as unknown as typeof fetch })
    const r = await p.test()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/unauthorized/)
  })

  it('passes an AbortSignal so a hung whisper server cannot stall the inbound pipeline forever', async () => {
    let seenSignal: AbortSignal | undefined
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => { seenSignal = init.signal as AbortSignal | undefined; return okResponse('ok') })
    const p = makeHttpSTTProvider({ baseUrl: 'http://vps', model: 'm' }, { fetch: fetchMock as unknown as typeof fetch })
    await p.transcribe(Buffer.from('a'), 'audio/wav')
    expect(seenSignal).toBeInstanceOf(AbortSignal)
  })

  it('a timed-out fetch maps to a "timed out" reason via test()', async () => {
    const p = makeHttpSTTProvider({ baseUrl: 'http://vps', model: 'm', timeoutMs: 5 }, {
      fetch: (async () => { const e = new Error('The operation timed out.'); e.name = 'TimeoutError'; throw e }) as unknown as typeof fetch,
    })
    const r = await p.test()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/timed out/)
  })
})
