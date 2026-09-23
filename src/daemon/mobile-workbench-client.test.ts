/**
 * 随身 CC(手机)那 200 行内联 JS 的测试地基。
 *
 * 它此前**零测试**:是一整块 `String.raw` 模板,而仓库里没有 happy-dom / jsdom,
 * vitest 也没配 DOM 环境(桌面那些"UI 测试"其实都是纯函数返回字符串)。为了不给
 * 整个仓库新加一个 DOM 依赖,这里手写一个最小假 DOM:**只认注册过的 id,遇到没
 * 注册的直接抛** —— 比浏览器更严,元素不存在这类 bug 不会溜过去。
 *
 * 钉的是连接状态那组行为(2026-09-23):断线时说清"你看到的是几点的样子"、
 * 恢复即撤、回前台按当前页分路刷新、断网期间点的那一下重连后核对(绝不自动重发)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MOBILE_WORKBENCH_JS } from './mobile-workbench-client'
import { phoneHtml } from './settings-panel-html'

const IDS = ['m-list', 'm-detail', 'm-back', 'm-title', 'm-notice', 'm-controls', 'm-permissions',
  'm-questions', 'm-events', 'm-artifacts', 'm-artifact-preview', 'm-inputs', 'm-say-box', 'm-say', 'm-send', 'm-conn']

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

function harness() {
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
    permissions: [] as Array<Record<string, unknown>>, questions: [], events: [], artifacts: [], inputs: [],
  }

  const api = (path: string, opts?: { method?: string; body?: string }) => {
    calls.push({ path, ...(opts ? { opts } : {}) })
    if (mode === 'down') return Promise.reject(new Error('network down'))
    const body = path.startsWith('/m/api/matters')
      ? { ok: true, matters: [{ id: 'm1', title: '首页调整', kind: 'task', status: 'open' }] }
      : path.startsWith('/m/api/matter?') ? detail : { ok: true }
    return Promise.resolve({ status: 200, json: () => Promise.resolve(body) })
  }

  const boot = new Function('document', 'window', 'localStorage', 'REMOTE', 'api', 'esc', 'URL', MOBILE_WORKBENCH_JS)
  boot(doc, win, {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
  }, { relay: 'https://relay.example', id: 'phone1' }, api, (s: string) => String(s), { revokeObjectURL() {} })

  return {
    els, doc, calls, navButton, docHandlers, winHandlers,
    get conn() { return els.get('m-conn')! },
    get notice() { return els.get('m-notice')! },
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
    /** 点权限卡上的「允许这一次」。 */
    async allow(requestId: string) {
      els.get('m-controls')!.fire('click', { target: { closest: () => ({ dataset: { control: 'allow', task: 'm1', request: requestId } }) } })
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

  it('断网时批的那一下:重连后发现已经生效,就明说生效了 —— 而且不重发', async () => {
    const h = harness()
    h.setDetail({ permissions: [{ id: 'p1', taskId: 'm1', tool: 'Bash', description: 'rm tmp' }] })
    await h.enterPane()
    await h.openMatter()

    h.down()
    await h.allow('p1')
    await h.tick(0)
    expect(h.postCalls()).toBe(1)

    // 重连时那条请求已经不在了 —— 说明刚才那下其实落到了 daemon 上。
    h.up()
    h.setDetail({ permissions: [] })
    await h.tick(3000)

    expect(h.notice.textContent).toContain('已经生效')
    expect(h.postCalls()).toBe(1)   // 绝不自动重发
  })

  it('断网时批的那一下:重连后那条还在,就明说没送出去', async () => {
    const h = harness()
    h.setDetail({ permissions: [{ id: 'p1', taskId: 'm1', tool: 'Bash', description: 'rm tmp' }] })
    await h.enterPane()
    await h.openMatter()

    h.down()
    await h.allow('p1')
    await h.tick(0)

    h.up()
    await h.tick(3000)   // 详情里 p1 仍然挂着

    expect(h.notice.textContent).toContain('没送出去')
    expect(h.postCalls()).toBe(1)
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
