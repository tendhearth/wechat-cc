import { describe, expect, it, vi } from 'vitest'
import { BackendError, type UploadChunkInput, type UploadStateT } from '../backend/types'
import { base64ToBytes, bytesToBase64, checkImage, IMAGE_MAX_BYTES, UPLOAD_CHUNK_BYTES, uploadImages, type PickedImage } from './image-upload'

const D = '11111111-1111-4111-8111-111111111111'
const img = (size: number, id = '22222222-2222-4222-8222-222222222222'): PickedImage => ({ id, name: 'shot.png', mime: 'image/png', size, sha256: 'a'.repeat(64), bytes: new Uint8Array(size).map((_, i) => i % 251), uri: 'file:///x.png' })

/** 一台假电脑:按 offset 收块,记住每份传到哪了。failAt = 第几次 chunk 调用抛错(模拟断线)。 */
function computer(failAt: number[] = []) {
  const got = new Map<string, { size: number; next: number; bytes: number[] }>()
  let n = 0
  const chunks: UploadChunkInput[] = []
  return {
    chunks, got,
    uploadChunk: vi.fn(async (p: UploadChunkInput): Promise<UploadStateT> => {
      n++
      if (failAt.includes(n)) throw new BackendError('timeout')
      const cur = got.get(p.id) ?? { size: p.size, next: 0, bytes: [] }
      if (p.offset !== cur.next) throw new BackendError('invalid')
      const b = base64ToBytes(p.contentBase64); for (const x of b) cur.bytes.push(x); cur.next += b.length
      got.set(p.id, cur); chunks.push(p)
      return { id: p.id, draftId: p.draftId, size: p.size, nextOffset: cur.next, status: cur.next >= p.size ? 'ready' : 'uploading' }
    }),
    uploadStatus: vi.fn(async (id: string, draftId: string): Promise<UploadStateT> => {
      const cur = got.get(id)
      if (!cur) throw new BackendError('not_found')
      return { id, draftId, size: cur.size, nextOffset: cur.next, status: cur.next >= cur.size ? 'ready' : 'uploading' }
    }),
  }
}

describe('uploadImages', () => {
  it('splits into 128 KiB chunks and the computer ends up with the exact bytes', async () => {
    const c = computer(), a = img(UPLOAD_CHUNK_BYTES * 2 + 17)
    expect(await uploadImages(c, D, [a], bytesToBase64)).toEqual([a.id])
    expect(c.chunks.map(x => x.offset)).toEqual([0, UPLOAD_CHUNK_BYTES, UPLOAD_CHUNK_BYTES * 2])
    expect(Uint8Array.from(c.got.get(a.id)!.bytes)).toEqual(a.bytes)
  })
  it('a dropped chunk asks for progress and resumes from where the computer is', async () => {
    const c = computer([2]), a = img(UPLOAD_CHUNK_BYTES * 3)
    await uploadImages(c, D, [a], bytesToBase64)
    expect(c.uploadStatus).toHaveBeenCalledTimes(2)
    expect(Uint8Array.from(c.got.get(a.id)!.bytes)).toEqual(a.bytes)
  })
  it('an already-finished upload (a retry of the same sentence) sends nothing more', async () => {
    const c = computer(), a = img(1000)
    await uploadImages(c, D, [a], bytesToBase64)
    await uploadImages(c, D, [a], bytesToBase64)
    expect(c.uploadChunk).toHaveBeenCalledTimes(1)
  })
  it('gives up after the retry budget and surfaces the error', async () => {
    const c = computer([1, 2, 3]), a = img(1000)
    await expect(uploadImages(c, D, [a], bytesToBase64)).rejects.toMatchObject({ code: 'timeout' })
  })
})

describe('checkImage / base64', () => {
  it('only the formats and sizes the computer accepts', () => {
    expect(checkImage({ mime: 'image/png', size: 10 })).toBe('ok')
    expect(checkImage({ mime: 'image/heic', size: 10 })).toBe('unsupported')
    expect(checkImage({ mime: 'image/jpeg', size: IMAGE_MAX_BYTES + 1 })).toBe('too_large')
  })
  it('round-trips bytes', () => {
    const b = new Uint8Array(70_000).map((_, i) => i % 256)
    expect(base64ToBytes(bytesToBase64(b))).toEqual(b)
  })
})

describe('withImageMarker', () => {
  it('matches what the computer records for the sentence', async () => {
    const { withImageMarker } = await import('./image-upload')
    expect(withImageMarker('', 2)).toBe('[图片 ×2]')
    expect(withImageMarker(' 看这个报错 ', 1)).toBe('看这个报错\n[图片 ×1]')
  })
})
