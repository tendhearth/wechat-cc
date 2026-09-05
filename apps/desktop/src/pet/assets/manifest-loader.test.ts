import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeManifest, loadManifest } from './manifest-loader.js'

const realRaw = JSON.parse(readFileSync(join(__dirname, '../../assets/pet/manifest.json'), 'utf8'))

describe('normalizeManifest — v1 扁平形状(资产包现状)', () => {
  it('states 全归到 lit;unlit 只有 master 的 idle;anchor 是比例;路径拼上 baseUrl', () => {
    const r = normalizeManifest(realRaw, './assets/pet')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const m = r.manifest
    expect(m.canvas).toEqual({ width: 512, height: 512, anchor: [0.5, 0.91796875] })
    expect(Object.keys(m.forms.lit.states).sort()).toEqual(['blink', 'companion', 'done', 'drag', 'error', 'idle', 'look', 'permission', 'receive', 'sleep', 'thinking', 'wake', 'working'])
    expect(m.forms.lit.master).toBe('./assets/pet/reference/master-lit.png')
    expect(m.forms.unlit.master).toBe('./assets/pet/reference/master-unlit.png')
    expect(m.forms.unlit.states).toEqual({ idle: { frames: ['./assets/pet/reference/master-unlit.png'], fps: 1, loop: true, next: null } })
    expect(m.forms.lit.states.blink).toEqual({ frames: [
      './assets/pet/reference/master-lit.png', './assets/pet/states/blink-half/000.png', './assets/pet/states/blink-closed/000.png', './assets/pet/states/blink-half/000.png', './assets/pet/reference/master-lit.png',
    ], fps: 8, loop: false, next: 'idle' })
    expect(m.transitions['unlit-to-lit']!.frames).toHaveLength(8)
    expect(m.transitions['unlit-to-lit']!.fps).toBe(8)
    expect(m.props.envelope).toBe('./assets/pet/props/envelope.png')
    expect(m.warnings).toEqual([])
  })
  it('每张引用到的文件都真的存在(资产包完整性)', () => {
    const r = normalizeManifest(realRaw, join(__dirname, '../../assets/pet'))
    if (!r.ok) throw new Error(r.reason)
    const all = new Set<string>()
    for (const f of Object.values(r.manifest.forms)) { all.add(f.master); for (const a of Object.values(f.states)) a.frames.forEach(x => all.add(x)) }
    for (const a of Object.values(r.manifest.transitions)) a.frames.forEach(x => all.add(x))
    Object.values(r.manifest.props).forEach(x => all.add(x))
    for (const p of all) expect(() => readFileSync(p)).not.toThrow()
    // 资产包实际只有 33 张 png(reference/canonical-reference-{1,2}.png 未被 manifest 引用),
    // 故 manifest 引用到的去重文件数是 31,不是任务书里假设的 36(见 task-1-report.md 的偏差记录)。
    expect(all.size).toBe(31)
  })
})

describe('normalizeManifest — forms 嵌套形状(handoff 目标契约)', () => {
  const nested = {
    schemaVersion: 1,
    canvas: { width: 512, height: 512, anchor: { x: 256, y: 470 } },
    forms: {
      unlit: { states: { idle: { frames: ['u/idle.png'], fps: 6, loop: true }, sleep: { frames: ['u/sleep.png'], fps: 2, loop: true } } },
      lit: { states: { idle: { frames: ['l/idle.png'], fps: 6, loop: true }, working: { frames: ['l/w0.png', 'l/w1.png'], fps: 8, loop: true } } },
    },
    transitions: { 'unlit-to-lit': { frames: ['t/0.png', 't/1.png'], fps: 8, loop: false }, 'lit-to-unlit': { frames: ['t/1.png', 't/0.png'], fps: 8, loop: false } },
    props: { mug: 'p/mug.png' },
  }
  it('px anchor 换算成比例;master 缺省取该 form idle 的第一帧;两个转场都保留', () => {
    const r = normalizeManifest(nested, '')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.manifest.canvas.anchor).toEqual([0.5, 470 / 512])
    expect(r.manifest.forms.unlit.master).toBe('u/idle.png')
    expect(r.manifest.forms.unlit.states.sleep!.fps).toBe(2)
    expect(r.manifest.forms.lit.states.working!.frames).toEqual(['l/w0.png', 'l/w1.png'])
    expect(Object.keys(r.manifest.transitions).sort()).toEqual(['lit-to-unlit', 'unlit-to-lit'])
    expect(r.manifest.transitions['unlit-to-lit']!.next).toBe('idle')   // 缺省 next=idle(非 loop)
  })
})

describe('normalizeManifest — 两级校验', () => {
  it('无法解析:不是对象 / 没 canvas / 一个 form 都没有 → ok:false', () => {
    expect(normalizeManifest(null).ok).toBe(false)
    expect(normalizeManifest({ states: {} }).ok).toBe(false)
    expect(normalizeManifest({ canvas: { width: 512, height: 512 } })).toEqual({ ok: false, reason: 'no_forms' })
  })
  it('可降级缺失:空 frames 的 state 被丢弃并记 warning;fps 非法回 4;loop 缺省 false 且 next 缺省 idle', () => {
    const r = normalizeManifest({
      canvas: { width: 512, height: 512, anchor: [0.5, 0.9] },
      canonical: { unlit: 'u.png', lit: 'l.png' },
      states: { idle: { frames: ['l.png'] }, working: { frames: [] }, look: { frames: ['k.png'], fps: -3 } },
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.manifest.forms.lit.states.working).toBeUndefined()
    expect(r.manifest.warnings).toContain('state_empty:lit/working')
    expect(r.manifest.forms.lit.states.look).toEqual({ frames: ['k.png'], fps: 4, loop: false, next: 'idle' })
    expect(r.manifest.forms.lit.states.idle).toEqual({ frames: ['l.png'], fps: 4, loop: false, next: 'idle' })
  })
  it('扁平形状缺 canonical.lit → lit.master 取 idle 第一帧;缺 canonical.unlit → unlit 用 lit master 顶上并 warning', () => {
    const r = normalizeManifest({ canvas: { width: 1, height: 1, anchor: [0.5, 0.5] }, states: { idle: { frames: ['l.png'], loop: true } } })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.manifest.forms.lit.master).toBe('l.png')
    expect(r.manifest.forms.unlit.master).toBe('l.png')
    expect(r.manifest.warnings).toContain('form_missing:unlit')
  })
})

describe('loadManifest', () => {
  it('fetch 成功 → normalize,baseUrl 是 manifest 所在目录;fetch 失败 / 非 JSON → ok:false 不抛', async () => {
    const fetchOk = (async () => new Response(JSON.stringify(realRaw), { status: 200 })) as unknown as typeof fetch
    const r = await loadManifest('./assets/pet/manifest.json', fetchOk)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.manifest.forms.lit.master).toBe('./assets/pet/reference/master-lit.png')
    const fetch404 = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch
    expect(await loadManifest('./x/manifest.json', fetch404)).toEqual({ ok: false, reason: 'http_404' })
    const fetchBad = (async () => new Response('{not json', { status: 200 })) as unknown as typeof fetch
    expect((await loadManifest('./x/manifest.json', fetchBad)).ok).toBe(false)
    const fetchThrow = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    expect(await loadManifest('./x/manifest.json', fetchThrow)).toEqual({ ok: false, reason: 'fetch_failed' })
  })
})
