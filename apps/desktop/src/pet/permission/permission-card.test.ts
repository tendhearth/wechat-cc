import { describe, it, expect, vi } from 'vitest'
import { createPermissionCard } from './permission-card.js'

function makeEl(tag = 'div') {
  const kids: any[] = []; const classes = new Set<string>(); const handlers: Record<string, Array<(e: any) => void>> = {}
  const el: any = {
    tag, hidden: false, disabled: false, textContent: '', attrs: {} as Record<string, string>, children: kids, style: {},
    classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c), contains: (c: string) => classes.has(c) },
    setAttribute(k: string, v: string) { el.attrs[k] = v }, getAttribute(k: string) { return el.attrs[k] ?? null },
    appendChild(c: any) { kids.push(c); return c }, replaceChildren(...c: any[]) { kids.splice(0, kids.length, ...c) },
    addEventListener(t: string, fn: (e: any) => void) { (handlers[t] ??= []).push(fn) },
    fire(t: string, e: any = {}) { for (const fn of handlers[t] ?? []) fn({ preventDefault() {}, ...e }) },
    querySelector(sel: string) { return find(el, sel) },
    focus() { el.focused = true },
  }
  return el
}
function find(el: any, sel: string): any { const cls = sel.replace(/^\./, ''); if (el.classList?.contains(cls)) return el; for (const k of el.children ?? []) { const r = find(k, sel); if (r) return r } return null }
const item = { hash: 'abcde', prompt: 'Bash: rm -rf ./tmp', since: 's', expires_at: 'e' }

describe('createPermissionCard', () => {
  it('show 渲染标题、三个真实按钮、隐藏的 prompt;查看切换展开;count>1 显示 +n', () => {
    const root = makeEl(); const card = createPermissionCard({ el: root, makeEl }, { canResolve: true, onResolve: vi.fn(async () => true) })
    card.show(item, 3)
    expect(root.hidden).toBe(false); expect(card.current()).toBe('abcde')
    expect(root.querySelector('.pet-card-count').textContent).toBe('+2'); expect(root.querySelector('.pet-card-count').hidden).toBe(false)
    const pre = root.querySelector('.pet-card-prompt'); expect(pre.hidden).toBe(true); expect(pre.textContent).toBe('Bash: rm -rf ./tmp')
    root.querySelector('.pet-card-view').fire('click'); expect(pre.hidden).toBe(false); expect(root.querySelector('.pet-card-view').attrs['aria-expanded']).toBe('true')
    root.fire('keydown', { key: 'Escape' }); expect(pre.hidden).toBe(true)
  })
  it('允许 → onResolve(hash, allow) → 成功隐藏;失败恢复按钮并提示', async () => {
    const root = makeEl(); const onResolve = vi.fn(async () => true)
    const card = createPermissionCard({ el: root, makeEl }, { canResolve: true, onResolve })
    card.show(item, 1)
    const allow = root.querySelector('.pet-card-allow'); allow.fire('click'); expect(allow.disabled).toBe(true)
    await Promise.resolve(); await Promise.resolve()
    expect(onResolve).toHaveBeenCalledWith('abcde', 'allow'); expect(root.hidden).toBe(true); expect(card.current()).toBeNull()
    const root2 = makeEl(); const card2 = createPermissionCard({ el: root2, makeEl }, { canResolve: true, onResolve: vi.fn(async () => false) })
    card2.show(item, 1); root2.querySelector('.pet-card-deny').fire('click'); await Promise.resolve(); await Promise.resolve()
    expect(root2.hidden).toBe(false); expect(root2.querySelector('.pet-card-deny').disabled).toBe(false); expect(root2.querySelector('.pet-card-title').textContent).toContain('没送出去')
  })
  it('canResolve=false:只显示提示行,没有允许 / 拒绝按钮;同一 hash 重复 show 不重建', () => {
    const root = makeEl(); const card = createPermissionCard({ el: root, makeEl }, { canResolve: false, onResolve: vi.fn(async () => true) })
    card.show(item, 1)
    expect(root.querySelector('.pet-card-allow')).toBeNull(); expect(root.querySelector('.pet-card-note').hidden).toBe(false)
    const before = root.children[0]; card.show(item, 1); expect(root.children[0]).toBe(before)
    card.hide(); expect(root.hidden).toBe(true); expect(root.children).toHaveLength(0)
  })
})
