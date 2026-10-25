/**
 * 随身 CC(手机)那 200 行内联 JS 的测试地基。
 *
 * 它此前**零测试**:是一整块 `String.raw` 模板,而仓库里没有 happy-dom / jsdom,
 * vitest 也没配 DOM 环境(桌面那些"UI 测试"其实都是纯函数返回字符串)。为了不给
 * 整个仓库新加一个 DOM 依赖,这里手写一个最小假 DOM:**只认注册过的 id,遇到没
 * 注册的直接抛** —— 比浏览器更严,元素不存在这类 bug 不会溜过去。
 *
 * 钉的是连接状态那组行为(2026-09-23):断线时说清"你看到的是几点的样子"、
 * 恢复即撤、回前台按当前页分路刷新;以及收敛 5b(2026-10-21)之后详情只看状态:
 * 没有对话记录、成果、接着说、批准 / 回答,只剩「停下」。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MOBILE_WORKBENCH_JS } from './mobile-page'
import { phoneHtml } from './settings-panel-html'
import { assembleMobilePage } from '../../../apps/mobile/assemble'
import { readMobileSource } from '../../../apps/mobile/sources'

const IDS = ['m-list', 'm-detail', 'm-back', 'm-title', 'm-agents', 'm-notice', 'm-status', 'm-conn']

type Handler = (ev: unknown) => void
interface FakeEl {
  id: string; textContent: string; innerHTML: string; hidden: boolean; disabled: boolean; value: string
  dataset: Record<string, string>; handlers: Record<string, Handler[]>
  addEventListener(type: string, fn: Handler): void
  replaceChildren(): void
  querySelectorAll(): FakeEl[]
  closest(): FakeEl | null
  fire(type: string, ev?: unknown): void
}

function fakeEl(id: string): FakeEl {
  return {
    id, textContent: '', innerHTML: '', hidden: false, disabled: false, value: '',
    dataset: {}, handlers: {},
    addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn) },
    replaceChildren() { this.innerHTML = '' },
    querySelectorAll() { return [] },
    closest() { return null },
    fire(type, ev) { for (const fn of this.handlers[type] ?? []) fn(ev ?? {}) },
  }
}

function harness(source = MOBILE_WORKBENCH_JS) {
  const els = new Map(IDS.map((id) => [id, fakeEl(id)]))
  // 照真页面来:连接提示那行平时不在(<div id="m-conn" hidden>),详情栏也是先藏着。
  els.get('m-conn')!.hidden = true
  els.get('m-detail')!.hidden = true
  const navButton = fakeEl('nav-matters'); navButton.dataset.p = 'matters'
  const docHandlers: Record<string, Handler[]> = {}
  const winHandlers: Record<string, Handler[]> = {}
  const store = new Map<string, string>()

  const doc = {
    hidden: false,
    getElementById(id: string) {
      const el = els.get(id)
      if (!el) throw new Error(`测试假 DOM 里没有登记这个元素:${id}(真页面有它吗?)`)
      return el
    },
    querySelectorAll(selector: string) { return selector.includes('nav button') ? [navButton] : [] },
    addEventListener(type: string, fn: Handler) { (docHandlers[type] ??= []).push(fn) },
  }
  const win = { addEventListener(type: string, fn: Handler) { (winHandlers[type] ??= []).push(fn) } }

  /** 一次 api 调用的记录;测试用 respond/fail 决定它怎么收场。 */
  const calls: Array<{ path: string; opts?: { method?: string; body?: string } }> = []
  let mode: 'ok' | 'down' = 'ok'
  let detail = {
    ok: true, matter: { id: 'm1', title: '首页调整', kind: 'task', status: 'open' }, runId: 'run1',
    permissions: [] as Array<Record<string, unknown>>, questions: [], events: [] as Array<Record<string, unknown>>, artifacts: [], inputs: [],
  }

  let deferred: (() => void) | undefined
  let deferNext = false
  const api = (path: string, opts?: { method?: string; body?: string }) => {
    calls.push({ path, ...(opts ? { opts } : {}) })
    if (mode === 'down') return Promise.reject(new Error('network down'))
    const body = path.startsWith('/m/api/matters')
      ? { ok: true, matters: [{ id: 'm1', title: '首页调整', kind: 'task', status: 'open' }] }
      : path.startsWith('/m/api/matter?') ? detail : { ok: true }
    const response = { status: 200, json: () => Promise.resolve(body) }
    if (deferNext && path.startsWith('/m/api/matter?')) {
      deferNext = false
      return new Promise<typeof response>((resolve) => { deferred = () => resolve(response) })
    }
    return Promise.resolve(response)
  }

  // 「停下」走 mPostOnce:一次只选一条通道,直连就是 fetch(q(path))
  const fetchStub = (path: string, opts?: { method?: string; body?: string }) => {
    calls.push({ path, ...(opts ? { opts } : {}) })
    if (mode === 'down') return Promise.reject(new Error('network down'))
    return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true }) })
  }
  const ccPlain = new Function(`${readMobileSource('boot.js').slice(readMobileSource('boot.js').indexOf('function ccPlain'))}\nreturn ccPlain`)()
  const boot = new Function('document', 'window', 'localStorage', 'REMOTE', 'api', 'esc', 'fetch', 'q', 'tunnel', 'preferTunnel', 'ccPlain', 'ccSelectMobilePane', source)
  boot(doc, win, {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
  }, { relay: 'https://relay.example', id: 'phone1' }, api, (s: string) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'), fetchStub, (p: string) => p, () => Promise.reject(new Error('no tunnel')), false, ccPlain, () => {})

  return {
    els, doc, calls, navButton, docHandlers, winHandlers,
    get conn() { return els.get('m-conn')! },
    get notice() { return els.get('m-notice')! },
    deferDetail() { deferNext = true },
    async resolveDetail() { deferred?.(); await vi.advanceTimersByTimeAsync(0) },
    async offline() { for (const fn of winHandlers.offline ?? []) fn({}); await vi.advanceTimersByTimeAsync(0) },
    down() { mode = 'down' },
    up() { mode = 'ok' },
    setDetail(next: Partial<typeof detail>) { detail = { ...detail, ...next } as typeof detail },
    /** 进「事」这一栏 → 拉列表。 */
    async enterPane() { navButton.fire('click'); await vi.advanceTimersByTimeAsync(0) },
    /** 点开列表里的那件事。 */
    async openMatter() {
      const list = els.get('m-list')!
      list.fire('click', { target: { closest: () => ({ dataset: { mid: 'm1' } }) } })
      await vi.advanceTimersByTimeAsync(0)
    },
    async tick(ms: number) { await vi.advanceTimersByTimeAsync(ms) },
    get status() { return els.get('m-status')! },
    /** 点状态区里的「停止这一轮」。 */
    async stop() {
      els.get('m-status')!.fire('click', { target: { closest: (sel: string) => (sel === '[data-stop]' ? { dataset: { stop: '1', task: 'm1', run: 'run1' } } : null) } })
      await vi.advanceTimersByTimeAsync(0)
    },
    postCalls() { return calls.filter((c) => c.opts?.method === 'POST').length },
    /** 切后台再回前台。 */
    async background() { doc.hidden = true; for (const fn of docHandlers['visibilitychange'] ?? []) fn({}); await vi.advanceTimersByTimeAsync(0) },
    async foreground() { doc.hidden = false; for (const fn of docHandlers['visibilitychange'] ?? []) fn({}); await vi.advanceTimersByTimeAsync(0) },
    listCalls() { return calls.filter((c) => c.path.startsWith('/m/api/matters')).length },
    detailCalls() { return calls.filter((c) => c.path.startsWith('/m/api/matter?')).length },
  }
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-23T14:05:00+08:00')) })
afterEach(() => { vi.useRealTimers() })

describe('连不上的时候,页面说清你看到的是几点的样子', () => {
  it('连续两拍没联系上 daemon,浮出一条带时刻的提示', async () => {
    const h = harness()
    await h.enterPane()
    await h.openMatter()
    expect(h.conn.hidden).toBe(true)

    h.down()
    await h.tick(3000)   // 第一拍失败 —— 一次抖动不打扰人
    expect(h.conn.hidden).toBe(true)
    await h.tick(3000)   // 第二拍也失败

    expect(h.conn.hidden).toBe(false)
    expect(h.conn.textContent).toContain('连不上')
    // 时刻按本机时区渲染 —— 断言也按本机算,否则这条会在 UTC 的 CI 上假红。
    expect(h.conn.textContent).toContain(new Date('2026-09-23T14:05:00+08:00').getHours().toString().padStart(2,'0'))
  })

  it('一恢复就自己撤掉,连断线期间那条错误提示一起抹掉', async () => {
    const h = harness()
    await h.enterPane()
    await h.openMatter()

    h.down()
    await h.tick(3000)
    await h.tick(3000)
    expect(h.conn.hidden).toBe(false)
    expect(h.notice.textContent).not.toBe('')   // 断线期间确实留了一条错误提示

    h.up()
    await h.tick(3000)

    expect(h.conn.hidden).toBe(true)
    expect(h.notice.textContent).toBe('')       // 旧错误不许赖着不走
  })

  it('停在列表页时回前台,列表会重新拉一次(此前只有详情页会刷)', async () => {
    const h = harness()
    await h.enterPane()
    const before = h.listCalls()

    await h.background()
    await h.foreground()

    expect(h.listCalls()).toBe(before + 1)
  })

})

describe('脚本要的元素,真页面里都得有', () => {
  it('内联 JS 里每个 getElementById 的 id 都能在手机页 HTML 里找到', () => {
    const html = phoneHtml('tok', null)
    const ids = [...MOBILE_WORKBENCH_JS.matchAll(/getElementById\((["'])([^"']+)\1\)/g)].map((m) => m[2]!)
    const missing = [...new Set(ids)].filter((id) => !html.includes(`id="${id}"`))
    // 这条守的是"测试里注册了、真页面却没加"这个空档 —— 假 DOM 抓不到它,
    // 因为假 DOM 的元素清单是测试自己写的。
    expect(missing, '脚本要用但页面上没有的元素').toEqual([])
  })
})

describe('一件事的详情在网页上只看状态(收敛 5b,2026-10-21)', () => {
  // agentNames:daemon 下发的名字(收敛清单 ⑥),网页只读它
  const busy = { matter: { id: 'm1', title: '**首页**调整', kind: 'task', status: 'open', agents: ['codex'], agentNames: { codex: 'Codex', claude: 'Claude' } }, task: { id: 'm1', providerId: 'codex', phase: 'working', status: 'running', error: null },
    events: [{ kind: 'user', text: '公开要求', createdAt: 1 }, { kind: 'text', text: '公开答复', createdAt: 2 }, { kind: 'tool_call', text: 'bun test', createdAt: 3, activity: { type: 'command', status: 'running', label: '跑测试' } }],
    artifacts: [{ id: 'a1', taskId: 'm1', name: '报告.md', mime: 'text/markdown', size: 10, sha256: 'x', createdAt: 1, approvedAt: null }],
    inputs: [{ id: 'i1', taskId: 'm1', runId: 'run1', text: '补一句', status: 'held' }] }

  it('标题(去掉排版记号)、执行者、状态词与正在跑的那一步;没有对话记录、成果、补充、接着说', async () => {
    const h = harness()
    h.setDetail(busy as never)
    await h.enterPane(); await h.openMatter()
    expect(h.els.get('m-title')!.textContent).toBe('首页调整')
    expect(h.els.get('m-agents')!.hidden).toBe(false)
    const html = h.status.innerHTML
    expect(html).toContain('<p class="m-state">在做</p>')
    expect(html).toContain('<span>正在</span> 跑测试')
    for (const gone of ['公开要求', '公开答复', '报告.md', '补一句', 'textarea', 'data-artifact', 'data-control', 'data-handoff', 'm-say']) expect(html).not.toContain(gone)
    expect(html).toContain('data-stop="1"')
  })

  it('等你决定 / 额度用完只当状态说:不出批准、回答、交接按钮', async () => {
    const h = harness()
    h.setDetail({ ...busy, events: [], task: { ...busy.task, phase: 'replied', status: 'completed' }, permissions: [{ id: 'p1', taskId: 'm1', tool: 'Bash', description: 'rm tmp' }],
      quotaHandoff: { state: 'offer', from: 'codex', to: 'claude', kind: 'quota', resetAt: Date.now() + 30 * 60000 } } as never)
    await h.enterPane(); await h.openMatter()
    const html = h.status.innerHTML
    expect(html).toContain('<p class="m-state">等你决定</p>')
    expect(html).toContain('有 1 项等你决定，到手机 App 或电脑上处理。')
    expect(html).toContain('Codex 的额度已用完。')
    expect(html).toContain('可以在手机 App 或电脑上交给 Claude 接着做。')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('rm tmp')
  })

  it('交出去了 / 没做成 / 完成 —— 状态词照用词表', async () => {
    const h = harness()
    h.setDetail({ ...busy, events: [], task: { ...busy.task, phase: 'failed', status: 'failed' }, quotaHandoff: { state: 'handed', from: 'codex', to: 'claude', matterId: 'abcdef12' } } as never)
    await h.enterPane(); await h.openMatter()
    expect(h.status.innerHTML).toContain('<p class="m-state">没做成</p>')
    expect(h.status.innerHTML).toContain('已经交给 Claude 接着做了。')
    h.setDetail({ ...busy, events: [], matter: { ...busy.matter, status: 'done' }, task: { ...busy.task, phase: 'replied' } } as never)
    await h.tick(3000)
    expect(h.status.innerHTML).toContain('<p class="m-state">完成</p>')
    expect(h.status.innerHTML).not.toContain('data-stop')
  })

  it('「停下」留着:点一下先要确认,再点才发一次 POST /m/api/matter/stop,不重发', async () => {
    const h = harness()
    h.setDetail(busy as never)
    await h.enterPane(); await h.openMatter()
    await h.stop()
    expect(h.status.innerHTML).toContain('再点一次，确认停止')
    expect(h.postCalls()).toBe(0)
    await h.stop()
    expect(h.calls.filter((c) => c.opts?.method === 'POST').map((c) => [c.path, c.opts!.body])).toEqual([['/m/api/matter/stop', JSON.stringify({ id: 'm1', runId: 'run1' })]])
    expect(h.notice.textContent).toBe('已经请电脑停下这一轮。')
  })

  it('页面上没有接着说、交办、成果、对话记录这些块', () => {
    const page = assembleMobilePage(readMobileSource).phone
    for (const id of ['m-say', 'm-say-box', 'm-send', 'm-events', 'm-artifacts', 'm-artifact-preview', 'm-inputs', 'm-controls', 'entry-root', 'terminal-root', 'lessons-root', 'p-sessions', 'p-memory', 'p-you', 'today-root', 'activity-root', 'home-result'])
      expect(page, id).not.toContain(`id="${id}"`)
    expect(page).not.toContain('CCM')
    expect(page.slice(page.indexOf('<script'), page.indexOf('<script') + 8)).toBe('<script>')
  })
})
