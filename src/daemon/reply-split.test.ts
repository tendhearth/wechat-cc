import { describe, it, expect } from 'vitest'
import { splitReply, paceMs } from './reply-split'

describe('splitReply', () => {
  it('returns short text unsplit', () => {
    expect(splitReply('好的,收到!')).toEqual(['好的,收到!'])
  })

  it('splits on paragraph breaks into at most 3 chunks', () => {
    const p = '第一段的内容,这里说明第一件事情,补充一点细节让它足够长一些。'
    const text = `${p}\n\n${p}\n\n${p}\n\n${p}`
    const chunks = splitReply(text)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks.length).toBeLessThanOrEqual(3)
    // verbatim-content property: rejoining loses only boundary whitespace
    expect(chunks.join('').replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''))
  })

  it('splits a long single paragraph at sentence terminators, never at a bare dot', () => {
    const text = '这是第一句话,讲了很多细节!然后是第二句,参考 https://example.com/a.b.c 这个链接。最后一句做个总结,希望对你有帮助。'
    const chunks = splitReply(text, { minLen: 30 })
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    // the URL survives intact in exactly one chunk
    const holding = chunks.filter(c => c.includes('https://example.com/a.b.c'))
    expect(holding).toHaveLength(1)
  })

  it('keeps fenced code blocks atomic', () => {
    const code = '```ts\nconst x = 1\nconst y = 2\n```'
    const text = `看这段代码,它演示了变量定义的写法,注意常量的用法。\n\n${code}\n\n以上就是全部内容了,有问题随时问我。`
    const chunks = splitReply(text, { minLen: 30 })
    const holding = chunks.filter(c => c.includes('const x = 1'))
    expect(holding).toHaveLength(1)
    expect(holding[0]).toContain('```ts')
    expect(holding[0]).toContain('\n```')
  })

  it('merges tiny trailing chunks instead of sending a 3-char bubble', () => {
    const text = `这一段足够长,包含了很多内容和细节,目的是让拆分逻辑生效并产生多个块。\n\n好。`
    const chunks = splitReply(text, { minLen: 30 })
    // '好。' (<10 chars) must not be its own chunk
    for (const c of chunks) expect(c.trim().length).toBeGreaterThanOrEqual(10)
  })

  it('maxChunks=1 or single unit returns the original', () => {
    const long = 'x'.repeat(300)
    expect(splitReply(long, { maxChunks: 1 })).toEqual([long])
    expect(splitReply(long)).toEqual([long]) // no boundaries at all → unsplit
  })
})

describe('paceMs', () => {
  it('clamps to [600, 2000]', () => {
    expect(paceMs('短')).toBe(600)
    expect(paceMs('x'.repeat(40))).toBe(1200)
    expect(paceMs('x'.repeat(500))).toBe(2000)
  })
})
