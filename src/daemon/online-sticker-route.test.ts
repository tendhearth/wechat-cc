import { describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { makeRoutes } from './internal-api/routes'

function route(deps: Record<string, unknown>) {
  const routes = makeRoutes({
    deps: { stateDir: '/tmp', daemonPid: 1, ...deps },
    getDelegate: () => null,
    maybePrefix: (_chat, text) => text,
  })
  return routes['POST /v1/wechat/search_online_sticker']!
}

const ilink = (sendFile: (chatId: string, path: string) => Promise<void> = vi.fn(async () => {})) => ({
  sendReply: vi.fn(async () => ({ msgId: '1' })), sendFile,
  editMessage: vi.fn(async () => {}), broadcast: vi.fn(async () => ({ ok: 0, failed: 0 })),
})

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
    const result = await route({ source, stickerSource: source, stickers, ilink: ilink(sendFile) })(new URLSearchParams(), { chat_id: 'c', mood: '安慰', query: 'hug' })
    expect(result.body).toEqual({ ok: true, source: 'local', file: 'local.gif' })
    expect(source.search).not.toHaveBeenCalled()
  })

  it('downloads, sends, then saves and cleans scratch', async () => {
    let sentPath = ''
    const sendFile = vi.fn(async (_chat: string, path: string) => { sentPath = path; expect(existsSync(path)).toBe(true) })
    const save = vi.fn(() => ({ file: 'saved.gif', tags: ['安慰'] }))
    const result = await route({
      stickerSource: { search: async () => [{ id: '1', url: 'https://x/1.gif' }], download: async () => ({ bytes: new Uint8Array([1]), ext: 'gif' }) },
      stickers: { list: () => [], resolve: () => null, save, allTags: () => [] }, ilink: ilink(sendFile),
    })(new URLSearchParams(), { chat_id: 'c', mood: '安慰', query: 'hug' })
    expect(result.body).toEqual({ ok: true, source: 'online', file: 'saved.gif' })
    expect(save).toHaveBeenCalledAfter(sendFile)
    expect(existsSync(sentPath)).toBe(false)
  })
})
