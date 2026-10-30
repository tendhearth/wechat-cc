// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { mountNowPage as mount } from './now-page.js'
import { readFileSync } from 'node:fs'
const manifest = readFileSync(`${__dirname}/../assets/pet/cc-v1/manifest.json`, 'utf8')
const mounted: ReturnType<typeof mount>[] = []
function mountNowPage(opts: Parameters<typeof mount>[0]) { const page = mount(opts); mounted.push(page); return page }
beforeEach(() => vi.stubGlobal('fetch', async () => new Response(manifest)))
afterEach(() => { for (const page of mounted.splice(0)) page.destroy(); vi.unstubAllGlobals() })

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
  it('compact rows keep each request purpose and task identity reachable through the native button', () => {
    const root = dom(); const open = vi.fn()
    const page = mountNowPage({ root, presencePoller: poller(), onOpenTask: open })
    page.setAttention({ stale: false, tasks: [
      { id: 'trip', title: '出差安排', pendingPermissionCount: 0, pendingQuestionCount: 1, first: { kind: 'question', text: '选哪一天？' } },
      { id: 'portfolio', title: '作品集', pendingPermissionCount: 1, pendingQuestionCount: 1, first: { kind: 'permission', text: 'Bash: npm install sharp' } },
    ] })
    const rows = [...root.querySelectorAll<HTMLButtonElement>('.now-waiting-row')]
    expect(rows[0]!.title).toBe('回答：选哪一天？ · 出差安排')
    expect(rows[1]!.title).toBe('看清楚：Bash: npm install sharp · 作品集 · 共 2 项')
    expect(rows[0]!.querySelector('.go .now-sr')!.textContent).toBe('回答 ›')
    expect(rows[1]!.querySelector('.go .now-sr')!.textContent).toBe('看清楚 ›')
    expect(rows[0]!.querySelector('.go svg')!.getAttribute('aria-hidden')).toBe('true')
    rows[1]!.focus()
    expect(document.activeElement).toBe(rows[1])
    rows[1]!.querySelector('.go svg')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(open).toHaveBeenCalledExactlyOnceWith('portfolio')
    expect(root.querySelector('#now-waiting')!.getAttribute('aria-labelledby')).toBe('now-waiting-title')
    expect(root.querySelector('#now-waiting-title')!.classList.contains('now-sr')).toBe(true)
  })
  it('partial reads disclose uncertainty while keeping terminal requests available, then recover to quiet known state', () => {
    const root = dom()
    const page = mountNowPage({ root, presencePoller: poller(), onOpenTask: vi.fn(), onResolveTerminal: vi.fn(async () => true) })
    page.setAttention({ stale: true, tasks: [{ id: 'old', title: '旧任务', pendingPermissionCount: 1, pendingQuestionCount: 0 }] })
    expect(root.querySelector('#now-waiting-title')!.classList.contains('now-sr')).toBe(false)
    page.setTerminal([{ id: 'terminal', title: '想运行 ls', detail: 'wechat-cc', agent: 'claude', source: 'Claude Code', hash: 'k3x9z', tool: 'Bash', command: 'ls' }])
    expect((root.querySelector('#now-waiting') as HTMLElement).dataset.state).toBe('partial')
    expect(root.querySelector('#now-waiting-title')!.textContent).toContain('一起做那边暂时读不到')
    expect(root.querySelector('#now-waiting-title')!.classList.contains('now-sr')).toBe(false)
    expect(root.querySelector('[data-task-id="old"]')).toBeNull()
    const row = root.querySelector<HTMLButtonElement>('.now-terminal button')!
    expect(row.title).toBe('看清楚：想运行 ls · wechat-cc · Claude Code')
    expect(row.querySelector('.go .now-sr')!.textContent).toBe('看清楚 ›')
    row.click()
    expect(document.querySelector('.now-terminal-command')!.textContent).toBe('ls')
    page.setAttention({ stale: false, tasks: [] })
    expect((root.querySelector('#now-waiting') as HTMLElement).dataset.state).toBeUndefined()
    expect(root.querySelector('#now-waiting-title')!.classList.contains('now-sr')).toBe(true)
    page.destroy()
  })
  it('终端里等批准的会话接在工作台行后面;开了码的行只给「看清楚 ›」,点开小窗看清命令再允许 / 拒绝,不打开任务', async () => {
    const root = dom(); const open = vi.fn()
    let settle!: (v: boolean) => void
    const resolve = vi.fn(() => new Promise<boolean>(r => { settle = r }))
    const page = mountNowPage({ root, presencePoller: poller(), onOpenTask: open, onResolveTerminal: resolve })
    page.setAttention({ stale: false, tasks: [{ id: 'a', title: '作品集', providerId: 'c', pendingPermissionCount: 1, pendingQuestionCount: 0, attentionKey: '["r"]' }] } as any)
    page.setTerminal([
      { id: 's1', title: '想运行 npm publish', detail: 'wechat-cc', agent: 'claude', source: 'Claude Code', hash: 'k3x9z', tool: 'Bash', command: 'npm publish' },
      { id: 's2', title: '要改 <b>x</b>', detail: 'melu', agent: 'codex', source: 'Codex', hash: null, tool: '', command: '要改 <b>x</b>' },
    ])
    expect(document.getElementById('now-waiting-title')!.textContent).toBe('3 件事等你')
    expect(document.querySelectorAll('#now-waiting-list > li').length).toBe(3)
    const [t1, t2] = [...document.querySelectorAll<HTMLElement>('.now-terminal')]
    expect(t1!.querySelectorAll('button').length).toBe(1)
    expect(t1!.querySelector('.go')!.textContent).toBe('看清楚 ›')
    expect(t2!.querySelectorAll('button').length).toBe(0)
    expect(t2!.querySelector('.go')!.textContent).toBe('回终端处理')
    expect(t2!.querySelector('b')).toBeNull()
    // 行里只写项目;哪家是行尾的圆头像,名字在读屏标签里(2026-10-19)
    expect(t1!.querySelector('.d')!.textContent).toBe('wechat-cc')
    expect(t1!.querySelector('.th-agents')!.getAttribute('aria-label')).toBe('Claude Code')
    expect(t1!.querySelector('.th-agent svg')).not.toBeNull()
    expect(t2!.querySelector('.th-agents')!.getAttribute('aria-label')).toBe('Codex')
    ;(t1!.querySelector('button') as HTMLButtonElement).click()
    const dlg = document.querySelector('dialog.now-terminal-dialog') as HTMLDialogElement
    expect(dlg).not.toBeNull()
    expect(dlg.querySelector('h2')!.textContent).toBe('想运行 npm publish')
    expect(dlg.querySelector('header p')!.textContent).toBe('wechat-cc · Claude Code')
    expect(dlg.querySelector('.now-terminal-command')!.textContent).toBe('npm publish')
    ;(dlg.querySelector('[data-decision="allow"]') as HTMLButtonElement).click()
    expect(resolve).toHaveBeenCalledWith('k3x9z', 'allow')
    expect(open).not.toHaveBeenCalled()
    expect((dlg.querySelector('[data-decision="allow"]') as HTMLButtonElement).disabled).toBe(true)
    // 送出途中重绘(工作台每 3 秒一拍)不把「看清楚」放出来
    page.setAttention({ stale: false, tasks: [] } as any)
    expect(document.querySelectorAll('.now-terminal[data-hash="k3x9z"] button').length).toBe(0)
    settle(true); await new Promise(r => setTimeout(r, 0))
    expect(document.querySelector('.now-terminal[data-hash="k3x9z"] .go')!.textContent).toBe('已允许')
    expect(document.querySelector('dialog.now-terminal-dialog')).toBeNull()
    page.setTerminal([]); expect(document.getElementById('now-waiting')!.hidden).toBe(true)
  })
  it('终端拍板没送出去 ⇒ 小窗里按钮回来 + 说再试;那一项已不在 ⇒ 说处理过了;没有 onResolveTerminal ⇒ 行不能点', async () => {
    const root = dom()
    const resolve = vi.fn().mockRejectedValueOnce(new Error('403')).mockResolvedValueOnce(false)
    const page = mountNowPage({ root, presencePoller: poller(), onOpenTask: vi.fn(), onResolveTerminal: resolve })
    page.setTerminal([{ id: 's1', title: '想用 Bash', detail: 'd', agent: 'claude', source: 'Claude Code', hash: 'k3x9z', tool: 'Bash', command: '' }])
    ;(document.querySelector('.now-terminal button') as HTMLButtonElement).click()
    const dlg = () => document.querySelector('dialog.now-terminal-dialog') as HTMLDialogElement
    ;(dlg().querySelector('[data-decision="deny"]') as HTMLButtonElement).click()
    await new Promise(r => setTimeout(r, 0))
    expect(dlg().querySelector('.now-terminal-note')!.textContent).toBe('没送出去，再试一次')
    expect((dlg().querySelector('[data-decision="deny"]') as HTMLButtonElement).disabled).toBe(false)
    ;(dlg().querySelector('[data-decision="deny"]') as HTMLButtonElement).click()
    await new Promise(r => setTimeout(r, 0))
    expect(dlg()).toBeNull()
    expect(document.querySelector('.now-terminal .go')!.textContent).toBe('这一项已经处理过了')
    const root2 = dom()
    const page2 = mountNowPage({ root: root2, presencePoller: poller(), onOpenTask: vi.fn() })
    page2.setTerminal([{ id: 's1', title: 'Bash', detail: 'd', agent: 'claude', source: 'Claude Code', hash: 'k3x9z', tool: 'Bash', command: '' }])
    expect(document.querySelectorAll('.now-terminal button').length).toBe(0)
    void page
  })
  it('小窗开着时那一项被别处拍掉(列表里没了)⇒ 小窗自己关掉', () => {
    const root = dom()
    const page = mountNowPage({ root, presencePoller: poller(), onOpenTask: vi.fn(), onResolveTerminal: vi.fn(async () => true) })
    page.setTerminal([{ id: 's1', title: '想运行 ls', detail: 'd', agent: 'claude', source: 'Claude Code', hash: 'k3x9z', tool: 'Bash', command: 'ls' }])
    ;(document.querySelector('.now-terminal button') as HTMLButtonElement).click()
    expect(document.querySelector('dialog.now-terminal-dialog')).not.toBeNull()
    page.setTerminal([])
    expect(document.querySelector('dialog.now-terminal-dialog')).toBeNull()
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
  it('feeds real presence, permission and local conversation snapshots to the home character without replacing its navigation button', async () => {
    const root = dom(); const pp = poller()
    const page = mountNowPage({ root, presencePoller: pp, onOpenTask: vi.fn() })
    const button = document.getElementById('now-cc')!
    pp.push({ presence: 'ok', news: { unread: 0 } })
    await vi.waitFor(() => expect(root.querySelector('.now-pet-stage')?.getAttribute('data-form')).toBe('lit'))
    page.setConversationSnapshot([{ id: 1, role: 'cc', text: '…', pending: true }])
    expect(root.querySelector('.now-pet-stage')?.getAttribute('data-behavior')).toBe('thinking')
    page.setTerminal([{ id: 's', title: 'permission', detail: '', agent: 'codex', source: 'Codex', hash: 'p', tool: '', command: '' }])
    expect(root.querySelector('.now-pet-stage')?.getAttribute('data-behavior')).toBe('permission')
    page.setConversationSnapshot([{ id: 2, role: 'cc', text: '回复了' }])
    expect(root.querySelector('.now-pet-stage')?.getAttribute('data-behavior')).toBe('permission')
    expect(document.getElementById('now-cc')).toBe(button)
    button.click(); expect(root.dataset.now).toBe('chat')
    pp.push({ presence: 'down' })
    expect(root.dataset.cc).toBe('away')
    expect(root.querySelector('.now-pet-stage')?.getAttribute('data-form')).toBe('unlit')
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
