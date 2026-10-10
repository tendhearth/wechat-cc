import { describe, it, expect, vi, afterEach } from 'vitest'
import { downloadCdnMedia, CDN_DOWNLOAD_TIMEOUT_MS, MAX_INBOUND_MEDIA_BYTES } from './media'

const originalFetch = globalThis.fetch

// 入站附件是在轮询循环里同步下载的:CDN 卡住 ⇒ 整个账号的收消息都停,心跳也停。
describe('downloadCdnMedia limits', () => {
  afterEach(() => { globalThis.fetch = originalFetch; vi.useRealTimers() })

  it('a stalled CDN connection rejects after the timeout instead of hanging the poll loop', async () => {
    vi.useFakeTimers()
    globalThis.fetch = vi.fn((_u: string, init?: RequestInit) => new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    })) as never
    const p = downloadCdnMedia({ full_url: 'https://cdn.example/x' })
    const settled = expect(p).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(CDN_DOWNLOAD_TIMEOUT_MS + 1)
    await settled
  })

  it('refuses an oversized body by Content-Length before reading it', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0))
    globalThis.fetch = vi.fn(async () => ({
      ok: true, status: 200, statusText: 'OK',
      headers: new Headers({ 'content-length': String(MAX_INBOUND_MEDIA_BYTES + 1) }),
      arrayBuffer,
    })) as never
    await expect(downloadCdnMedia({ full_url: 'https://cdn.example/x' })).rejects.toThrow(/too large/)
    expect(arrayBuffer).not.toHaveBeenCalled()
  })
})
