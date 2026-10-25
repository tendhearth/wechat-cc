import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInternalApi } from '../../daemon/internal-api'
import { stickersRoutes, type StickersRoutesDeps } from './routes'

// 从 daemon/internal-api.test.ts 搬来(架构终态 A5):处理器直接调;「没挂上」那一种由路由层的模块门回。
const q = new URLSearchParams()

function lib(over: Partial<StickersRoutesDeps['stickers']> = {}): StickersRoutesDeps['stickers'] {
  return { resolve: vi.fn(() => null), save: vi.fn(), list: vi.fn(() => []), allTags: vi.fn(() => []), ...over }
}
function routes(over: Partial<StickersRoutesDeps> = {}) {
  return stickersRoutes({ stickers: lib(), ilink: { sendFile: vi.fn(async () => {}) }, ...over })
}

describe('POST /v1/wechat/send_sticker', () => {
  it('400 on missing chat_id / missing tag', async () => {
    const stickers = lib()
    const r = routes({ stickers })
    expect((await r['POST /v1/wechat/send_sticker']!(q, { tag: 'happy' })).status).toBe(400)
    expect((await r['POST /v1/wechat/send_sticker']!(q, { chat_id: 'c@bot' })).status).toBe(400)
    expect(stickers.resolve).not.toHaveBeenCalled()
  })

  it('no matching sticker ⇒ ok:false with available tags', async () => {
    const r = routes({ stickers: lib({ allTags: vi.fn(() => ['happy', 'sad']) }) })
    const resp = await r['POST /v1/wechat/send_sticker']!(q, { chat_id: 'c@bot', tag: 'angry' })
    expect(resp).toEqual({ status: 200, body: { ok: false, reason: 'no_sticker_for_tag', tags: ['happy', 'sad'] } })
  })

  it('happy path calls ilink.sendFile(chat_id, resolvedPath), remembers it, returns basename', async () => {
    const sendFile = vi.fn(async () => {})
    const remember = vi.fn()
    const r = routes({ stickers: lib({ resolve: vi.fn(() => '/state/stickers/happy.png') }), ilink: { sendFile }, stickerFeedback: { remember, rate: vi.fn() } })
    const resp = await r['POST /v1/wechat/send_sticker']!(q, { chat_id: 'c@bot', tag: 'happy' })
    expect(sendFile).toHaveBeenCalledWith('c@bot', '/state/stickers/happy.png')
    expect(remember).toHaveBeenCalledWith('c@bot', 'happy.png')
    expect(resp).toEqual({ status: 200, body: { ok: true, file: 'happy.png' } })
  })

  it('ilink.sendFile throws ⇒ ok:false+error', async () => {
    const r = routes({ stickers: lib({ resolve: vi.fn(() => '/state/stickers/happy.png') }), ilink: { sendFile: vi.fn(async () => { throw new Error('boom') }) } })
    expect(await r['POST /v1/wechat/send_sticker']!(q, { chat_id: 'c@bot', tag: 'happy' })).toEqual({ status: 200, body: { ok: false, error: 'boom' } })
  })
})

describe('POST /v1/stickers', () => {
  it('400 on missing path / empty tags array', async () => {
    const stickers = lib()
    const r = routes({ stickers })
    expect((await r['POST /v1/stickers']!(q, { tags: ['happy'] })).status).toBe(400)
    expect((await r['POST /v1/stickers']!(q, { path: '/tmp/x.png', tags: [] })).status).toBe(400)
    expect((await r['POST /v1/stickers']!(q, { path: '/tmp/x.png', tags: ['happy', ''] })).status).toBe(400)
    expect(stickers.save).not.toHaveBeenCalled()
  })

  it('lib throws invalid_extension ⇒ 400 with that message', async () => {
    const r = routes({ stickers: lib({ save: vi.fn(() => { throw new Error('invalid_extension') }) }) })
    expect(await r['POST /v1/stickers']!(q, { path: '/tmp/x.txt', tags: ['happy'] })).toEqual({ status: 400, body: { error: 'invalid_extension' } })
  })

  it('happy path calls save(path, tags, desc) and returns ok+file+tags', async () => {
    const save = vi.fn(() => ({ file: 'x.png', tags: ['happy'] }))
    const r = routes({ stickers: lib({ save }) })
    const resp = await r['POST /v1/stickers']!(q, { path: '/tmp/x.png', tags: ['happy'], desc: 'a happy face' })
    expect(save).toHaveBeenCalledWith('/tmp/x.png', ['happy'], 'a happy face')
    expect(resp).toEqual({ status: 200, body: { ok: true, file: 'x.png', tags: ['happy'] } })
  })
})

describe('GET /v1/stickers', () => {
  it('happy path returns stickers list + tags', async () => {
    const r = routes({ stickers: lib({ list: vi.fn(() => [{ file: 'x.png', tags: ['happy'], desc: 'a happy face' }]), allTags: vi.fn(() => ['happy']) }) })
    expect(await r['GET /v1/stickers']!(q, undefined)).toEqual({
      status: 200,
      body: { ok: true, stickers: [{ file: 'x.png', tags: ['happy'], desc: 'a happy face' }], tags: ['happy'] },
    })
  })
})

describe('POST /v1/wechat/sticker_feedback', () => {
  it('没有反馈记账 ⇒ 503;有 ⇒ 记到那个 chat', async () => {
    expect(await routes()['POST /v1/wechat/sticker_feedback']!(q, { chat_id: 'c', signal: 'positive' })).toEqual({ status: 503, body: { error: 'sticker_feedback_not_wired' } })
    const rate = vi.fn(() => 'happy.png')
    const r = routes({ stickerFeedback: { remember: vi.fn(), rate } })
    expect(await r['POST /v1/wechat/sticker_feedback']!(q, { chat_id: ' c ', signal: 'negative' })).toEqual({ status: 200, body: { ok: true, file: 'happy.png' } })
    expect(rate).toHaveBeenCalledWith('c', 'negative', undefined)
  })
})

describe('挂在 internal-api 上(模块门)', () => {
  let api: ReturnType<typeof createInternalApi> | null = null
  let stateDir = ''
  afterEach(async () => { await api?.stop(); api = null; if (stateDir) rmSync(stateDir, { recursive: true, force: true }) })

  it('stickers 模块还没挂上 ⇒ module_starting;挂上之后照常回', async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'stickers-routes-'))
    api = createInternalApi({ stateDir, daemonPid: 1 })
    const { port, tokenFilePath } = await api.start()
    const token = readFileSync(tokenFilePath, 'utf8').trim()
    const get = () => fetch(`http://127.0.0.1:${port}/v1/stickers`, { headers: { Authorization: `Bearer ${token}` } })
    const before = await get()
    expect(before.status).toBe(503)
    expect(await before.json()).toEqual({ error: 'module_starting', module: 'stickers' })
    api.mount('stickers', routes({ stickers: lib({ allTags: vi.fn(() => ['happy']) }) }))
    const after = await get()
    expect(after.status).toBe(200)
    expect(await after.json()).toEqual({ ok: true, stickers: [], tags: ['happy'] })
  })
})
