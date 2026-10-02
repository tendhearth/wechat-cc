/**
 * presence.js 的「此刻」形象画加载(手机协议包 v2 Task 4 fix round 1,
 * 2026-09-29):两张 PNG 不再内联进页面(apps/mobile/src/presence.html 的
 * <img> 不带 src 了),改由 loadPresenceArt() 经 api() 拉
 * GET /m/api/art/presence,跟 you.js 的 youLoadFrames()(blink 帧)同一个
 * 套路 —— 经隧道也能拿到,直接 <img src="/m/api/…"> 拿不到。
 */
import { describe, it, expect, vi } from 'vitest'
import { readMobileSource } from './sources'

function el() {
  return { src: '', innerHTML: '', textContent: '', hidden: false, classList: { add: vi.fn(), remove: vi.fn(), contains: () => true }, addEventListener: vi.fn() }
}
function load(api: (p: string) => Promise<{ json: () => Promise<unknown> }>) {
  const els: Record<string, ReturnType<typeof el>> = {}
  const get = (id: string) => (els[id] ??= el())
  const query: Record<string, ReturnType<typeof el>> = {}
  const document = {
    getElementById: get,
    querySelector: (sel: string) => (query[sel] ??= el()),
    addEventListener: vi.fn(),
  }
  const env = { document, api, setTimeout: vi.fn(), esc: (s: unknown) => String(s), openEntry: vi.fn(), openYou: vi.fn(), openMatter: vi.fn() }
  const fns = new Function(...Object.keys(env), `${readMobileSource('presence.js')}\nreturn { loadPresenceArt }`)(...Object.values(env)) as
    { loadPresenceArt: () => Promise<void> }
  // presence.js 顶部就自调了一次 loadPresenceArt()(首屏立即拉),这里构造完
  // harness 就已经触发过一轮;.home-dark/.home-light 是 loadPresenceArt() 内部
  // 才 querySelector 出来的,构造时还没进 query 表 —— 用 getter 而不是这里就
  // 解构,测试要等自己那次 await 完再读。
  return { ...fns, dark: () => query['.home-dark'], light: () => query['.home-light'] }
}

describe('CC 此刻形象画(loadPresenceArt)', () => {
  it('fetches GET /m/api/art/presence and sets both frames as data URIs', async () => {
    const api = vi.fn(async (p: string) => {
      expect(p).toBe('/m/api/art/presence')
      return { json: async () => ({ ok: true, mime: 'image/png', unlit: 'AAA', lit: 'BBB' }) }
    })
    const { loadPresenceArt, dark, light } = load(api)
    await loadPresenceArt()
    expect(dark()!.src).toBe('data:image/png;base64,AAA')
    expect(light()!.src).toBe('data:image/png;base64,BBB')
  })
  it('an ok:false reply leaves both images alone', async () => {
    const { loadPresenceArt, dark, light } = load(async () => ({ json: async () => ({ ok: false, error: 'unavailable' }) }))
    await loadPresenceArt()
    expect(dark()?.src ?? '').toBe('')
    expect(light()?.src ?? '').toBe('')
  })
  it('a failing fetch does not throw and leaves both images alone — first paint must not hang on this', async () => {
    const { loadPresenceArt, dark, light } = load(async () => { throw new Error('offline') })
    await expect(loadPresenceArt()).resolves.toBeUndefined()
    expect(dark()?.src ?? '').toBe('')
    expect(light()?.src ?? '').toBe('')
  })
})
