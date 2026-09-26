import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import art from './mobile-blink-art.json'

describe('lazy blink frames', () => {
  it('embeds the committed 256px frames byte-for-byte', () => {
    for (const key of ['half', 'closed'] as const) {
      const entry = art[key]
      const source = readFileSync(new URL('../../' + entry.source, import.meta.url))
      expect(Buffer.from(entry.base64, 'base64')).toEqual(source)
      expect(createHash('sha256').update(source).digest('hex')).toBe(entry.sha256)
      expect(source.byteLength).toBeGreaterThan(20_000)   // 全彩,不是量化版
    }
  })
})
