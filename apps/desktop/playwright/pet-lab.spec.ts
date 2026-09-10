// pet-lab.spec.ts — CC 桌宠在**真浏览器**里的兜底用例。
//
// 为什么要有这个文件:pet/ 下的单元测试全部用假 DOM 对象,`style['--x'] = v` 这种在
// 真实 CSSStyleDeclaration 上静默失效的写法,假对象照样存进去、测试照样绿。2026-09-09
// 就是这样让所有道具在真机上掉到脚底正中,直到 owner 肉眼看见。
// 这里只断言**稳定的不变量**(自定义属性到达 DOM、anchor 落在 contain 正方形的脚底、
// 道具不在脚底、每个行为都解析到真 PNG、坏帧回退),不断言像素与坐标常量。
//
// 页面:pet-lab.html?reduced(reduced motion 关掉随机眨眼/张望,帧序列可预测)。
// 服务:fixtures 里的 DRY_RUN test-shim 静态托管 apps/desktop/src/*。

import { test, expect, type Page } from '@playwright/test'
import { test as shimTest } from './fixtures'

type Snapshot = { form: 'lit' | 'unlit'; behavior: string; transition: string | null; props: string[] }

interface Manifest {
  forms: Record<'lit' | 'unlit', { states: Record<string, { frames: string[] }> }>
  transitions: Record<string, { frames: string[] }>
}

const BEHAVIORS = ['idle', 'blink', 'look', 'receive', 'working', 'thinking', 'permission', 'done', 'companion', 'sleep', 'drag', 'wake', 'error'] as const

// reduced motion 下一次性多帧动画只显示首末两帧(渲染器有意为之),要看完整帧序列的用例关掉它。
async function openLab(page: Page, shimUrl: string, opts: { reduced?: boolean } = {}) {
  await page.goto(new URL(opts.reduced === false ? 'pet-lab.html' : 'pet-lab.html?reduced', shimUrl).href)
  await page.waitForFunction(() => Boolean((window as any).__pet), { timeout: 15_000 })
  // 每次换 src 都记下来:一次性行为 250ms 就回落,事后查记录比抓瞬间可靠。
  await page.evaluate(() => {
    const img = document.getElementById('pet-sprite') as HTMLImageElement
    const seen: string[] = ((window as any).__seenSrc = [])
    new MutationObserver(() => seen.push(img.getAttribute('src') ?? '')).observe(img, { attributes: true, attributeFilter: ['src'] })
    seen.push(img.getAttribute('src') ?? '')
  })
}

const basename = (p: string) => p.split('/').pop() ?? p
const snapshot = (page: Page) => page.evaluate((): Snapshot => (window as any).__pet.machine.snapshot())
const settleForm = (page: Page, form: 'lit' | 'unlit') => page.waitForFunction((f) => { const s = (window as any).__pet.machine.snapshot(); return s.form === f && s.transition === null }, form, { timeout: 5_000 })
const warnings = (page: Page) => page.evaluate((): string[] => (window as any).__pet.warnings)
// 记录 + 当前 src:状态没换帧(比如 idle → companion 同一张图)时 MutationObserver 不会触发。
const seenSrc = (page: Page) => page.evaluate((): string[] => [...(window as any).__seenSrc, (document.getElementById('pet-sprite') as HTMLImageElement).getAttribute('src') ?? ''])
const resetSeen = (page: Page) => page.evaluate(() => { (window as any).__seenSrc.length = 0 })

// 已知且有意的告警:Light→Dark 还没有正式转场,走淡入淡出。其它任何告警都算回归。
const isKnown = (w: string) => w.startsWith('fallback:transition/lit-to-unlit')

// 舞台里 object-fit: contain 画出来的那块正方形(边长 = min(宽, 高),居中)。
async function containedSquare(page: Page) {
  return page.evaluate(() => {
    const r = document.getElementById('pet-stage')!.getBoundingClientRect()
    const side = Math.min(r.width, r.height)
    return { left: r.left + (r.width - side) / 2, top: r.top + (r.height - side) / 2, side }
  })
}

shimTest.describe('CC 桌宠(真浏览器)', () => {
  shimTest('自定义属性到达 DOM;变换原点落在 contain 正方形的真实脚底', async ({ page, shimUrl }) => {
    await openLab(page, shimUrl)
    const anchor = await page.evaluate(() => {
      const stage = document.getElementById('pet-stage')!
      return { x: stage.style.getPropertyValue('--pet-anchor-x'), y: stage.style.getPropertyValue('--pet-anchor-y') }
    })
    // manifest 的 anchor [0.5, 470/512],写成无单位比例。空串 = style['--x'] 那个 no-op 又回来了。
    expect(anchor).toEqual({ x: '0.5', y: '0.91796875' })

    const sq = await containedSquare(page)
    const origin = await page.evaluate(() => {
      const img = document.getElementById('pet-sprite')!
      const [ox, oy] = getComputedStyle(img).transformOrigin.split(' ').map(parseFloat)
      const r = img.getBoundingClientRect()
      return { x: r.left + ox, y: r.top + oy }
    })
    expect(Math.abs(origin.x - (sq.left + 0.5 * sq.side))).toBeLessThan(1.5)
    expect(Math.abs(origin.y - (sq.top + 0.91796875 * sq.side))).toBeLessThan(1.5)
  })

  shimTest('道具落在各自槽位,没有一个在脚底', async ({ page, shimUrl }) => {
    await openLab(page, shimUrl)
    await page.evaluate(() => { const pet = (window as any).__pet; pet.setForm('lit'); pet.setState('permission'); pet.setProps(['exclamation', 'laptop', 'envelope']) })
    await expect(page.locator('.pet-prop')).toHaveCount(3)
    const sq = await containedSquare(page)
    const props = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.pet-prop')].map((el) => {
      const r = el.getBoundingClientRect()
      return { name: el.dataset.prop!, cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width }
    }))
    const rel = Object.fromEntries(props.map((p) => [p.name, { x: (p.cx - sq.left) / sq.side, y: (p.cy - sq.top) / sq.side, w: p.w / sq.side }]))
    // 2026-09-09 那个 bug 的签名是**所有道具叠在同一点**(anchor = 脚底正中)。笔记本的槽位本来就在脚前,
    // 所以不按「离脚底多远」判,而是:三个道具两两分开,且头顶 / 身侧两个明显不在脚底。
    const names = Object.keys(rel)
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
      const a = rel[names[i]], b = rel[names[j]]
      expect(Math.hypot(a.x - b.x, a.y - b.y), `${names[i]} 和 ${names[j]} 叠在一起`).toBeGreaterThan(0.15)
    }
    for (const name of ['exclamation', 'envelope']) expect(Math.hypot(rel[name].x - 0.5, rel[name].y - 0.918), `${name} 掉在脚底`).toBeGreaterThan(0.2)
    for (const [name, p] of Object.entries(rel)) {
      expect(p.w, `${name} 尺寸没按舞台边长算`).toBeGreaterThan(0.2)
      expect(p.w).toBeLessThan(0.6)
    }
    // 槽位语义(相对角色,不是坐标常量):感叹号在头顶右上,笔记本在脚前正中,信封在身侧。
    expect(rel.exclamation.y).toBeLessThan(0.45)
    expect(rel.exclamation.x).toBeGreaterThan(0.55)
    expect(rel.laptop.y).toBeGreaterThan(0.65)
    expect(Math.abs(rel.laptop.x - 0.5)).toBeLessThan(0.12)
    expect(rel.envelope.x).toBeGreaterThan(0.75)
    expect(rel.envelope.y).toBeGreaterThan(0.45)
  })

  shimTest('两态 13 个行为都解析到 cc-v1 的真 PNG,没有回退到占位或旧图', async ({ page, shimUrl, request }) => {
    await openLab(page, shimUrl)
    const manifest = (await (await request.get(new URL('assets/pet/cc-v1/manifest.json', shimUrl).href)).json()) as Manifest
    for (const form of ['lit', 'unlit'] as const) {
      // 换形态会先播转场(或淡入淡出),等它落地再逐个试行为,否则记录里是转场帧。
      await page.evaluate((f) => { const pet = (window as any).__pet; pet.setState('idle'); pet.setForm(f) }, form)
      await settleForm(page, form)
      for (const behavior of BEHAVIORS) {
        // 状态机有优先级:睡着时不接一次性行为等等。每个行为都从 idle 起跳,测的是资产不是优先级。
        await page.evaluate(() => (window as any).__pet.setState('idle'))
        await page.waitForTimeout(50)
        await resetSeen(page)
        // drag 只经 beginDrag/endDrag 进出,setState('drag') 会被状态机忽略——这是设计,不是 bug。
        await page.evaluate((b) => { const pet = (window as any).__pet; if (b === 'drag') pet.beginDrag(); else pet.setState(b) }, behavior)
        // 4fps 的一次性行为 250ms 后回落;等它把帧换过一轮再看记录。
        await page.waitForTimeout(450)
        if (behavior === 'drag') { await page.evaluate(() => (window as any).__pet.endDrag()); await page.waitForTimeout(100) }
        const declared = manifest.forms[form].states[behavior]?.frames.map(basename) ?? []
        expect(declared.length, `${form}/${behavior} 在 manifest 里没有帧`).toBeGreaterThan(0)
        const seen = (await seenSrc(page)).map(basename)
        const hit = seen.filter((s) => declared.includes(s))
        expect(hit.length, `${form}/${behavior}: 看到的是 ${seen.join(',')},声明的是 ${declared.join(',')}`).toBeGreaterThan(0)
        for (const s of await seenSrc(page)) {
          expect(s, `${form}/${behavior} 用了内联占位`).not.toMatch(/^data:/)
          expect(s, `${form}/${behavior} 不是 cc-v1 的 PNG`).toMatch(/\/assets\/pet\/cc-v1\/.*\.png$/)
        }
      }
      // 每个行为落回去之后画面必须还能解码(不是 404 的裂图)。
      const decoded = await page.evaluate(() => { const img = document.getElementById('pet-sprite') as HTMLImageElement; return { w: img.naturalWidth, h: img.naturalHeight } })
      expect(decoded).toEqual({ w: 512, h: 512 })
    }
    expect((await warnings(page)).filter((w) => !isKnown(w))).toEqual([])
  })

  shimTest('Dark→Light 播的是正式转场帧,落地在 lit idle', async ({ page, shimUrl }) => {
    await openLab(page, shimUrl, { reduced: false })
    await page.evaluate(() => { const pet = (window as any).__pet; pet.setForm('unlit'); pet.setState('idle') })
    await settleForm(page, 'unlit')
    await resetSeen(page)
    await page.evaluate(() => (window as any).__pet.setForm('lit'))
    await settleForm(page, 'lit')
    await page.waitForTimeout(300)
    const seen = await seenSrc(page)
    const frames = new Set(seen.filter((s) => s.includes('/transitions/dark-to-light/')).map(basename))
    // 8 帧 8fps,哪怕 MutationObserver 漏两帧,至少也该看到大半。
    expect(frames.size, `转场帧只看到 ${[...frames].join(',')}`).toBeGreaterThanOrEqual(5)
    expect(basename(seen[seen.length - 1])).toBe('front.png')
    expect(await snapshot(page)).toMatchObject({ form: 'lit', behavior: 'idle', transition: null })
  })

  shimTest('某帧 404:回退到同形态 idle、记 frame_missing,逻辑状态不丢', async ({ page, shimUrl }) => {
    await page.route('**/sprites/unlit/working.png', (route) => route.fulfill({ status: 404, body: 'gone' }))
    await openLab(page, shimUrl)
    await page.evaluate(() => { const pet = (window as any).__pet; pet.setForm('unlit'); pet.setState('working') })
    await page.waitForFunction(() => (window as any).__pet.warnings.some((w: string) => w.startsWith('frame_missing:')), { timeout: 5_000 })
    await page.waitForTimeout(300)
    const src = await page.evaluate(() => (document.getElementById('pet-sprite') as HTMLImageElement).src)
    expect(basename(src)).toBe('front.png')
    expect(src).toContain('/canonical/unlit/')
    expect(await snapshot(page)).toMatchObject({ form: 'unlit', behavior: 'working' })
    const decoded = await page.evaluate(() => (document.getElementById('pet-sprite') as HTMLImageElement).naturalWidth)
    expect(decoded).toBe(512)
  })
})

// 让 @playwright/test 的 `test`/`expect` 保持导入以复用类型;实际用例都挂在带 shim 的 shimTest 上。
void test
void expect
