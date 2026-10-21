import { describe, it, expect } from 'vitest'
import { makePortraitPng } from './portrait-png'

describe('portrait-png', () => {
  it('同一张 SVG 只画一次(成败都记);不同的 SVG 各画各的', async () => {
    let n = 0
    const get = makePortraitPng({ stateDir: '/nope', render: async svg => { n++; return svg === 'bad' ? null : `png:${svg}` } })
    expect(await get('a')).toBe('png:a')
    expect(await get('a')).toBe('png:a')
    expect(await get('bad')).toBeNull()
    expect(await get('bad')).toBeNull()
    expect(n).toBe(2)
  })
  it('同时来的请求只起一次;渲染抛错 ⇒ null', async () => {
    let n = 0
    const get = makePortraitPng({ stateDir: '/nope', render: async () => { n++; await new Promise(r => setTimeout(r, 20)); return 'p' } })
    expect(await Promise.all([get('x'), get('x'), get('x')])).toEqual(['p', 'p', 'p'])
    expect(n).toBe(1)
    const boom = makePortraitPng({ stateDir: '/nope', render: async () => { throw new Error('x') } })
    expect(await boom('y')).toBeNull()
  })
  it('画得慢:这一次不等(null),画完进缓存,下一次就有', async () => {
    let done!: (v: string) => void
    const get = makePortraitPng({ stateDir: '/nope', waitMs: 20, render: () => new Promise<string>(r => { done = r }) })
    expect(await get('slow')).toBeNull()
    done('late-png')
    await new Promise(r => setTimeout(r, 0))
    expect(await get('slow')).toBe('late-png')
  })
})
