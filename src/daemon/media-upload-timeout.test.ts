import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { uploadToCdnOnce, cdnUploadTimeoutMs } from './media'

const originalFetch = globalThis.fetch

// CDN 接了上传连接却卡住:fetch 永远不结束 ⇒ sendFile 永远不回、外层三次重试也轮不到。
describe('uploadToCdnOnce timeout', () => {
  let dir = ''
  afterEach(() => { globalThis.fetch = originalFetch; vi.useRealTimers(); if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('a stalled CDN upload rejects with a retryable AbortError instead of hanging', async () => {
    dir = mkdtempSync(join(tmpdir(), 'upl-'))
    const file = join(dir, 'a.png'); writeFileSync(file, Buffer.alloc(1024, 1))
    vi.useFakeTimers()
    globalThis.fetch = vi.fn(async (url: string) => {
      if (String(url).includes('getuploadurl')) return new Response(JSON.stringify({ upload_param: 'p' }), { status: 200 })
      return new Promise(() => { /* CDN never answers */ })
    }) as never
    const p = uploadToCdnOnce({ filePath: file, toUserId: 'u', baseUrl: 'https://ilink.example', token: 't', mediaType: 1 })
    const settled = expect(p).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(cdnUploadTimeoutMs(1024) + 1)
    await settled
  })

  it('budget grows with size so a big file on a slow link is not cut off', () => {
    expect(cdnUploadTimeoutMs(50 * 1024 * 1024)).toBeGreaterThan(cdnUploadTimeoutMs(1024) + 120_000)
  })
})
