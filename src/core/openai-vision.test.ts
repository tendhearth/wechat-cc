import { describe, it, expect } from 'vitest'
import { extractImagePaths, imageMediaType, loadImageParts, MAX_IMAGES_PER_TURN, MAX_IMAGE_BYTES } from './openai-vision'

describe('openai-vision', () => {
  it('从提示词里挖 [image:path],去重,忽略别的附件行', () => {
    const text = '看看这个\n[image:/inbox/a/1.jpg] 海报\n[file:/inbox/a/doc.pdf]\n[image:/inbox/a/1.jpg]\n[image:/inbox/a/2.png]'
    expect(extractImagePaths(text)).toEqual(['/inbox/a/1.jpg', '/inbox/a/2.png'])
    expect(extractImagePaths('没有图')).toEqual([])
  })
  it('后缀 → mime;不认识的 → null', () => {
    expect(imageMediaType('/x/a.JPG')).toBe('image/jpeg')
    expect(imageMediaType('/x/a.webp')).toBe('image/webp')
    expect(imageMediaType('/x/a.bmp')).toBeNull()
  })
  it('loadImageParts:读得到的带上;缺文件 / 超限 / 不认识的后缀 / 读抛错 跳过;最多 4 张', () => {
    const files: Record<string, number> = { '/a.jpg': 10, '/big.png': MAX_IMAGE_BYTES + 1, '/c.gif': 5, '/d.webp': 5, '/e.png': 5, '/f.png': 5, '/boom.png': 5 }
    const parts = loadImageParts(['/a.jpg', '/missing.jpg', '/big.png', '/x.bmp', '/boom.png', '/c.gif', '/d.webp', '/e.png', '/f.png'], {
      exists: (p) => p in files,
      size: (p) => files[p]!,
      read: (p) => { if (p === '/boom.png') throw new Error('EACCES'); return new Uint8Array([1, 2, 3]) },
    })
    expect(parts.map(p => p.mediaType)).toEqual(['image/jpeg', 'image/gif', 'image/webp', 'image/png'])
    expect(parts).toHaveLength(MAX_IMAGES_PER_TURN)
    expect(parts[0]!.data).toEqual(new Uint8Array([1, 2, 3]))
  })
})
