import { describe, it, expect, vi } from 'vitest'
import { makeRoutes } from './routes'
import { CONVERSE_IMAGE_LIMITS } from '../app-reply'

// 此刻里拖进 / 粘进来的截图(2026-10-05):路由把 [{ mime, data_b64 }] 校验、解码后交给 companionConverse。
function setup() {
  const companionConverse = vi.fn(async () => ({ reply: '看到了' }))
  const routes = makeRoutes({ deps: { companionConverse } as never, getDelegate: () => null, maybePrefix: (_c, t) => t })
  const post = (body: unknown) => routes['POST /v1/companion/converse']!(new URLSearchParams(), body)
  return { post, companionConverse }
}
const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64')

describe('POST /v1/companion/converse with images', () => {
  it('decodes images and passes them through; an image alone needs no text', async () => {
    const { post, companionConverse } = setup()
    const res = await post({ text: '', images: [{ mime: 'image/png', data_b64: b64([1, 2, 3]) }] })
    expect(res.status).toBe(200)
    expect(companionConverse).toHaveBeenCalledWith('', 'desktop', [{ mime: 'image/png', bytes: Buffer.from([1, 2, 3]) }])
  })

  it('text-only turns are unchanged (no images argument)', async () => {
    const { post, companionConverse } = setup()
    await post({ text: '在吗' })
    expect(companionConverse).toHaveBeenCalledWith('在吗', 'desktop', undefined)
  })

  it('still needs text or an image', async () => {
    const { post, companionConverse } = setup()
    expect((await post({ text: '  ' })).status).toBe(400)
    expect((await post({ text: '', images: [] })).status).toBe(400)
    expect(companionConverse).not.toHaveBeenCalled()
  })

  it('rejects too many, unsupported, empty or oversized images before any turn starts', async () => {
    const { post, companionConverse } = setup()
    const one = { mime: 'image/png', data_b64: b64([1]) }
    expect((await post({ text: 'x', images: Array(CONVERSE_IMAGE_LIMITS.count + 1).fill(one) })).body).toEqual({ error: 'too_many_images' })
    expect((await post({ text: 'x', images: [{ mime: 'image/svg+xml', data_b64: b64([1]) }] })).body).toEqual({ error: 'invalid_image' })
    expect((await post({ text: 'x', images: [{ mime: 'image/png', data_b64: '' }] })).body).toEqual({ error: 'invalid_image' })
    const big = Buffer.alloc(CONVERSE_IMAGE_LIMITS.bytes + 1).toString('base64')
    expect(await post({ text: 'x', images: [{ mime: 'image/png', data_b64: big }] })).toEqual({ status: 413, body: { error: 'image_too_large' } })
    expect(companionConverse).not.toHaveBeenCalled()
  })

  it('accepts documents with their names; refuses unknown types and overlong names (2026-10-06)', async () => {
    const { post, companionConverse } = setup()
    expect((await post({ text: '看看', images: [{ mime: 'application/pdf', data_b64: b64([37, 80, 68, 70]), name: 'q3.pdf' }] })).status).toBe(200)
    expect(companionConverse).toHaveBeenCalledWith('看看', 'desktop', [{ mime: 'application/pdf', bytes: Buffer.from([37, 80, 68, 70]), name: 'q3.pdf' }])
    expect((await post({ text: 'x', images: [{ mime: 'application/zip', data_b64: b64([1]) }] })).status).toBe(400)
    expect((await post({ text: 'x', images: [{ mime: 'text/plain', data_b64: b64([1]), name: 'n'.repeat(256) }] })).status).toBe(400)
  })
})
