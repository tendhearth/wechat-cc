import { describe, expect, it, vi } from 'vitest'
import { makeCooldown, makeTenorSource } from './sticker-source'

describe('Tenor sticker source', () => {
  it('searches with the safe filter and extracts GIFs', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ results: [{ id: '1', media_formats: { gif: { url: 'https://x/1.gif' } } }] }), { status: 200 })) as unknown as typeof globalThis.fetch
    const hits = await makeTenorSource({ apiKey: 'KEY', fetch }).search('comforting hug', { limit: 2 })
    expect(hits).toEqual([{ id: '1', url: 'https://x/1.gif' }])
    const url = String((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0])
    expect(url).toContain('contentfilter=high')
    expect(url).toContain('q=comforting+hug')
  })
  it('never throws on search/download network errors', async () => {
    const fetch = vi.fn(async () => { throw new Error('offline') }) as unknown as typeof globalThis.fetch
    const source = makeTenorSource({ apiKey: 'KEY', fetch })
    expect(await source.search('x')).toEqual([])
    expect(await source.download('https://x/a.gif')).toBeNull()
  })
  it('rejects unsupported and oversized downloads', async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array(11))) as unknown as typeof globalThis.fetch
    const source = makeTenorSource({ apiKey: 'KEY', fetch, maxBytes: 10 })
    expect(await source.download('https://x/a.svg')).toBeNull()
    expect(await source.download('https://x/a.gif')).toBeNull()
  })
})

describe('makeCooldown', () => {
  it('tracks each key independently', () => {
    const cooldown = makeCooldown(1000)
    expect(cooldown.ready('a', 0)).toBe(true)
    expect(cooldown.ready('a', 500)).toBe(false)
    expect(cooldown.ready('b', 500)).toBe(true)
    expect(cooldown.ready('a', 1000)).toBe(true)
  })
})
