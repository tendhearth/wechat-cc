import { describe, it, expect } from 'vitest'
import { FAIL_COOLDOWN_MS, makePortraitPng } from './portrait-png'

describe('portrait-png', () => {
  it('画成的同一张 SVG 只画一次;画不成的冷却期内不重画、过了冷却再画', async () => {
    let n = 0, t = 0
    const get = makePortraitPng({ stateDir: '/nope', now: () => t, render: async svg => { n++; return svg === 'bad' ? null : `png:${svg}` } })
    expect(await get('a')).toBe('png:a')
    expect(await get('a')).toBe('png:a')
    expect(await get('bad')).toBeNull()
    expect(await get('bad')).toBeNull()
    expect(n).toBe(2)
    t = FAIL_COOLDOWN_MS + 1
    expect(await get('bad')).toBeNull()
    expect(n).toBe(3)
  })
  it('忙的时候第一次没画成(null),冷却过后再要就画成了 —— 不会一直没有画像(#501 评审)', async () => {
    let first = true, t = 0
    const get = makePortraitPng({ stateDir: '/nope', now: () => t, render: async () => { if (first) { first = false; return null } return 'png' } })
    expect(await get('p')).toBeNull()
    t = FAIL_COOLDOWN_MS + 1
    expect(await get('p')).toBe('png')
    expect(await get('p')).toBe('png')
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
