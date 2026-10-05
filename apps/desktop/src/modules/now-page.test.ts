// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { mountNowPage } from './now-page.js'

function dom() {
  document.body.innerHTML = `<article class="cc-now-pane" data-now="home" data-cc="away">
    <button id="now-back" hidden></button><h1 id="now-greeting"></h1>
    <button id="now-cc-bubble" hidden><span class="now-bubble-text"></span><small class="now-bubble-time"></small><span class="now-bubble-more" hidden></span></button>
    <button id="now-cc"></button>
    <section id="now-waiting" hidden><h2 id="now-waiting-title"></h2><ul id="now-waiting-list"></ul></section>
    <div id="converse-root"></div></article>`
  return document.querySelector('.cc-now-pane') as HTMLElement
}
const poller = () => { let cb: any; return { subscribe: (f: any) => { cb = f; return () => {} }, push: (p: any) => cb(p) } }

describe('mountNowPage', () => {
  it('greets by hour and flips CC by presence', () => {
    const root = dom(); const pp = poller()
    mountNowPage({ root, presencePoller: pp, onOpenTask: vi.fn(), now: () => new Date(2026, 9, 1, 21) })
    expect(document.getElementById('now-greeting')!.textContent).toBe('晚上好')
    expect(root.dataset.cc).toBe('away')
    pp.push({ presence: 'ok' }); expect(root.dataset.cc).toBe('here')
    pp.push({ presence: 'down' }); expect(root.dataset.cc).toBe('away')
  })
  it('waiting rows: count title, whole row opens the task, hidden when empty', () => {
    const root = dom(); const open = vi.fn()
    const page = mountNowPage({ root, presencePoller: poller(), onOpenTask: open })
    page.setAttention({ stale: false, tasks: [{ id: 'a', title: '作品集', providerId: 'c', pendingPermissionCount: 1, pendingQuestionCount: 0, attentionKey: '["r"]' }] } as any)
    expect(document.getElementById('now-waiting')!.hidden).toBe(false)
    expect(document.getElementById('now-waiting-title')!.textContent).toBe('1 件事等你')
    ;(document.querySelector('.now-waiting-row') as HTMLElement).click()
    expect(open).toHaveBeenCalledWith('a')
    page.setAttention({ stale: false, tasks: [] }); expect(document.getElementById('now-waiting')!.hidden).toBe(true)
  })
  it('attention unreadable ⇒ grey「暂时不知道有没有等你的事」, no stale rows (M3)', () => {
    const root = dom(); const page = mountNowPage({ root, presencePoller: poller(), onOpenTask: vi.fn() })
    page.setAttention({ stale: true, tasks: [{ id: 'a', title: '作品集', providerId: 'c', pendingPermissionCount: 1, pendingQuestionCount: 0, attentionKey: '["r"]' }] } as any)
    expect(document.getElementById('now-waiting')!.hidden).toBe(false)
    expect(document.getElementById('now-waiting')!.dataset.state).toBe('unknown')
    expect(document.getElementById('now-waiting-title')!.textContent).toBe('暂时不知道有没有等你的事')
    expect(document.querySelectorAll('.now-waiting-row').length).toBe(0)
    page.setAttention({ stale: false, tasks: [] })
    expect(document.getElementById('now-waiting')!.hidden).toBe(true)
    expect(document.getElementById('now-waiting')!.dataset.state).toBeUndefined()
  })
  it('row shows the pending question / permission text itself, task title underneath (escaped)', () => {
    const root = dom(); const page = mountNowPage({ root, presencePoller: poller(), onOpenTask: vi.fn() })
    page.setAttention({ stale: false, tasks: [{ id: 'a', title: '作品集', providerId: 'c', pendingPermissionCount: 0, pendingQuestionCount: 1, attentionKey: '["q"]', first: { kind: 'question', text: '可以安装<b>图片</b>处理组件吗?' } }] } as any)
    const row = document.querySelector('.now-waiting-row') as HTMLElement
    expect(row.querySelector('.t')!.textContent).toBe('可以安装<b>图片</b>处理组件吗?')
    expect(row.querySelector('b')).toBeNull()
    expect(row.querySelector('.d')!.textContent).toBe('作品集')
    expect(row.querySelector('.go')!.textContent).toBe('回答 ›')
  })
  it('escapes task titles', () => {
    const root = dom(); const page = mountNowPage({ root, presencePoller: poller(), onOpenTask: vi.fn() })
    page.setAttention({ stale: false, tasks: [{ id: 'x', title: '<img src=x onerror=1>', providerId: 'c', pendingPermissionCount: 1, pendingQuestionCount: 0, attentionKey: '["r"]' }] } as any)
    expect(document.querySelector('#now-waiting-list img')).toBeNull()
  })
  it('bubble shows the latest real CC line, and bubble / CC open chat mode', () => {
    // 固定「现在」:同一天才只显示 HH:MM,别让这条测试过了今天就红。
    const root = dom(); const page = mountNowPage({ root, presencePoller: poller(), onOpenTask: vi.fn(), now: () => new Date(2026, 9, 1, 21) })
    page.setLatestLine({ text: '行程好了', at: new Date(2026, 9, 1, 20, 34).getTime() })
    expect(document.getElementById('now-cc-bubble')!.hidden).toBe(false)
    expect(document.querySelector('.now-bubble-time')!.textContent).toBe('20:34')
    ;(document.getElementById('now-cc-bubble') as HTMLElement).click()
    expect(root.dataset.now).toBe('chat'); expect(document.getElementById('now-back')!.hidden).toBe(false)
    ;(document.getElementById('now-back') as HTMLElement).click(); expect(root.dataset.now).toBe('home')
    ;(document.getElementById('now-cc') as HTMLElement).click(); expect(root.dataset.now).toBe('chat')
    page.setLatestLine(null); expect(document.getElementById('now-cc-bubble')!.hidden).toBe(true)
  })
  it('another day shows the date; unknown time shows nothing', () => {
    const root = dom(); const page = mountNowPage({ root, presencePoller: poller(), onOpenTask: vi.fn(), now: () => new Date(2026, 9, 1, 21) })
    page.setLatestLine({ text: '早', at: new Date(2026, 8, 30, 8, 5).getTime() })
    expect(document.querySelector('.now-bubble-time')!.textContent).toBe('9月30日 08:05')
    page.setLatestLine({ text: '早', at: null })
    expect(document.querySelector('.now-bubble-time')!.textContent).toBe('')
  })
  it('完整阅读入口只在预览省略内容时出现', () => {
    const root = dom(); const page = mountNowPage({ root, presencePoller: poller(), onOpenTask: vi.fn() })
    page.setLatestLine({ text: '整理好了。\n\n这是第二段。', at: null })
    expect(document.querySelector('.now-bubble-text')!.textContent).toBe('整理好了。')
    expect((document.querySelector('.now-bubble-more') as HTMLElement).hidden).toBe(false)
    expect(document.getElementById('now-cc-bubble')!.getAttribute('aria-label')).toContain('查看完整回复')
    page.setLatestLine({ text: '在呢。', at: null })
    expect((document.querySelector('.now-bubble-more') as HTMLElement).hidden).toBe(true)
  })
  it('greeting follows the clock: recomputed on presence ticks and on mode change', () => {
    const root = dom(); const pp = poller(); let h = 9
    const page = mountNowPage({ root, presencePoller: pp, onOpenTask: vi.fn(), now: () => new Date(2026, 9, 1, h) })
    const g = () => document.getElementById('now-greeting')!.textContent
    expect(g()).toBe('早上好')
    h = 14; pp.push({ presence: 'ok' }); expect(g()).toBe('下午好')
    h = 20; page.setMode('chat'); expect(g()).toBe('晚上好')
  })
})
