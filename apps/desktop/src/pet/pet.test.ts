function fakeStyle() { const rec: Record<string, string> = {}; return Object.assign(rec, { setProperty(k: string, v: string) { rec[k] = v } }) }
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPet } from './pet.js'
import { fallbackFrame } from '../assets/pet/cc-v1/placeholder.js'

const realRaw = readFileSync(join(__dirname, '../assets/pet/manifest.json'), 'utf8')
const fetchReal = (async () => new Response(realRaw, { status: 200 })) as unknown as typeof fetch

function el(tag = 'div') {
  const classes = new Set<string>(); const kids: any[] = []
  return { tag, style: fakeStyle(), src: '', textContent: '', hidden: false, attrs: {} as Record<string, string>,
    classList: { add: (c: string) => { classes.add(c) }, remove: (c: string) => { classes.delete(c) }, contains: (c: string) => classes.has(c) },
    setAttribute(k: string, v: string) { this.attrs[k] = v }, getAttribute(k: string) { return this.attrs[k] ?? null },
    appendChild(c: any) { kids.push(c) }, replaceChildren(...c: any[]) { kids.splice(0, kids.length, ...c) }, children: kids,
    insertBefore(c: any, ref: any) { const i = kids.indexOf(ref); kids.splice(i < 0 ? kids.length : i, 0, c) } }
}
function clock() {
  let now = 0; let seq = 0; const q: Array<{ at: number, id: number, fn: () => void }> = []
  return { schedule: (fn: () => void, ms: number) => { const id = ++seq; q.push({ at: now + ms, id, fn }); return id },
    cancel: (id: unknown) => { const i = q.findIndex(x => x.id === id); if (i >= 0) q.splice(i, 1) },
    tick(ms: number) { const until = now + ms; while (true) { q.sort((a, b) => a.at - b.at); const n = q[0]; if (!n || n.at > until) break; q.shift(); now = n.at; n.fn() } now = until },
    pending: () => q.length }
}
const boot = async (fetchImpl = fetchReal, reducedMotion = false, manifestUrl = './assets/pet/manifest.json') => {
  const c = clock(); const root = { stage: el(), img: el('img'), props: el(), hint: el('p') }
  // random: () => 0 —— 随机小动作取区间下界,时间线就是确定的(blink 6000ms、look 25000ms)。
  const pet = await createPet(root, { manifestUrl, fetchImpl, reducedMotion, makeEl: el, schedule: c.schedule, cancel: c.cancel, preload: () => {}, random: () => 0 })
  return { c, root, pet }
}

describe('createPet(组装)', () => {
  it('加载真 manifest:初始 unlit idle 显示 master-unlit;anchor 写到舞台;呼吸开着', async () => {
    const { root, pet } = await boot()
    expect(root.img.src).toBe('./assets/pet/reference/master-unlit.png')
    expect(root.stage.style['--pet-anchor-y']).toBe('0.91796875')
    expect(root.stage.classList.contains('pet-breathing')).toBe(true)
    expect(pet.warnings).toEqual([])
  })
  it('setForm(lit) 播 8 帧转场后停在 lit idle(master-lit);转场中呼吸关', async () => {
    const { c, root, pet } = await boot()
    expect(pet.setForm('lit')).toBe(true)
    expect(root.img.src).toBe('./assets/pet/transitions/unlit-to-lit/000.png')
    expect(root.stage.classList.contains('pet-breathing')).toBe(false)
    c.tick(125 * 8 + 5)
    expect(pet.machine.snapshot().form).toBe('lit')
    expect(root.img.src).toBe('./assets/pet/reference/master-lit.png')
    expect(root.stage.classList.contains('pet-breathing')).toBe(true)
  })
  it('lit 下 working 显示 working 帧 + laptop 道具;done 播一次后回到 working', async () => {
    const { c, root, pet } = await boot()
    pet.setForm('lit'); c.tick(1100)
    pet.setState('working'); pet.setProps(['laptop'])
    expect(root.img.src).toBe('./assets/pet/states/working/000.png')
    expect(root.props.children[0].attrs['data-prop']).toBe('laptop')
    pet.setState('done')
    expect(root.img.src).toBe('./assets/pet/states/done/000.png')
    c.tick(260)
    expect(root.img.src).toBe('./assets/pet/states/working/000.png')
  })
  it('unlit 下 working:画面仍是 master-unlit,逻辑状态是 working,warnings 记了回退', async () => {
    const { root, pet } = await boot()
    pet.setState('working')
    expect(pet.machine.snapshot().behavior).toBe('working')
    expect(root.img.src).toBe('./assets/pet/reference/master-unlit.png')
    expect(pet.warnings).toContain('fallback:unlit/working→unlit/idle')
  })
  it('unlit 下一次性行为(receive)没有专属帧:露 600ms 后回落到 idle,不会卡住', async () => {
    const { c, pet } = await boot()
    expect(pet.setState('receive')).toBe('applied')
    expect(pet.machine.snapshot().behavior).toBe('receive')
    c.tick(610)
    expect(pet.machine.snapshot().behavior).toBe('idle')
  })
  it('lit → unlit 走淡出淡入(不倒放):中途 pet-fading,结束后 master-unlit', async () => {
    const { c, root, pet } = await boot()
    pet.setForm('lit'); c.tick(1100)
    pet.setForm('unlit')
    expect(root.img.classList.contains('pet-fading')).toBe(true)
    c.tick(245); expect(root.img.src).toBe('./assets/pet/reference/master-unlit.png')
    c.tick(245); expect(pet.machine.snapshot()).toMatchObject({ form: 'unlit', transition: null })
    expect(pet.warnings).toContain('fallback:transition/lit-to-unlit→fade')
  })
  it('applyIntent:form → props → 持续行为 → oneShots;setHint 控制提示可见', async () => {
    const { c, root, pet } = await boot()
    pet.applyIntent({ form: 'lit', behavior: 'companion', props: ['envelope'], badge: 2, hint: null, oneShots: ['receive'] })
    c.tick(1100)                       // 转场播完
    expect(pet.machine.snapshot()).toMatchObject({ form: 'lit', resting: 'companion' })
    expect(root.props.children[0].attrs['data-prop']).toBe('envelope')
    expect(root.hint.hidden).toBe(true)
    pet.setHint('daemon 没起')
    expect(root.hint.hidden).toBe(false); expect(root.hint.textContent).toBe('daemon 没起')
  })
  it('转场里被挡下的一次性行为不会丢:转场落地后补播 error', async () => {
    const { c, root, pet } = await boot()
    pet.applyIntent({ form: 'lit', behavior: 'idle', props: [], badge: 0, hint: null, oneShots: ['error'] })
    expect(root.img.src).toBe('./assets/pet/transitions/unlit-to-lit/000.png')
    c.tick(1005)
    expect(root.img.src).toBe('./assets/pet/states/error/000.png')
    c.tick(260)
    expect(pet.machine.snapshot().behavior).toBe('idle')
    expect(root.img.src).toBe('./assets/pet/reference/master-lit.png')
  })
  it('某帧加载失败:把坏帧从 manifest 摘掉,回退到同形态 idle,warning 一条(逻辑状态不变)', async () => {
    const { c, root, pet } = await boot()
    pet.setForm('lit'); c.tick(1100)
    pet.setState('working')
    expect(root.img.src).toBe('./assets/pet/states/working/000.png')
    pet.reportFrameError('./assets/pet/states/working/000.png')
    expect(root.img.src).toBe('./assets/pet/reference/master-lit.png')
    expect(pet.warnings).toContain('frame_missing:./assets/pet/states/working/000.png')
    expect(pet.warnings).toContain('fallback:lit/working→lit/idle')
    expect(pet.machine.snapshot().behavior).toBe('working')
  })
  it('转场丢一帧:剩下 7 帧照播完,不崩', async () => {
    const { c, root, pet } = await boot()
    pet.setForm('lit')
    c.tick(125)
    expect(root.img.src).toBe('./assets/pet/transitions/unlit-to-lit/001.png')
    pet.reportFrameError('./assets/pet/transitions/unlit-to-lit/003.png')
    expect(root.img.src).toBe('./assets/pet/transitions/unlit-to-lit/000.png')   // 重播,少了那一帧
    c.tick(125 * 7 + 5)
    expect(pet.machine.snapshot()).toMatchObject({ form: 'lit', transition: null })
    expect(root.img.src).toBe('./assets/pet/reference/master-lit.png')
  })
  it('被更高优先级挡下的一次性行为也不丢:error 播完补播 receive', async () => {
    const { c, root, pet } = await boot()
    pet.setForm('lit'); c.tick(1100)
    pet.applyIntent({ form: 'lit', behavior: 'idle', props: [], badge: 0, hint: null, oneShots: ['error', 'receive'] })
    expect(root.img.src).toBe('./assets/pet/states/error/000.png')
    c.tick(250)
    expect(root.img.src).toBe('./assets/pet/states/receive/000.png')
    c.tick(250)
    expect(pet.machine.snapshot().behavior).toBe('idle')
    expect(root.img.src).toBe('./assets/pet/reference/master-lit.png')
  })
  it('空闲小动作(spec §4):lit idle 里 6s 后眨一次眼,播完回 idle', async () => {
    const { c, root, pet } = await boot()
    pet.setForm('lit'); c.tick(1100)
    c.tick(6000)
    expect(pet.machine.snapshot().behavior).toBe('blink')
    c.tick(125)
    expect(root.img.src).toBe('./assets/pet/states/blink-half/000.png')
    c.tick(625)
    expect(pet.machine.snapshot().behavior).toBe('idle')
    expect(root.img.src).toBe('./assets/pet/reference/master-lit.png')
  })
  it('眨眼不会把张望一路推后:进 idle 满 25s 就 look 一次,working 后两个计时器都撤掉', async () => {
    const { c, root, pet } = await boot()
    pet.setForm('lit'); c.tick(1100)          // t=1000 进 lit idle:blink 排在 +6s,look 排在 +25s
    c.tick(24_900)                            // 中间眨了几次眼,look 的倒计时不该被清零
    expect(pet.machine.snapshot().behavior).toBe('look')
    expect(root.img.src).toBe('./assets/pet/states/look-left/000.png')
    c.tick(250)
    expect(pet.machine.snapshot().behavior).toBe('idle')
    expect(root.img.src).toBe('./assets/pet/reference/master-lit.png')
    pet.setState('working')
    c.tick(200)                               // 换帧的交叉淡化 160ms 有自己的计时器,让它走完
    expect(c.pending()).toBe(0)               // 忙起来就没有待发的 blink / look 了
  })
  it('working 不排空闲小动作:12 秒里一动不动', async () => {
    const { c, root, pet } = await boot()
    pet.setForm('lit'); c.tick(1100)
    pet.setState('working')
    c.tick(12_000)
    expect(pet.machine.snapshot().behavior).toBe('working')
    expect(root.img.src).toBe('./assets/pet/states/working/000.png')
  })
  it('reducedMotion:一个空闲小动作都不排', async () => {
    const { c, root, pet } = await boot(fetchReal, true)
    pet.setForm('lit'); c.tick(1100)
    c.tick(20_000)
    expect(pet.machine.snapshot().behavior).toBe('idle')
    expect(root.img.src).toBe('./assets/pet/reference/master-lit.png')
  })
  it('manifest 加载失败:不抛,显示提示,setState 不崩,warnings 含原因', async () => {
    const fetch404 = (async () => new Response('x', { status: 404 })) as unknown as typeof fetch
    const { root, pet } = await boot(fetch404)
    expect(pet.warnings).toContain('manifest:http_404')
    expect(root.hint.hidden).toBe(false)
    expect(() => pet.setState('working')).not.toThrow()
  })
  it('reducedMotion:不呼吸', async () => {
    const { root } = await boot(fetchReal, true)
    expect(root.stage.classList.contains('pet-breathing')).toBe(false)
  })
})

describe('CC v1 kit runtime and terminal fallback', () => {
  const raw = readFileSync(join(__dirname, '../assets/pet/cc-v1/manifest.json'), 'utf8')
  const kitFetch = (async () => new Response(raw)) as unknown as typeof fetch
  const bootKit = () => boot(kitFetch, true, './assets/pet/cc-v1/manifest.json')
  it('uses Dark working directly, transitions to Light and preserves real resting behavior', async () => {
    const { c, root, pet } = await bootKit()
    pet.setState('working')
    expect(root.img.src).toBe('./assets/pet/cc-v1/sprites/unlit/working.png')
    pet.setForm('lit'); c.tick(1001)
    expect(root.img.src).toBe('./assets/pet/cc-v1/sprites/lit/working.png')
    pet.setState('done'); c.tick(251)
    expect(pet.machine.snapshot()).toMatchObject({ form: 'lit', behavior: 'working' })
    pet.destroy(); expect(c.pending()).toBe(0)
  })
  it('broken working, idle and master reach same-form inline geometry without losing working', async () => {
    const { root, pet, c } = await bootKit()
    pet.setState('working')
    pet.reportFrameError('https://example.test/assets/pet/cc-v1/sprites/unlit/working.png')
    expect(root.img.src).toBe('./assets/pet/cc-v1/canonical/unlit/front.png')
    pet.reportFrameError('https://example.test/assets/pet/cc-v1/canonical/unlit/front.png')
    expect(root.img.src).toBe(fallbackFrame('unlit'))
    expect(pet.machine.snapshot().behavior).toBe('working')
    const count = pet.warnings.length
    pet.reportFrameError('https://example.test/assets/pet/cc-v1/canonical/unlit/front.png')
    expect(pet.warnings).toHaveLength(count)
    pet.destroy(); expect(c.pending()).toBe(0)
  })
  it('entire missing transition falls back to fade and resolves form exactly once', async () => {
    const { c, root, pet } = await bootKit()
    pet.setForm('lit')
    for (const p of JSON.parse(raw).transitions['unlit-to-lit'].frames) pet.reportFrameError('./assets/pet/cc-v1/' + p)
    c.tick(481)
    expect(pet.machine.snapshot()).toMatchObject({ form: 'lit', transition: null })
    expect(root.img.src).toBe('./assets/pet/cc-v1/canonical/lit/front.png')
    pet.destroy(); expect(c.pending()).toBe(0)
  })
  it.each(['404', 'invalid-json', 'invalid-anatomy'])('manifest %s still renders and consumes real intents', async (kind) => {
    const bad = JSON.parse(raw); bad.character.feet = 3
    const fetchImpl = (async () => kind === '404' ? new Response('missing', { status: 404 }) : new Response(kind === 'invalid-json' ? '{bad' : JSON.stringify(bad))) as unknown as typeof fetch
    const { c, root, pet } = await boot(fetchImpl, true)
    expect(root.img.src).toBe(fallbackFrame('unlit'))
    pet.applyIntent({ form: 'lit', behavior: 'working', props: ['envelope'], badge: 3, hint: null, oneShots: [] })
    c.tick(481)
    expect(pet.machine.snapshot()).toMatchObject({ form: 'lit', behavior: 'working', props: ['envelope'], badge: 3 })
    expect(root.img.src).toBe(fallbackFrame('lit'))
    expect(root.hint.hidden).toBe(false)
    pet.setState('permission')
    expect(pet.machine.snapshot().behavior).toBe('permission')
    pet.destroy(); expect(c.pending()).toBe(0)
  })
})

describe('交叉淡化(ghost)', () => {
  it('开窗建一张常驻 ghost,插在主体前面;行为切换时上一帧放到 ghost 上淡出,序列内逐帧不淡', async () => {
    const { pet, root, c } = await boot()
    root.stage.appendChild(root.img)
    // boot 里 createPet 早于 appendChild,ghost 是 insertBefore(ghost, img) 进来的:img 不在树里时落到末尾。
    const ghost = root.stage.children.find((k: any) => k.classList.contains('pet-ghost'))
    expect(ghost).toBeTruthy()
    expect(ghost.classList.contains('pet-sprite')).toBe(true)
    pet.setForm('lit'); c.tick(1100)
    const idle = root.img.src
    pet.setState('thinking')
    expect(ghost.src).toBe(idle)                                  // 上一帧留在 ghost 上
    expect(ghost.classList.contains('pet-ghost-out-a')).toBe(true)
    expect(root.img.src).not.toBe(idle)                           // 主体已经是新帧
    c.tick(200)
    expect(ghost.classList.contains('pet-ghost-out-a')).toBe(false) // 淡完摘类
    const thinking = root.img.src
    pet.setState('working')
    expect(ghost.src).toBe(thinking)
    expect(ghost.classList.contains('pet-ghost-out-b')).toBe(true) // 交替类名,让 animation 重启
    c.tick(200)
    pet.setState('blink'); const first = root.img.src; c.tick(130)  // 8fps 序列走一帧
    expect(root.img.src).not.toBe(first)
    expect(ghost.src).not.toBe(first)                              // 序列内换帧不进 ghost
  })
  it('reduced motion 不做交叉淡化:ghost 不接帧', async () => {
    const { pet, root, c } = await boot(fetchReal, true)
    const ghost = root.stage.children.find((k: any) => k.classList.contains('pet-ghost'))
    pet.setForm('lit'); c.tick(1100)
    pet.setState('thinking')
    expect(ghost.src).toBe('')
    expect(ghost.classList.contains('pet-ghost-out-a') || ghost.classList.contains('pet-ghost-out-b')).toBe(false)
  })
})

