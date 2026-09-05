import { describe, it, expect } from 'vitest'
import { PROP_SLOTS, SLOTS, renderProps } from './prop-layer.js'
import { PROPS } from '../domain/types.js'
import type { PetManifest } from '../assets/manifest-loader.js'

function makeEl(tag: string) {
  const kids: any[] = []
  const classes = new Set<string>()
  return {
    tag, style: {} as Record<string, string>, textContent: '', src: '', attrs: {} as Record<string, string>,
    classList: { add: (c: string) => { classes.add(c) }, remove: (c: string) => { classes.delete(c) }, contains: (c: string) => classes.has(c) },
    setAttribute(k: string, v: string) { this.attrs[k] = v }, getAttribute(k: string) { return this.attrs[k] ?? null },
    appendChild(c: any) { kids.push(c) }, replaceChildren(...c: any[]) { kids.splice(0, kids.length, ...c) }, children: kids,
  }
}
const manifest = { canvas: { width: 512, height: 512, anchor: [0.5, 0.9] }, forms: {} as any, transitions: {}, props: { envelope: 'p/envelope.png', mug: 'p/mug.png' }, warnings: [] } as PetManifest

describe('prop-layer', () => {
  it('8 个道具都有槽位;3 个槽位都有偏移与缩放', () => {
    for (const p of PROPS) expect(SLOTS[PROP_SLOTS[p]]).toBeDefined()
    expect(Object.keys(SLOTS).sort()).toEqual(['above-head', 'beside-right', 'in-front'])
  })
  it('renderProps:每个道具一个 img(src 来自 manifest)+ 槽位 CSS 变量;envelope 带 badge;manifest 没有的道具跳过', () => {
    const c = makeEl('div')
    renderProps(c, ['envelope', 'mug', 'laptop'], 3, manifest, makeEl)
    expect(c.children).toHaveLength(2)
    const env = c.children[0]
    expect(env.children[0].src).toBe('p/envelope.png')
    expect(env.attrs['data-prop']).toBe('envelope')
    expect(env.style['--slot-dx']).toBe(String(SLOTS[PROP_SLOTS.envelope].dx))
    expect(env.children[1].textContent).toBe('3')          // badge
    expect(c.children[1].children).toHaveLength(1)         // mug 没 badge
  })
  it('空列表 → 清空;badge 0 不渲染数字', () => {
    const c = makeEl('div')
    renderProps(c, ['envelope'], 0, manifest, makeEl)
    expect(c.children[0].children).toHaveLength(1)
    renderProps(c, [], 0, manifest, makeEl)
    expect(c.children).toHaveLength(0)
  })
})
