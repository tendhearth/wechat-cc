import { describe, expect, it } from 'vitest'
import { letterDate, letterPages, letterRows } from './letters'
import { inlineImageMime, isInlineImage } from './chat'
import { makeDemoBackend } from '../backend/demo'
import type { LetterSummaryT } from '../backend/types'

const letter = (id: string, sentAt: number, over: Partial<LetterSummaryT> = {}): LetterSummaryT => ({ id, day: '2026-10-16', sentAt, requested: false, via: 'wechat', opening: `开头 ${id}`, pages: 2, ...over })

describe('CC 的信 视图', () => {
  it('日期:中文写成「年月日」,英文写成月份名;认不出就原样', () => {
    expect(letterDate('2026-10-16', 'zh-Hans')).toBe('2026 年 10 月 16 日')
    expect(letterDate('2026-01-05', 'en')).toBe('January 5, 2026')
    expect(letterDate('2026-13-01', 'en')).toBe('2026-13-01')
    expect(letterDate('昨天', 'zh-Hans')).toBe('昨天')
  })
  it('列表:日期 + 开头那句,新的在前', () => {
    expect(letterRows([letter('a', 1), letter('b', 2, { day: '2026-10-17' })], 'zh-Hans')).toEqual([
      { id: 'b', date: '2026 年 10 月 17 日', opening: '开头 b' },
      { id: 'a', date: '2026 年 10 月 16 日', opening: '开头 a' },
    ])
  })
  it('页:1..pages;0 页 ⇒ 空(显示全文);坏数夹住', () => {
    expect(letterPages({ pages: 2 })).toEqual([1, 2])
    expect(letterPages({ pages: 0 })).toEqual([])
    expect(letterPages({ pages: 99 })).toHaveLength(12)
    expect(letterPages({ pages: -1 })).toEqual([])
  })
  it('演示:两封按文字寄的信,中英文各一份;取页 ⇒ not_found', async () => {
    const b = makeDemoBackend({ lang: 'zh-Hans' })
    const zh = await b.letters()
    expect(zh).toHaveLength(2)
    expect(zh.every(l => l.pages === 0 && !!l.text && l.text.endsWith('— CC'))).toBe(true)
    expect(zh[0]!.opening).toMatch(/[一-鿿]/)
    await expect(b.letterPageChunk({ id: zh[0]!.id, page: 1, offset: 0 })).rejects.toMatchObject({ code: 'not_found' })
    const en = await makeDemoBackend({ lang: 'en' }).letters()
    expect(en[0]!.opening).not.toMatch(/[一-鿿]/)
  })
})

describe('对话里直接画成图的文件', () => {
  it('png / jpg / gif / webp 画成图;别的仍是文件', () => {
    expect(['page-1.png', 'a.JPG', 'b.jpeg', 'c.gif', 'd.webp'].every(isInlineImage)).toBe(true)
    expect(['r.pdf', 'a.png.txt', 'heic.heic', 'png'].some(isInlineImage)).toBe(false)
    expect(inlineImageMime('a.JPG')).toBe('image/jpeg')
    expect(inlineImageMime('page-1.png')).toBe('image/png')
  })
})
