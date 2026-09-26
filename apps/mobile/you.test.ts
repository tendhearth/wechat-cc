import { describe, it, expect, vi } from 'vitest'
import { readMobileSource } from './sources'

function el() { return { innerHTML: '', textContent: '', hidden: false, src: '', classList: { toggle: vi.fn(), add: vi.fn(), remove: vi.fn(), contains: () => true }, addEventListener: vi.fn(), setAttribute: vi.fn() } }
function load(api: (p: string) => Promise<{ json: () => Promise<unknown> }>) {
  const els: Record<string, ReturnType<typeof el>> = {}
  const get = (id: string) => (els[id] ??= el())
  const env = {
    document: { getElementById: get, querySelectorAll: () => [], querySelector: () => el(), hidden: false, addEventListener: vi.fn() },
    window: { matchMedia: () => ({ matches: true }) },   // reduced motion: 不起定时器
    api, mobilePane: vi.fn(), setTimeout: vi.fn(), setInterval: vi.fn(), clearInterval: vi.fn(),
    esc: (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  }
  const fns = new Function(...Object.keys(env), `${readMobileSource('you.js')}\nreturn { youHtml, loadYou }`)(...Object.values(env)) as
    { youHtml: (v: unknown) => string; loadYou: () => Promise<void> }
  return { ...fns, els }
}
const base = { updated_at: '2026-09-25T20:00:00Z', when_label: '今天凌晨 4 点', failures: 0 }

describe('CC 眼中的你', () => {
  it('first: invites the first tidy, no section titles', () => {
    const h = load(async () => ({ json: async () => ({}) })).youHtml({ ...base, mood: 'first', changes: [], sections: [] })
    expect(h).toContain('今晚我会第一次整理。')
    expect(h).not.toContain('承 诺')
  })
  it('changed: line, note with labels and 原来是, dues, people columns, new dots, footer', () => {
    const h = load(async () => ({ json: async () => ({}) })).youHtml({ ...base, mood: 'changed',
      changes: [{ kind: 'add', label: '新记下', section: '承诺', text: '周五回话' }, { kind: 'update', label: '改了', section: '偏好', text: '先上线', before: '先打磨' }],
      sections: [
        { name: '承诺', items: [{ id: 'a', text: '周五回话(期限 2026-09-26)', display: '周五回话', due: '2026-09-26', due_label: '明天', person: null, changed: true }] },
        { name: '身边的人', items: [{ id: 'b', text: '猪大哥 —— 女友', display: '猪大哥 —— 女友', due: null, due_label: null, person: { name: '猪大哥', rel: '女友' }, changed: false }] },
      ] })
    expect(h).toContain('昨晚又认识了你一点。')
    expect(h).toContain('最近整理 · 今天凌晨 4 点')
    expect(h).toContain('新记下')
    expect(h).toContain('原来是:先打磨')
    expect(h).toContain('承 诺')
    expect(h).toContain('>明天<')
    expect(h).toContain('>猪大哥<')
    expect(h).toContain('you-new')
    expect(h).toContain('不对的地方,直接跟我说。')
  })
  it('steady and failing states', () => {
    const { youHtml } = load(async () => ({ json: async () => ({}) }))
    expect(youHtml({ ...base, mood: 'steady', changes: [], sections: [] })).toContain('这是我眼中的你。')
    expect(youHtml({ ...base, failures: 3, mood: 'steady', changes: [], sections: [] })).toContain('最近几次整理都没成功,下面可能是旧的')
  })
  it('escapes every dynamic string', () => {
    const h = load(async () => ({ json: async () => ({}) })).youHtml({ ...base, mood: 'changed',
      changes: [{ kind: 'add', label: '记下', section: '偏好', text: '<img src=x onerror=alert(1)>' }],
      sections: [{ name: '偏好', items: [{ id: 'a', text: '<script>x</script>', display: '<script>x</script>', due: null, due_label: null, person: null, changed: false }] }] })
    expect(h).not.toContain('<img')
    expect(h).not.toContain('<script>')
    expect(h).toContain('&lt;script&gt;')
  })
  it('load failure shows 暂时读不到 instead of a blank page', async () => {
    const { loadYou, els } = load(async () => { throw new Error('offline') })
    await loadYou()
    expect(els['you-body']!.innerHTML).toContain('暂时读不到')
  })
  it('no frames: a failing art fetch does not throw and leaves the image alone', async () => {
    const api = vi.fn(async (p: string) => {
      if (p === '/m/api/art/blink') throw new Error('401')
      return { json: async () => ({ ok: true, ...base, mood: 'steady', changes: [], sections: [] }) }
    })
    const { loadYou, els } = load(api)
    await expect(loadYou()).resolves.toBeUndefined()
    expect(els['you-img']?.src ?? '').toBe('')   // 没被碰过(元素都没取)或 src 仍为空
  })
  it('shows a loading line right away instead of an empty letter', () => {
    const { loadYou, els } = load(() => new Promise(() => {}))
    void loadYou()
    expect(els['you-body']!.innerHTML).toContain('看看我记得什么')
  })
})
