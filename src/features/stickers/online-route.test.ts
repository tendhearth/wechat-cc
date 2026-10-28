import { describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { stickersRoutes, type StickersRoutesDeps } from './routes'

const noLib = { list: () => [], resolve: () => null, save: vi.fn(), allTags: () => [] } as unknown as StickersRoutesDeps['stickers']
function route(deps: Partial<StickersRoutesDeps>) {
  const routes = stickersRoutes({ stickers: noLib, ilink: { sendFile: vi.fn(async () => {}) }, ...deps })
  return routes['POST /v1/wechat/search_online_sticker']!
}

const ilink = (sendFile: (chatId: string, path: string) => Promise<void> = vi.fn(async () => {})) => ({ sendFile })

describe('search_online_sticker route', () => {
  it('is safely disabled without a provider', async () => {
    const result = await route({})(new URLSearchParams(), { chat_id: 'c', mood: '安慰', query: 'hug' })
    expect(result).toEqual({ status: 503, body: { error: 'sticker_source_not_wired' } })
  })

  it('uses local at K without network', async () => {
    const source = { search: vi.fn(), download: vi.fn() }
    const sendFile = vi.fn(async () => {})
    const stickers = {
      list: () => Array.from({ length: 5 }, (_, i) => ({ file: `${i}.gif`, tags: ['安慰'] })),
      resolve: () => '/tmp/local.gif', save: vi.fn(), allTags: () => ['安慰'],
    }
    const result = await route({ stickerSource: source as unknown as StickersRoutesDeps['stickerSource'], stickers: stickers as unknown as StickersRoutesDeps['stickers'], ilink: ilink(sendFile) })(new URLSearchParams(), { chat_id: 'c', mood: '安慰', query: 'hug' })
    expect(result.body).toEqual({ ok: true, source: 'local', file: 'local.gif' })
    expect(source.search).not.toHaveBeenCalled()
  })

  it('downloads, sends, then saves and cleans scratch', async () => {
    let sentPath = ''
    const sendFile = vi.fn(async (_chat: string, path: string) => { sentPath = path; expect(existsSync(path)).toBe(true) })
    const save = vi.fn(() => ({ file: 'saved.gif', tags: ['安慰'] }))
    const result = await route({
      stickerSource: { search: async () => [{ id: '1', url: 'https://x/1.gif' }], download: async () => ({ bytes: new Uint8Array([1]), ext: 'gif' }) },
      stickers: { list: () => [], resolve: () => null, save, allTags: () => [] } as unknown as StickersRoutesDeps['stickers'], ilink: ilink(sendFile),
    })(new URLSearchParams(), { chat_id: 'c', mood: '安慰', query: 'hug' })
    expect(result.body).toEqual({ ok: true, source: 'online', file: 'saved.gif' })
    expect(save).toHaveBeenCalledAfter(sendFile)
    expect(existsSync(sentPath)).toBe(false)
  })
})
