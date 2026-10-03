import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readMobileSource } from './sources'

const SOURCE = 'deadbeef', NEXT = 'feedface', OTHER = '1234abcd'
const UUID = '06f37245-d260-4c32-889b-b4bf57b478a3'
const prefix = 'cc.phone.matter.v1:test-daemon:'
const offer = (to = 'codex') => ({ state: 'offer', from: 'claude', to, kind: 'quota', resetAt: Date.now() + 600_000 })
const detail = (id = SOURCE, quotaHandoff: any = offer()) => ({ ok: true, matter: { id, title: id, kind: 'task', status: 'open' },
  task: { id, providerId: 'claude', path: '/fixture/work', error: null, status: 'failed' }, events: [], permissions: [], questions: [], artifacts: [], inputs: [], quotaHandoff })
const response = (body: any, status = 200) => ({ status, json: async () => body })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
function element() {
  const handlers: Record<string, (...args: any[]) => any> = {}
  return { textContent: '', innerHTML: '', value: '', hidden: false, disabled: false, dataset: {} as Record<string, string>, handlers,
    addEventListener: (event: string, fn: (...args: any[]) => any) => { handlers[event] = fn },
    querySelectorAll: () => [], replaceChildren() { this.innerHTML = '' } }
}
function load(storage = new Map<string, string>()) {
  const els = new Map(['m-list', 'm-detail', 'm-back', 'm-title', 'm-notice', 'm-controls', 'm-permissions', 'm-questions', 'm-events',
    'm-artifacts', 'm-artifact-preview', 'm-inputs', 'm-say-box', 'm-say', 'm-send', 'm-conn', 'm-task-status'].map(id => [id, element()]))
  const get = (id: string) => { const value = els.get(id); if (!value) throw Error('missing element: ' + id); return value }
  const documentEvents: Record<string, (...args: any[]) => any> = {}, windowEvents: Record<string, (...args: any[]) => any> = {}
  const doc = { hidden: false, getElementById: get, querySelectorAll: () => [], addEventListener: (event: string, fn: (...args: any[]) => any) => { documentEvents[event] = fn } }
  let current: any = detail(), readNext: Promise<any> | null = null, result: () => Promise<any> = async () => response({ ok: true, matterId: NEXT, created: true })
  const calls: { path: string; method: string; body?: any; transport: string }[] = []
  const api = vi.fn(async (path: string) => {
    calls.push({ path, method: 'GET', transport: 'api' })
    if (path.startsWith('/m/api/matters')) return response({ ok: true, matters: [] })
    const id = new URL('http://fixture' + path).searchParams.get('id')!
    if (readNext) { const next = readNext; readNext = null; return next }
    return response(id === SOURCE ? current : detail(id, null))
  })
  const send = (transport: string) => vi.fn(async (path: string, opts: any) => {
    calls.push({ path, method: opts.method || 'GET', body: opts.body && JSON.parse(opts.body), transport })
    return result()
  })
  const fetch = send('lan'), tunnelSend = send('tunnel'), tunnel = vi.fn(async () => tunnelSend), confirm = vi.fn((_message: string) => true)
  const localStorage = { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) }
  const env = { document: doc, window: { confirm, addEventListener: (event: string, fn: (...args: any[]) => any) => { windowEvents[event] = fn } },
    localStorage, REMOTE: { id: 'test-daemon' }, api, fetch, tunnel, q: (path: string) => path, AbortController, setTimeout, clearTimeout, crypto, Uint8Array,
    URL: { revokeObjectURL: () => {} }, CCM: { renderMarkdown: (s: string) => s, hasMarkdownFormatting: () => false }, ago: () => '刚刚',
    esc: (s: any) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') }
  const fns = new Function(...Object.keys(env), 'var preferTunnel=false;\n' + readMobileSource('workbench.js') + '\nreturn {openMatter,mRefresh,mError,state:()=>({id:mCurrent,detail:mDetail,fresh:mDetailFresh,epoch:mHandoffViewEpoch}),notice:mNotice}')(...Object.values(env)) as {
    openMatter: (id: string) => Promise<void>; mRefresh: () => Promise<void>; mError: (code: string) => string;
    state: () => { id: string; detail: any; fresh: boolean; epoch: number }; notice: (message: string) => void }
  const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  const button = () => {
    const html = get('m-task-status').innerHTML, attrs = /<button[^>]*data-handoff="([^"]+)"[^>]*>/.exec(html)
    if (!attrs) throw Error('no handoff button')
    return { dataset: { task: SOURCE, handoff: attrs[1], handoffOffer: decode(/data-handoff-offer="([^"]*)"/.exec(attrs[0])?.[1] || '') } }
  }
  const click = (b = button()) => get('m-task-status').handlers.click!({ target: { closest: () => b } }) as Promise<void>
  const edit = (text: string) => { get('m-say').value = text; get('m-say').handlers.input!.call(get('m-say')) }
  return { ...fns, get, storage, calls, api, fetch, tunnel, tunnelSend, confirm, localStorage, doc, documentEvents, windowEvents, button, click, edit,
    setDetail: (value: any) => { current = value }, deferRead: (value: Promise<any>) => { readNext = value },
    post: (value: () => Promise<any>) => { result = value }, pending: () => JSON.parse(storage.get(prefix + SOURCE + ':quota-handoff') || 'null'),
    posts: () => calls.filter(c => c.method === 'POST') }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('PWA quota handoff through the displayed controls', () => {
  it('explains offer, no candidate and actual handed task without starting anything', async () => {
    const p = load(); await p.openMatter(SOURCE)
    expect(p.get('m-task-status').innerHTML).toContain('Claude Code 的额度已用完')
    expect(p.get('m-task-status').innerHTML).toContain('电脑上同一个文件夹')
    expect(p.get('m-task-status').innerHTML).toContain('交给 Codex 继续')
    p.setDetail(detail(SOURCE, { state: 'none', from: 'claude', kind: 'rate_limit', resetAt: Date.now() + 60000 })); await p.mRefresh()
    expect(p.get('m-task-status').innerHTML).toContain('请求太频繁')
    expect(p.get('m-task-status').innerHTML).toContain('目前没有可用的接手者')
    expect(p.get('m-task-status').innerHTML).not.toContain('data-handoff="confirm"')
    p.setDetail(detail(SOURCE, { state: 'handed', from: 'claude', to: 'cursor', matterId: NEXT })); await p.mRefresh()
    expect(p.get('m-task-status').innerHTML).toContain('已经交给 Cursor 继续')
    await p.click()
    expect(p.state().id).toBe(NEXT); expect(p.confirm).not.toHaveBeenCalled(); expect(p.posts()).toEqual([])
  })

  it('rechecks read-only, confirms all consequences and POSTs exactly the handoff contract', async () => {
    const p = load(); await p.openMatter(SOURCE); p.edit('这段草稿继续留在原任务')
    await p.click()
    expect(p.calls.slice(0, 3).map(c => [c.path, c.method])).toEqual([
      ['/m/api/matter?id=' + SOURCE, 'GET'], ['/m/api/matter?id=' + SOURCE, 'GET'], ['/m/api/matter/handoff', 'POST'] ])
    expect(p.posts()[0]!.body).toEqual({ id: SOURCE, providerId: 'codex', requestId: expect.stringMatching(/^[a-f0-9-]{36}$/) })
    const text = p.confirm.mock.calls[0]![0]
    for (const expected of ['额度已用完', '同一个文件夹', '原来这件留着', '看不到 Claude Code 之前的对话', '只拿到这件事的标题', '会用掉 Codex 的额度']) expect(text).toContain(expected)
    expect(p.state().id).toBe(NEXT)
    expect(JSON.parse(p.storage.get(prefix + SOURCE + ':say')!).text).toBe('这段草稿继续留在原任务')
    expect(p.calls.some(c => c.path === '/m/api/matter/create')).toBe(false)
  })

  it('cancelling the confirmation sends nothing', async () => {
    const p = load(); await p.openMatter(SOURCE); p.confirm.mockReturnValue(false); await p.click()
    expect(p.posts()).toEqual([]); expect(p.pending()).toBeNull(); expect(p.state().id).toBe(SOURCE)
  })

  it('preserves an unknown request identity; reconnect only reads and manual retry uses it once', async () => {
    const p = load(); await p.openMatter(SOURCE)
    p.post(async () => { throw Error('lost LAN reply') }); await p.click()
    const pending = p.pending(), original = p.posts()[0]!.body
    expect(pending.requestId).toBe(original.requestId); expect(pending.providerId).toBe('codex')
    expect(p.tunnel).not.toHaveBeenCalled(); expect(p.posts()).toHaveLength(1)
    p.windowEvents.online!(); await vi.advanceTimersByTimeAsync(0)
    expect(p.posts()).toHaveLength(1); expect(p.get('m-task-status').innerHTML).toContain('上次交给 Codex 继续的结果还未确认')
    p.post(async () => response({ ok: true, matterId: NEXT, created: false })); await p.click()
    expect(p.posts()).toHaveLength(2); expect(p.posts()[1]!.body).toEqual(original)
    expect(p.posts()[1]!.transport).toBe('tunnel'); expect(p.confirm).toHaveBeenCalledTimes(2)
    expect(p.state().id).toBe(NEXT)
  })

  it('restores an unknown confirmation after page reload without automatically sending', async () => {
    const saved = { requestId: UUID, providerId: 'codex', offer: offer() }, storage = new Map([[prefix + SOURCE + ':quota-handoff', JSON.stringify(saved)]])
    const p = load(storage); await p.openMatter(SOURCE)
    expect(p.posts()).toEqual([]); expect(p.get('m-task-status').innerHTML).toContain('核对并重试')
    await p.click(); expect(p.posts()[0]!.body.requestId).toBe(UUID)
  })

  it('requires a new click and confirmation if the candidate changes during the preflight read', async () => {
    const p = load(); await p.openMatter(SOURCE); p.setDetail(detail(SOURCE, offer('cursor')))
    await p.click()
    expect(p.posts()).toEqual([]); expect(p.confirm).not.toHaveBeenCalled()
    expect(p.get('m-notice').textContent).toContain('重新确认'); expect(p.get('m-task-status').innerHTML).toContain('交给 Cursor 继续')
    await p.click(); expect(p.posts()[0]!.body.providerId).toBe('cursor')
  })

  it('binds an old visible button to its own candidate instead of the latest detail', async () => {
    const p = load(); await p.openMatter(SOURCE); const old = p.button()
    p.setDetail(detail(SOURCE, offer('cursor'))); await p.mRefresh(); await p.click(old)
    expect(p.posts()).toEqual([]); expect(p.confirm).not.toHaveBeenCalled()
  })

  it('does not treat an updated estimate as a changed candidate', async () => {
    const p = load(); await p.openMatter(SOURCE); p.setDetail(detail(SOURCE, { ...offer(), resetAt: Date.now() + 900_000 }))
    await p.click(); expect(p.posts()).toHaveLength(1)
  })

  it('freezes an unknown request and its old provider until a definitive rejection allows a new confirmation', async () => {
    const storage = new Map([[prefix + SOURCE + ':quota-handoff', JSON.stringify({ requestId: UUID, providerId: 'codex', offer: offer() })]])
    const p = load(storage); p.setDetail(detail(SOURCE, offer('cursor'))); await p.openMatter(SOURCE)
    p.confirm.mockReturnValue(false); await p.click(); expect(p.pending().requestId).toBe(UUID); expect(p.posts()).toEqual([])
    p.post(async () => response({ ok: false, error: 'quota_handoff_changed' }, 409))
    p.confirm.mockReturnValue(true); await p.click()
    expect(p.posts()[0]!.body).toEqual({ id: SOURCE, providerId: 'codex', requestId: UUID })
    expect(p.confirm.mock.calls[1]![0]).toContain('原确认不会改成新的接手者'); expect(p.pending()).toBeNull()
    p.post(async () => response({ ok: true, matterId: NEXT, created: true })); await p.click()
    expect(p.posts()[1]!.body.providerId).toBe('cursor'); expect(p.posts()[1]!.body.requestId).not.toBe(UUID)
  })

  it.each(['quota_handoff_not_needed', 'workbench_busy'])('keeps an unknown confirmation visible without a current offer and checks only the original request for %s', async code => {
    const saved = { requestId: UUID, providerId: 'codex', offer: offer() }
    const p = load(new Map([[prefix + SOURCE + ':quota-handoff', JSON.stringify(saved)]])); p.setDetail(detail(SOURCE, null)); await p.openMatter(SOURCE)
    expect(p.get('m-task-status').innerHTML).toContain('核对上次交给 Codex 的结果'); expect(p.posts()).toEqual([])
    p.post(async () => response({ ok: false, error: code }, 409)); await p.click()
    expect(p.posts()[0]!.body).toEqual({ id: SOURCE, providerId: 'codex', requestId: UUID }); expect(p.pending()).toBeNull()
    expect(p.get('m-task-status').innerHTML).not.toContain('data-handoff'); expect(p.get('m-notice').textContent).toBe(p.mError(code))
  })

  it.each([null, { state: 'none', from: 'claude', kind: 'quota', resetAt: 123 }])('never starts a task when handoff is no longer offered: %j', async state => {
    const p = load(); await p.openMatter(SOURCE); p.setDetail(detail(SOURCE, state)); await p.click()
    expect(p.posts()).toEqual([]); expect(p.confirm).not.toHaveBeenCalled(); expect(p.state().id).toBe(SOURCE)
  })

  it('opens an already handed task discovered during preflight without creating or confirming again', async () => {
    const p = load(); await p.openMatter(SOURCE); p.setDetail(detail(SOURCE, { state: 'handed', from: 'claude', to: 'codex', matterId: NEXT }))
    await p.click(); expect(p.state().id).toBe(NEXT); expect(p.confirm).not.toHaveBeenCalled(); expect(p.posts()).toEqual([])
  })

  it.each([{ providerId: 'codex', offer: offer() }, { requestId: UUID, providerId: 'cursor', offer: offer() }])('does not invent a retry identity for incomplete or mismatched stored confirmation', async saved => {
    const p = load(new Map([[prefix + SOURCE + ':quota-handoff', JSON.stringify(saved)]])); await p.openMatter(SOURCE)
    expect(p.get('m-task-status').innerHTML).toContain('无法安全重试'); await p.click()
    expect(p.posts()).toEqual([]); expect(p.confirm).not.toHaveBeenCalled()
    expect(p.storage.get(prefix + SOURCE + ':quota-handoff')).toBe(JSON.stringify(saved))
  })

  it('ignores repeated clicks while either the read or the POST is in flight', async () => {
    const p = load(); await p.openMatter(SOURCE)
    const read = deferred<any>(), post = deferred<any>(); p.deferRead(read.promise); p.post(() => post.promise)
    const first = p.click(); await p.click(); read.resolve(response(detail())); await vi.advanceTimersByTimeAsync(0)
    await p.click(); expect(p.posts()).toHaveLength(1); expect(p.confirm).toHaveBeenCalledTimes(1)
    post.resolve(response({ ok: true, matterId: NEXT, created: true })); await first
    expect(p.posts()).toHaveLength(1)
  })

  it('does not send after navigating away during the read and does not repaint the new draft', async () => {
    const p = load(); await p.openMatter(SOURCE); const read = deferred<any>(); p.deferRead(read.promise)
    const first = p.click(); await p.openMatter(OTHER); p.edit('另一件事的新草稿'); p.notice('另一件事的提示')
    read.resolve(response(detail())); await first
    expect(p.posts()).toEqual([]); expect(p.confirm).not.toHaveBeenCalled(); expect(p.state().id).toBe(OTHER)
    expect(p.get('m-say').value).toBe('另一件事的新草稿'); expect(p.get('m-notice').textContent).toBe('另一件事的提示')
  })

  it.each([false, true])('a late POST never opens over another page or a returned source page (return=%j)', async back => {
    const p = load(); await p.openMatter(SOURCE); const post = deferred<any>(); p.post(() => post.promise)
    const first = p.click(); await vi.advanceTimersByTimeAsync(0); await p.openMatter(OTHER)
    if (back) await p.openMatter(SOURCE)
    p.edit('现在阅读页的新草稿'); p.notice('现在阅读页的提示')
    post.resolve(response({ ok: true, matterId: NEXT, created: true })); await first
    expect(p.state().id).toBe(back ? SOURCE : OTHER); expect(p.get('m-say').value).toBe('现在阅读页的新草稿')
    expect(p.get('m-notice').textContent).toBe('现在阅读页的提示')
  })

  it('never confirms or posts when the preflight response belongs to another task', async () => {
    const p = load(); await p.openMatter(SOURCE); p.deferRead(Promise.resolve(response(detail(OTHER))))
    await p.click(); expect(p.posts()).toEqual([]); expect(p.confirm).not.toHaveBeenCalled(); expect(p.state().detail.matter.id).toBe(SOURCE)
  })

  it('retains the exact request after a malformed success receipt', async () => {
    const p = load(); await p.openMatter(SOURCE); p.post(async () => response({ ok: true, created: true, matterId: SOURCE }))
    await p.click(); expect(p.pending().requestId).toBe(p.posts()[0]!.body.requestId); expect(p.state().id).toBe(SOURCE)
    expect(p.get('m-notice').textContent).toContain('还未确认')
  })

  it('keeps the original identity when the POST reply cannot be decoded as JSON', async () => {
    const p = load(); await p.openMatter(SOURCE)
    p.post(async () => ({ status: 200, json: async () => { throw new SyntaxError('invalid JSON') } })); await p.click()
    expect(p.pending().requestId).toBe(p.posts()[0]!.body.requestId); expect(p.pending().providerId).toBe('codex')
    expect(p.get('m-notice').textContent).toContain('还未确认')
    p.setDetail(detail(SOURCE, offer('cursor'))); await p.mRefresh()
    p.post(async () => response({ ok: false, error: 'quota_handoff_changed' }, 409)); await p.click()
    expect(p.posts()[1]!.body).toEqual(p.posts()[0]!.body)
  })

  it.each(['quota_handoff_changed', 'quota_handoff_not_needed', 'quota_handoff_unavailable', 'workbench_busy', 'provider_quota_exhausted'])('handles definitive %s without claiming a connection failure or creating a replacement', async code => {
    const p = load(); await p.openMatter(SOURCE); p.post(async () => response({ ok: false, error: code }, 409)); await p.click()
    expect(p.posts()).toHaveLength(1); expect(p.pending()).toBeNull(); expect(p.get('m-notice').textContent).toBe(p.mError(code))
    expect(p.get('m-conn').hidden).toBe(true)
  })

  it('does not POST when storage cannot preserve the confirmed identity', async () => {
    const p = load(); await p.openMatter(SOURCE); p.localStorage.setItem = () => { throw Error('full') }; await p.click()
    expect(p.posts()).toEqual([]); expect(p.get('m-notice').textContent).toContain('无法保存接手确认')
  })

  it('keeps quota and model errors explicit, with escaped optional original diagnostics', async () => {
    const p = load(); const d: any = detail(SOURCE, null)
    d.task.error = 'execution_model_unsupported'; d.events = [{ kind: 'error', text: '这个账号不能用当前模型。', diagnostic: '\n<unsafe onclick="evil()">\r\n**raw**', createdAt: 123 }]
    p.setDetail(d); await p.openMatter(SOURCE)
    const html = p.get('m-events').innerHTML
    expect(html).toContain('这个账号不能用当前模型。'); expect(html).toContain('查看原始错误')
    expect(html).toContain('&lt;unsafe onclick=&quot;evil()&quot;&gt;&#13;\n**raw**'); expect(html).not.toContain('<unsafe')
    expect(p.get('m-task-status').innerHTML).toContain('请在桌面为这件事选择账号可用的模型后继续')
    expect(p.mError('provider_quota_exhausted')).toContain('额度暂时用完'); expect(p.mError('provider_quota_exhausted')).not.toContain('检查连接')
    expect(p.mError('something_quota_like')).toContain('检查连接')
  })
})
