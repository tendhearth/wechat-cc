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
  return { src: '', innerHTML: '', textContent: '', hidden: false, classList: { add: vi.fn(), remove: vi.fn(), contains: () => true }, addEventListener: vi.fn(), replaceChildren: vi.fn(), appendChild: vi.fn() }
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
  const fns = new Function(...Object.keys(env), `var CCM = { markdownPlainText: function(s){ return String(s) } }\n${readMobileSource('presence.js')}\nreturn { loadPresenceArt, renderPresenceHome }`)(...Object.values(env)) as
    { loadPresenceArt: () => Promise<void>; renderPresenceHome: (s: unknown, stale: boolean) => void }
  // presence.js 顶部就自调了一次 loadPresenceArt()(首屏立即拉),这里构造完
  // harness 就已经触发过一轮;.home-dark/.home-light 是 loadPresenceArt() 内部
  // 才 querySelector 出来的,构造时还没进 query 表 —— 用 getter 而不是这里就
  // 解构,测试要等自己那次 await 完再读。
  return { ...fns, env, dark: () => query['.home-dark'], light: () => query['.home-light'], scene: () => query['.home-scene'] }
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

// 规矩 9(设计原则 10-01):CC 亮 = 真的在身边。以前网页 800ms 后不看连接就点亮(手机端盘点 10-20)。
describe('CC 亮 / 暗跟着真实连接', () => {
  const api = async () => ({ json: async () => ({ ok: false }) })
  it('never lights on a timer', () => {
    const h = load(api as never)
    expect(h.env.setTimeout).not.toHaveBeenCalled()
  })
  it('lights only on a fresh, ok presence; dims on stale or not-ok', () => {
    const h = load(api as never)
    h.renderPresenceHome({ presence: { presence: 'ok' }, work: { focus: null } }, false)
    expect(h.scene().classList.add).toHaveBeenCalledWith('home-arrived')
    h.renderPresenceHome({ presence: { presence: 'offline' }, work: { focus: null } }, false)
    expect(h.scene().classList.remove).toHaveBeenCalledWith('home-arrived')
    ;(h.scene().classList.add as ReturnType<typeof vi.fn>).mockClear()
    h.renderPresenceHome({ presence: { presence: 'ok' }, work: { focus: null } }, true)
    expect(h.scene().classList.add).not.toHaveBeenCalled()
  })
})
