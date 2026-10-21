/**
 * presence.js 的「此刻」形象画加载(手机协议包 v2 Task 4 fix round 1,
 * 2026-09-29):两张 PNG 不再内联进页面(apps/mobile/src/presence.html 的
 * <img> 不带 src 了),改由 loadPresenceArt() 经 api() 拉
 * GET /m/api/art/presence —— 经隧道也能拿到,直接 <img src="/m/api/…"> 拿不到。
 * 外加「等你的那一件」那张卡(收敛 5b,2026-10-21):只看,不带动作按钮。
 */
import { afterEach, describe, it, expect, vi } from 'vitest'
import { Window } from 'happy-dom'
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
  const env = { document, api, setTimeout: vi.fn(), esc: (s: unknown) => String(s), ccPlain: (s: unknown) => String(s), ccShowMatter: vi.fn() }
  const fns = new Function(...Object.keys(env), `${readMobileSource('presence.js')}\nreturn { loadPresenceArt, renderPresenceHome }`)(...Object.values(env)) as
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
    expect(h.scene()!.classList.add).toHaveBeenCalledWith('home-arrived')
    h.renderPresenceHome({ presence: { presence: 'offline' }, work: { focus: null } }, false)
    expect(h.scene()!.classList.remove).toHaveBeenCalledWith('home-arrived')
    ;(h.scene()!.classList.add as ReturnType<typeof vi.fn>).mockClear()
    h.renderPresenceHome({ presence: { presence: 'ok' }, work: { focus: null } }, true)
    expect(h.scene()!.classList.add).not.toHaveBeenCalled()
  })
})

// 收敛 5b 第 3 条:「有件事等你决定 / 带回了成果」那张卡留成只看 —— 写清哪件事、什么状态,不带任何动作按钮;
// 点卡片本身只是去看这件事的状态(不发任何请求)。
describe('此刻页「等你」那张卡只看', () => {
  const windows: Window[] = []
  afterEach(async () => { await Promise.all(windows.splice(0).map(w => w.happyDOM.abort())) })
  function real() {
    const window = new Window({ url: 'https://fixture.test/m' }); windows.push(window)
    const document = window.document
    document.body.innerHTML = readMobileSource('presence.html')
    const api = vi.fn(async () => ({ json: async () => ({ ok: false }) }))
    const ccShowMatter = vi.fn()
    const env = { document, api, esc: (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'), ccPlain: (s: unknown) => String(s).replace(/\*\*/g, ''), ccShowMatter }
    const fns = new Function(...Object.keys(env), `${readMobileSource('presence.js')}\nreturn { renderPresenceHome }`)(...Object.values(env)) as { renderPresenceHome: (s: unknown, stale: boolean) => void }
    return { ...fns, document, api, ccShowMatter }
  }
  it.each([['decision', '有件事等你决定', '到手机 App 或电脑上拍板'], ['result', '带回了成果', '成果在手机 App 或电脑上看']] as const)('%s:哪件事 + 状态,没有动作按钮', async (kind, label, where) => {
    const h = real()
    h.renderPresenceHome({ presence: { presence: 'ok' }, work: { focus: { id: 'deadbeef', title: '**发布**说明', kind }, partial: false } }, false)
    const slot = h.document.getElementById('home-focus')!
    const card = slot.querySelector('.home-action')!
    expect(card.querySelector('small')!.textContent).toBe(label)
    expect(card.querySelector('strong')!.textContent).toBe('发布说明')
    expect(card.querySelector('span')!.textContent).toBe(where)
    expect(card.querySelectorAll('button, [data-control], [data-handoff]')).toHaveLength(0)
    for (const cta of ['打开并决定', '查看成果', '允许', '先不做', '↗']) expect(slot.textContent).not.toContain(cta)
    h.api.mockClear()
    ;(card as unknown as HTMLElement).click()
    expect(h.ccShowMatter).toHaveBeenCalledWith('deadbeef')
    expect(h.api).not.toHaveBeenCalled()
  })
  it('正在做的事不上此刻页;旧画面上的卡点不动', () => {
    const h = real()
    h.renderPresenceHome({ presence: { presence: 'ok' }, work: { focus: { id: 'deadbeef', title: 'x', kind: 'working' }, partial: false } }, false)
    expect(h.document.getElementById('home-focus')!.children).toHaveLength(0)
    h.renderPresenceHome({ presence: { presence: 'ok' }, work: { focus: { id: 'deadbeef', title: 'x', kind: 'decision' }, partial: false } }, true)
    const card = h.document.querySelector('.home-action') as unknown as HTMLButtonElement
    expect(card.disabled).toBe(true)
  })
})

// 收敛 5b 删了整套 Markdown 渲染;列表与卡片标题只靠 boot.js 的 ccPlain 去掉排版记号。
describe('ccPlain(标题去排版记号)', () => {
  const src = readMobileSource('boot.js')
  const ccPlain = new Function(`${src.slice(src.indexOf('function ccPlain'))}\nreturn ccPlain`)() as (s: unknown) => string
  it.each([
    ['**发布**说明', '发布说明'], ['# 标题', '标题'], ['看 [文档](https://x.test/a) 再说', '看 文档 再说'], ['跑 `bun test`', '跑 bun test'],
    ['- 一项', '一项'], ['改 snake_case_name 与 a*b', '改 snake_case_name 与 a*b'], ['_斜体_ 和 ~~删~~', '斜体 和 删'], ['两行\n第二行', '两行 第二行'], [null, ''],
  ])('%j → %j', (input, want) => { expect(ccPlain(input)).toBe(want) })
})
