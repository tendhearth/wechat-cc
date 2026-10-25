import { describe, expect, it, vi } from 'vitest'
import { ArtworkRendererError, makeOpenAiImageRenderer, validatePngBytes } from './artwork-renderer'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const PNG_B64 = Buffer.from(PNG).toString('base64')
const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe('validatePngBytes', () => {
  it('returns the bytes for a valid PNG within the cap', () => {
    const bytes = new Uint8Array([...PNG_MAGIC, 1, 2, 3])
    expect(validatePngBytes(bytes, 1024)).toBe(bytes)
  })

  it('rejects non-PNG bytes', () => {
    expect(() => validatePngBytes(new Uint8Array([1, 2, 3]), 1024)).toThrow(ArtworkRendererError)
  })

  it('rejects empty bytes', () => {
    expect(() => validatePngBytes(new Uint8Array([]), 1024)).toThrow(ArtworkRendererError)
  })

  it('rejects bytes over the cap with renderer_output_too_large', () => {
    const bytes = new Uint8Array([...PNG_MAGIC, ...new Array(100).fill(0)])
    try {
      validatePngBytes(bytes, PNG_MAGIC.length + 10)
      throw new Error('should have thrown')
    } catch (error) {
      expect((error as ArtworkRendererError).code).toBe('renderer_output_too_large')
    }
  })
})

describe('OpenAI artwork renderer (Phase 0)', () => {
  it('posts a single image request and returns validated local bytes', async () => {
    const fetch = vi.fn(async () => new Response(
      JSON.stringify({ data: [{ b64_json: PNG_B64 }] }),
      { status: 200, headers: { 'x-request-id': 'req_atelier_1' } },
    )) as unknown as typeof globalThis.fetch
    let clock = 100
    const renderer = makeOpenAiImageRenderer({ apiKey: 'test-key', fetch, now: () => (clock += 25) })

    const result = await renderer.render({ prompt: 'wet sand, two unfinished fish', quality: 'medium' })

    expect(result).toMatchObject({ mime: 'image/png', rendererId: 'openai-image:gpt-image-2', requestId: 'req_atelier_1', elapsedMs: 25 })
    expect(result.bytes).toEqual(PNG)
    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(url).toBe('https://api.openai.com/v1/images/generations')
    expect((init as RequestInit).headers).toEqual({ authorization: 'Bearer test-key', 'content-type': 'application/json' })
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      model: 'gpt-image-2', prompt: 'wet sand, two unfinished fish', n: 1, quality: 'medium', size: '1024x1024',
    })
  })

  it('requires an explicit API key and never falls back to the chat provider', () => {
    expect(() => makeOpenAiImageRenderer({ apiKey: '  ' })).toThrowError(ArtworkRendererError)
    try { makeOpenAiImageRenderer({ apiKey: '' }) } catch (error) {
      expect(error).toMatchObject({ code: 'renderer_auth_missing' })
    }
  })

  it('fails closed on HTTP errors without echoing provider bodies or the prompt', async () => {
    const fetch = vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'secret provider detail' } }),
      { status: 401, headers: { 'x-request-id': 'req_failed' } },
    )) as unknown as typeof globalThis.fetch
    const renderer = makeOpenAiImageRenderer({ apiKey: 'test-key', fetch })
    const error = await renderer.render({ prompt: 'private visual prompt' }).catch((value: unknown) => value)
    expect(error).toMatchObject({ code: 'renderer_http_error', status: 401 })
    expect(String(error)).not.toContain('secret provider detail')
    expect(String(error)).not.toContain('private visual prompt')
    expect(String(error)).not.toContain('test-key')
  })

  it('rejects missing, non-PNG, and oversized image payloads', async () => {
    const cases = [
      { body: { data: [] }, maxBytes: 100, code: 'renderer_bad_output' },
      { body: { data: [{ b64_json: Buffer.from('not-png').toString('base64') }] }, maxBytes: 100, code: 'renderer_bad_output' },
      { body: { data: [{ b64_json: PNG_B64 }] }, maxBytes: 8, code: 'renderer_output_too_large' },
    ]
    for (const testCase of cases) {
      const fetch = vi.fn(async () => new Response(JSON.stringify(testCase.body), { status: 200 })) as unknown as typeof globalThis.fetch
      const renderer = makeOpenAiImageRenderer({ apiKey: 'test-key', fetch, maxBytes: testCase.maxBytes })
      await expect(renderer.render({ prompt: 'safe prompt' })).rejects.toMatchObject({ code: testCase.code })
    }
  })

  it('aborts one paid attempt on timeout and performs no automatic retry', async () => {
    const fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })) as unknown as typeof globalThis.fetch
    const renderer = makeOpenAiImageRenderer({ apiKey: 'test-key', fetch, timeoutMs: 5 })
    await expect(renderer.render({ prompt: 'safe prompt' })).rejects.toMatchObject({ code: 'renderer_timeout' })
    expect(fetch).toHaveBeenCalledOnce()
  })
})

