import { describe, it, expect } from 'vitest'
import { extractImagePaths, prepareImageParts, appendImageNotes, MAX_IMAGES_PER_TURN } from './openai-vision'
import type { PreparedImage } from '../lib/image-prep'

describe('openai-vision', () => {
  it('从提示词里挖 [image:path],去重,忽略别的附件行', () => {
    const text = '看看这个\n[image:/inbox/a/1.jpg] 海报\n[file:/inbox/a/doc.pdf]\n[image:/inbox/a/1.jpg]\n[image:/inbox/a/2.png]'
    expect(extractImagePaths(text)).toEqual(['/inbox/a/1.jpg', '/inbox/a/2.png'])
    expect(extractImagePaths('没有图')).toEqual([])
  })
  it('prepareImageParts:带上的 / 缩过的 / 没带上的 / 超张数的各留一句', async () => {
    const fake = async (p: string): Promise<PreparedImage> => {
      if (p.endsWith('big.png')) return { ok: true, data: new Uint8Array([1]), mediaType: 'image/jpeg', dims: { w: 2048, h: 1536 }, resized: { from: { w: 4000, h: 3000 }, to: { w: 2048, h: 1536 } } }
      if (p.endsWith('bad.png')) return { ok: false, reason: '读不到文件' }
      return { ok: true, data: new Uint8Array([2]), mediaType: 'image/png', dims: { w: 10, h: 10 } }
    }
    const { parts, notes } = await prepareImageParts(['/a.png', '/big.png', '/bad.png', '/c.png', '/d.png', '/e.png'], {}, fake)
    expect(parts.map(p => p.mediaType)).toEqual(['image/png', 'image/jpeg', 'image/png', 'image/png'])
    expect(parts).toHaveLength(MAX_IMAGES_PER_TURN)
    expect(notes).toEqual([
      '第 2 张图(big.png)从 4000x3000 缩到 2048x1536',
      '第 3 张图(bad.png)未附上:读不到文件',
      '第 6 张图(e.png)未附上:一条消息最多带 4 张',
    ])
    expect(appendImageNotes('hi', [])).toBe('hi')
    expect(appendImageNotes('hi', ['x'])).toBe('hi\n<image_notes>\nx\n</image_notes>')
  })
})
