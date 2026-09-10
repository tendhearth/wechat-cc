import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { imageDimensions, prepareImage, resizeCommand, imageMediaType, IMAGE_MAX_SIDE } from './image-prep'
import { deflateSync } from 'node:zlib'

function pngHeader(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); const dv = new DataView(b.buffer)
  dv.setUint32(8, 13); b.set([0x49, 0x48, 0x44, 0x52], 12); dv.setUint32(16, w); dv.setUint32(20, h); return b
}
function jpegHeader(w: number, h: number): Uint8Array {
  // SOI, APP0(len 16), SOF0(len 17: precision, h, w, ...)
  const b = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0), 0xff, 0xc0, 0x00, 0x11, 0x08, (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  return b
}

describe('imageDimensions', () => {
  it('PNG / JPEG / GIF / WebP 头部尺寸;认不出 null', () => {
    expect(imageDimensions(pngHeader(3000, 2200))).toEqual({ w: 3000, h: 2200 })
    expect(imageDimensions(jpegHeader(1024, 768))).toEqual({ w: 1024, h: 768 })
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xf0, 0x00, 0, 0])
    expect(imageDimensions(gif)).toEqual({ w: 320, h: 240 })
    const webp = new Uint8Array(30); webp.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58]); webp[24] = 0xff; webp[25] = 0x03; webp[27] = 0xff; webp[28] = 0x01
    expect(imageDimensions(webp)).toEqual({ w: 1024, h: 512 })
    expect(imageDimensions(new Uint8Array([1, 2, 3]))).toBeNull()
  })
})

describe('prepareImage', () => {
  it('小图原样;超宽走平台缩图命令,结果是 JPEG 并带 resized;缩失败但不超字节 → 原样', async () => {
    const d = mkdtempSync(join(tmpdir(), 'imgprep-'))
    try {
      const small = join(d, 'small.png'); writeFileSync(small, pngHeader(100, 80))
      const r1 = await prepareImage(small, { exec: vi.fn() })
      expect(r1).toMatchObject({ ok: true, mediaType: 'image/png', dims: { w: 100, h: 80 } })
      const wide = join(d, 'wide.png'); writeFileSync(wide, pngHeader(4000, 3000))
      const exec = vi.fn(async (_cmd: string, args: string[]) => { writeFileSync(args[args.length - 1]!.endsWith('.jpg') ? args[args.length - 1]! : args[args.indexOf('--out') + 1]!, jpegHeader(2048, 1536)) })
      const r2 = await prepareImage(wide, { exec, platform: 'darwin', tmpDir: d })
      expect(r2).toMatchObject({ ok: true, mediaType: 'image/jpeg', resized: { from: { w: 4000, h: 3000 }, to: { w: 2048, h: 1536 } } })
      expect(exec.mock.calls[0]![0]).toBe('sips')
      const r3 = await prepareImage(wide, { exec: async () => { throw new Error('no sips') }, platform: 'darwin', tmpDir: d })
      expect(r3).toMatchObject({ ok: true, mediaType: 'image/png', dims: { w: 4000, h: 3000 } })
      const huge = join(d, 'huge.png'); writeFileSync(huge, pngHeader(500, 500))
      const r4 = await prepareImage(huge, { exec: async () => { throw new Error('x') }, platform: 'darwin', tmpDir: d, maxBytes: 10 })
      expect(r4).toMatchObject({ ok: false })
      expect((r4 as { reason: string }).reason).toContain('缩不了')
      expect(await prepareImage(join(d, 'nope.png'))).toMatchObject({ ok: false })
      expect(await prepareImage(join(d, 'a.bmp'))).toEqual({ ok: false, reason: '不认识的图片格式' })
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
  it('resizeCommand 三平台各一条;别的 null;mime 按后缀', () => {
    expect(resizeCommand('darwin', '/in.png', '/out.jpg', IMAGE_MAX_SIDE)!.cmd).toBe('sips')
    expect(resizeCommand('linux', '/in.png', '/out.jpg', 2048)!.args).toContain('2048x2048>')
    expect(resizeCommand('win32', "/in's.png", '/out.jpg', 2048)!.args[3]).toContain("in''s.png")
    expect(resizeCommand('freebsd', '/a', '/b', 2048)).toBeNull()
    expect(imageMediaType('/x/A.JPEG')).toBe('image/jpeg')
  })
})

describe('真起进程缩图(defaultExec;只在 macOS 跑,sips 是系统自带)', () => {
  it.skipIf(process.platform !== 'darwin')('3000x200 的 PNG 经 sips 缩成最长边 2048 的 JPEG', async () => {
    const d = mkdtempSync(join(tmpdir(), 'imgprep-real-'))
    try {
      const w = 3000, h = 200
      const raw = Buffer.alloc((w * 3 + 1) * h)
      for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 30; raw[o + 1] = 120; raw[o + 2] = 220 } }
      const chunk = (type: string, data: Buffer) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
        const td = Buffer.concat([Buffer.from(type), data])
        const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
        let crc = 0xffffffff; for (const b of td) crc = crcTable[(crc ^ b) & 0xff]! ^ (crc >>> 8)
        const cb = Buffer.alloc(4); cb.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
        return Buffer.concat([len, td, cb])
      }
      const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
      const p = join(d, 'wide.png'); writeFileSync(p, png)
      const r = await prepareImage(p, { tmpDir: d })
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.mediaType).toBe('image/jpeg')
        expect(r.resized?.from).toEqual({ w: 3000, h: 200 })
        expect(r.resized?.to.w).toBe(2048)
        expect(r.resized?.to.h).toBeGreaterThanOrEqual(130)
        expect(r.resized?.to.h).toBeLessThanOrEqual(140)
      }
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
})
