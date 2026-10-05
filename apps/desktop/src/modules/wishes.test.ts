import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'

type Api = (method: string, path: string, body?: Record<string, unknown>) => Promise<unknown>
const { showToast, invokeApi } = vi.hoisted(() => ({ showToast: vi.fn(), invokeApi: vi.fn<Api>() }))
vi.mock('../view.js', () => ({
  escapeHtml: (value: string) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
  showToast,
}))
vi.mock('../api.js', () => ({ invokeApi }))

type Wish = { id: string, text: string, status: string, created_at: string, expires_at: string | null, sent_to: number, replies: number, postcards?: Array<Record<string, unknown>> }
type Lifecycle = { activateWishes?: () => void, deactivateWishes?: () => void }
const draft = (id = 'd1', text = '脱敏后的心愿'): Wish => ({ id, text, status: 'draft', created_at: '2026-10-03', expires_at: null, sent_to: 0, replies: 0 })
const open = (id = 'w1', text = '找搭子'): Wish => ({ ...draft(id, text), status: 'open', sent_to: 2, replies: 1 })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

async function settle() { for (let i = 0; i < 16; i++) await Promise.resolve() }
function query<T extends Element = HTMLElement>(selector: string): T {
  const found = document.querySelector(selector)
  expect(found, selector).not.toBeNull()
  return found as T
}
function calls(path: string) { return invokeApi.mock.calls.filter(call => call[1] === path) }

// The actual renderer and event handlers run against an isolated DOM and fake
// API. Every case gets a fresh module so pending reads cannot leak between cases.
describe('心愿 — 已有接口、确认与生命周期', () => {
  let win: Window
  let page: typeof import('./wishes.js')
  let lifecycle: Lifecycle = {}
  let rows: Wish[]
  let offers: Array<Record<string, unknown>>

  async function mount() {
    lifecycle.activateWishes?.()
    page.initWishes()
    await settle()
  }
  function input() { return query<HTMLInputElement>('#fd-wish-text') }
  function compose(text: string) {
    input().value = text
    query<HTMLFormElement>('#fd-wish-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  }
  function click(action: string, id?: string) {
    const selector = `[data-wsh-action="${action}"]${id ? `[data-wsh-id="${id}"]` : ''}`
    query<HTMLButtonElement>(selector).click()
  }
  function normal(method: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
    if (path === '/v1/social/wishes') return Promise.resolve({ wishes: rows })
    if (path === '/v1/social/intro/offers') return Promise.resolve({ offers })
    if (path === '/v1/social/wish') return Promise.resolve({ ok: true, id: 'created', preview: body?.text })
    void method
    return Promise.resolve({ ok: true, sent_to: 2, reply_id: 'reply1' })
  }

  beforeEach(async () => {
    win = new Window({ url: 'http://localhost/' })
    for (const name of ['window', 'document', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLFormElement', 'Node', 'Event'] as const) {
      vi.stubGlobal(name, name === 'window' ? win : win[name])
    }
    document.body.innerHTML = `<section id="fd-wish"><span id="fd-wish-count"></span>
      <form id="fd-wish-form"><label for="fd-wish-text">想请 CC 打听什么</label><input id="fd-wish-text"><button id="fd-wish-submit" type="submit">先看看怎么问</button></form>
      <div id="fd-wish-draft" hidden></div><div id="fd-wish-offers" hidden></div><div id="fd-wish-list"></div>
      </section><section id="fd-net"><details><summary>社交设置</summary></details></section>`
    rows = []
    offers = []
    invokeApi.mockReset().mockImplementation(normal)
    showToast.mockClear()
    vi.resetModules()
    page = await import('./wishes.js')
    lifecycle = page as unknown as Lifecycle
  })
  afterEach(async () => {
    lifecycle.deactivateWishes?.()
    await win.happyDOM.abort()
    vi.unstubAllGlobals()
  })

  it('只列草稿和等回音，计数只算 open，旧的心愿不上榜', async () => {
    rows = [open(), draft(), { ...open('old', '过期正文'), status: 'expired' }]
    await mount()
    expect(query('#fd-wish-list').textContent).toContain('找搭子')
    expect(query('#fd-wish-list').textContent).toContain('脱敏后的心愿')
    expect(query('#fd-wish-list').textContent).not.toContain('过期正文')
    expect(query('#fd-wish-count').textContent).toBe('1')
    expect(query('#fd-wish-list').textContent).toContain('派给 2 人 · 1 张回信')
  })

  it('空列表与未知读取分别显示空态和局部重试', async () => {
    await mount()
    expect(query('#fd-wish-list').textContent).toContain('还没有心愿')
    page.renderWishes({ wishes: null })
    expect(query('#fd-wish-list').textContent).not.toContain('社交没开')
    expect(query('#fd-wish-list [data-wsh-action="retry"]').textContent).toContain('重新读取')
  })

  it.each(['Failed to fetch', 'HTTP 500', 'HTTP 503'])('读取 %s 不冒充社交关闭，原地重试恢复', async error => {
    let failed = true
    invokeApi.mockImplementation((method, path, body) => path === '/v1/social/wishes' && failed
      ? Promise.reject(new Error(error)) : normal(method, path, body))
    await mount()
    expect(query('#fd-wish-list').textContent).not.toContain('社交没开')
    expect(query('#fd-wish-list [data-wsh-action="retry"]')).toBeTruthy()
    failed = false
    rows = [open('recovered', '读回来了')]
    click('retry')
    await settle()
    expect(query('#fd-wish-list').textContent).toContain('读回来了')
  })

  it('只有明确 social_not_wired 显示开启引导，查看设置不自动开启或派出', async () => {
    invokeApi.mockImplementation((method, path, body) => path === '/v1/social/wishes' || path === '/v1/social/intro/offers'
      ? Promise.reject(new Error('social_not_wired')) : normal(method, path, body))
    await mount()
    expect(query('#fd-wish-list').textContent).toContain('社交没开')
    click('show-network')
    expect(query<HTMLDetailsElement>('#fd-net details').open).toBe(true)
    expect(invokeApi.mock.calls.filter(call => call[0] === 'POST')).toHaveLength(0)
    expect(query<HTMLElement>('#fd-wish-offers').hidden).toBe(true)
  })

  it('介绍邀约读取失败有局部重试，不能当作没有邀约', async () => {
    invokeApi.mockImplementation((method, path, body) => path === '/v1/social/intro/offers'
      ? Promise.reject(new Error('HTTP 500')) : normal(method, path, body))
    await mount()
    expect(query<HTMLElement>('#fd-wish-offers').hidden).toBe(false)
    expect(query('#fd-wish-offers [data-wsh-action="retry"]')).toBeTruthy()
    expect(query('#fd-wish-offers').textContent).not.toContain('HTTP 500')
  })

  it('保存的草稿可继续确认，使用 GET 的脱敏 text/id，点继续确认不发送', async () => {
    rows = [draft('saved', '可公开的措辞 <安全>')]
    await mount()
    click('resume', 'saved')
    expect(query<HTMLElement>('#fd-wish-draft').hidden).toBe(false)
    expect(query('.wsh-draft-text').textContent).toBe('可公开的措辞 <安全>')
    expect(query('[data-wsh-action="send"]').getAttribute('data-wsh-id')).toBe('saved')
    expect(invokeApi.mock.calls.filter(call => call[0] === 'POST')).toHaveLength(0)
  })

  it('创建只准备确认；派必须是随后的一次明确点击', async () => {
    await mount()
    compose('原文')
    await settle()
    expect(calls('/v1/social/wish')).toEqual([['POST', '/v1/social/wish', { text: '原文' }]])
    expect(calls('/v1/social/wish/send')).toHaveLength(0)
    expect(query('.wsh-draft-text').textContent).toBe('原文')
    click('send', 'created')
    await settle()
    expect(calls('/v1/social/wish/send')).toHaveLength(1)
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('2'))
  })

  it('连续创建提交单飞，等待时按钮禁用，输入仍可编辑', async () => {
    const pending = deferred<unknown>()
    invokeApi.mockImplementation((method, path, body) => path === '/v1/social/wish' ? pending.promise : normal(method, path, body))
    await mount()
    compose('第一句')
    compose('第一句')
    await settle()
    expect(calls('/v1/social/wish')).toHaveLength(1)
    expect(query<HTMLButtonElement>('#fd-wish-submit').disabled).toBe(true)
    expect(input().disabled).toBe(false)
    pending.resolve({ ok: true, id: 'created', preview: '第一句' })
    await settle()
    expect(query<HTMLButtonElement>('#fd-wish-submit').disabled).toBe(false)
  })

  it('创建失败保留输入和已有确认卡，不暴露原始错误', async () => {
    await mount()
    page.renderWishDraft({ id: 'existing', preview: '之前确认的措辞' })
    invokeApi.mockImplementation((method, path, body) => path === '/v1/social/wish'
      ? Promise.reject(new Error('/private/internal/path')) : normal(method, path, body))
    compose('新写的原文')
    await settle()
    expect(input().value).toBe('新写的原文')
    expect(query('.wsh-draft-text').textContent).toBe('之前确认的措辞')
    expect(query('#fd-wish-draft').textContent).not.toContain('/private/internal/path')
    expect(query<HTMLButtonElement>('#fd-wish-submit').disabled).toBe(false)
  })

  it('脱敏拒绝说明保留可理解的原因与输入', async () => {
    await mount()
    invokeApi.mockImplementation((method, path, body) => path === '/v1/social/wish'
      ? Promise.resolve({ ok: false, error: 'gate_failed', violations: ['住址'] }) : normal(method, path, body))
    compose('含住址的原文')
    await settle()
    expect(input().value).toBe('含住址的原文')
    expect(query('#fd-wish-draft').textContent).toContain('住址')
  })

  it('创建迟到时保留新文字，不把上一句强行替换成当前确认卡', async () => {
    const pending = deferred<unknown>()
    invokeApi.mockImplementation((method, path, body) => path === '/v1/social/wish' ? pending.promise : normal(method, path, body))
    await mount()
    compose('上一句')
    input().value = '还没提交的新一句'
    rows = [draft('old-created', '上一句的脱敏文本')]
    pending.resolve({ ok: true, id: 'old-created', preview: '上一句的脱敏文本' })
    await settle()
    expect(input().value).toBe('还没提交的新一句')
    expect(document.querySelector('.wsh-draft-text')?.textContent).not.toBe('上一句的脱敏文本')
    expect(query('#fd-wish-list').textContent).toContain('上一句的脱敏文本')
    expect(calls('/v1/social/wish/send')).toHaveLength(0)
  })

  it('等待创建时继续确认另一份草稿，迟到创建不能替换它', async () => {
    rows = [draft('chosen', '选中的草稿')]
    const pending = deferred<unknown>()
    invokeApi.mockImplementation((method, path, body) => path === '/v1/social/wish' ? pending.promise : normal(method, path, body))
    await mount()
    compose('正在创建的句子')
    click('resume', 'chosen')
    pending.resolve({ ok: true, id: 'late', preview: '迟到措辞' })
    await settle()
    expect(query('.wsh-draft-text').textContent).toBe('选中的草稿')
  })

  it('派与取消对同一份草稿共用单飞；失败后仍可重试', async () => {
    const pending = deferred<unknown>()
    invokeApi.mockImplementation((method, path, body) => path === '/v1/social/wish/send' ? pending.promise : normal(method, path, body))
    await mount()
    page.renderWishDraft({ id: 'd1', preview: '待确认的措辞' })
    click('send', 'd1')
    click('discard', 'd1')
    await settle()
    expect(calls('/v1/social/wish/send')).toHaveLength(1)
    expect(calls('/v1/social/wish/cancel')).toHaveLength(0)
    expect([...query('#fd-wish-draft').querySelectorAll<HTMLButtonElement>('button')].every(btn => btn.disabled)).toBe(true)
    pending.resolve({ ok: false, reason: 'no_channels' })
    await settle()
    expect(query('.wsh-draft-text').textContent).toBe('待确认的措辞')
    expect(query('#fd-wish-draft').textContent).toContain('先配对')
    expect(query<HTMLButtonElement>('[data-wsh-action="send"]').disabled).toBe(false)
    invokeApi.mockImplementation(normal)
    click('send', 'd1')
    await settle()
    expect(calls('/v1/social/wish/send')).toHaveLength(2)
  })

  it('取消失败不能隐藏确认卡或吞掉输入，重试成功才收起', async () => {
    let failed = true
    invokeApi.mockImplementation((method, path, body) => path === '/v1/social/wish/cancel'
      ? Promise.resolve(failed ? { ok: false } : { ok: true }) : normal(method, path, body))
    await mount()
    page.renderWishDraft({ id: 'd1', preview: '仍未取消的措辞' })
    input().value = '新的输入'
    click('discard', 'd1')
    await settle()
    expect(query<HTMLElement>('#fd-wish-draft').hidden).toBe(false)
    expect(query('.wsh-draft-text').textContent).toBe('仍未取消的措辞')
    expect(input().value).toBe('新的输入')
    expect(query('#fd-wish-draft [role="status"]').textContent).toBeTruthy()
    failed = false
    click('discard', 'd1')
    await settle()
    expect(query<HTMLElement>('#fd-wish-draft').hidden).toBe(true)
    expect(input().value).toBe('新的输入')
  })

  it('派出成功不清空等待期间写的新文字', async () => {
    await mount()
    compose('准备派出的句子')
    await settle()
    const pending = deferred<unknown>()
    invokeApi.mockImplementation((method, path, body) => path === '/v1/social/wish/send' ? pending.promise : normal(method, path, body))
    click('send', 'created')
    input().value = '等待时的新文字'
    pending.resolve({ ok: true, sent_to: 1 })
    await settle()
    expect(input().value).toBe('等待时的新文字')
    expect(query<HTMLElement>('#fd-wish-draft').hidden).toBe(true)
  })

  it('没有输入不调用创建接口，并保留已有确认卡', async () => {
    await mount()
    page.renderWishDraft({ id: 'd1', preview: '已有措辞' })
    compose('')
    await settle()
    expect(calls('/v1/social/wish')).toHaveLength(0)
    expect(query('.wsh-draft-text').textContent).toBe('已有措辞')
  })

  it('新读取先返回后，较早的读取不能覆盖它', async () => {
    await mount()
    const old = deferred<unknown>()
    let first = true
    invokeApi.mockImplementation((method, path, body) => path === '/v1/social/wishes' && first
      ? (first = false, old.promise) : normal(method, path, body))
    const oldRead = page.refreshWishes()
    rows = [open('new', '新的列表')]
    await page.refreshWishes()
    old.resolve({ wishes: [open('old', '旧的列表')] })
    await oldRead
    expect(query('#fd-wish-list').textContent).toContain('新的列表')
    expect(query('#fd-wish-list').textContent).not.toContain('旧的列表')
  })

  it('创建成功后，先前的读取不能把现有列表变回旧的错误态', async () => {
    rows = [draft('saved', '已保存的草稿')]
    await mount()
    const old = deferred<unknown>()
    invokeApi.mockImplementation((method, path, body) => path === '/v1/social/wishes'
      ? old.promise : normal(method, path, body))
    const oldRead = page.refreshWishes()
    compose('刚准备好的句子')
    await settle()
    expect(query('.wsh-draft-text').textContent).toBe('刚准备好的句子')
    old.resolve({ error: 'social_not_wired' })
    await oldRead
    expect(query('#fd-wish-list').textContent).toContain('已保存的草稿')
    expect(query('#fd-wish-list').textContent).not.toContain('社交没开')
    expect(calls('/v1/social/wish/send')).toHaveLength(0)
  })

  it('离页重新进入后，旧读取不能覆盖当前列表', async () => {
    await mount()
    const old = deferred<unknown>()
    invokeApi.mockImplementation((method, path, body) => path === '/v1/social/wishes' ? old.promise : normal(method, path, body))
    const oldRead = page.refreshWishes()
    expect(typeof lifecycle.deactivateWishes).toBe('function')
    expect(typeof lifecycle.activateWishes).toBe('function')
    lifecycle.deactivateWishes!()
    lifecycle.activateWishes!()
    rows = [open('current', '重新进入的列表')]
    invokeApi.mockImplementation(normal)
    await page.refreshWishes()
    old.resolve({ wishes: [open('late', '离页前的列表')] })
    await oldRead
    expect(query('#fd-wish-list').textContent).toContain('重新进入的列表')
    expect(query('#fd-wish-list').textContent).not.toContain('离页前的列表')
  })

  it.each(['send', 'discard'])('旧 %s 迟到成功不能清除重新进入后的另一份确认卡或刷新新状态', async action => {
    await mount()
    page.renderWishDraft({ id: 'old', preview: '离页前的措辞' })
    const pending = deferred<unknown>()
    const path = action === 'send' ? '/v1/social/wish/send' : '/v1/social/wish/cancel'
    invokeApi.mockImplementation((method, route, body) => route === path ? pending.promise : normal(method, route, body))
    click(action, 'old')
    await settle()
    expect(typeof lifecycle.deactivateWishes).toBe('function')
    lifecycle.deactivateWishes!()
    lifecycle.activateWishes!()
    page.renderWishDraft({ id: 'current', preview: '现在确认的措辞' })
    input().value = '当前的新文字'
    const readCount = calls('/v1/social/wishes').length
    showToast.mockClear()
    pending.resolve({ ok: true, sent_to: 1 })
    await settle()
    expect(query('.wsh-draft-text').textContent).toBe('现在确认的措辞')
    expect(input().value).toBe('当前的新文字')
    expect(showToast).not.toHaveBeenCalled()
    expect(calls('/v1/social/wishes')).toHaveLength(readCount)
  })

  it('跨页仍保持创建单飞，旧结果仅解锁，随后可创建当前正文', async () => {
    await mount()
    const old = deferred<unknown>()
    let count = 0
    invokeApi.mockImplementation((method, path, body) => path === '/v1/social/wish'
      ? (++count === 1 ? old.promise : Promise.resolve({ ok: true, id: 'current', preview: body?.text })) : normal(method, path, body))
    compose('旧句子')
    await settle()
    expect(typeof lifecycle.deactivateWishes).toBe('function')
    lifecycle.deactivateWishes!()
    lifecycle.activateWishes!()
    page.renderWishDraft({ id: 'chosen', preview: '重新进入后选择的草稿' })
    compose('现在的句子')
    await settle()
    expect(calls('/v1/social/wish')).toHaveLength(1)
    expect(query<HTMLButtonElement>('#fd-wish-submit').disabled).toBe(true)
    const readCount = calls('/v1/social/wishes').length
    old.resolve({ ok: true, id: 'old', preview: '迟到旧措辞' })
    await settle()
    expect(query('.wsh-draft-text').textContent).toBe('重新进入后选择的草稿')
    expect(input().value).toBe('现在的句子')
    expect(query<HTMLButtonElement>('#fd-wish-submit').disabled).toBe(false)
    expect(calls('/v1/social/wishes')).toHaveLength(readCount)
    compose('现在的句子')
    await settle()
    expect(calls('/v1/social/wish')).toHaveLength(2)
    expect(query('.wsh-draft-text').textContent).toBe('现在的句子')
    expect(calls('/v1/social/wish/send')).toHaveLength(0)
  })

  it('介绍和待点头的已有动作、路由继续保留', async () => {
    rows = [{ ...open(), postcards: [{ reply_id: 'reply1', via_label: '阿青', preview: '朋友常去', requested: false }] }]
    offers = [{ reply_id: 'reply2', via_label: '阿青', hint: '找搭子' }]
    await mount()
    expect(query('#fd-wish-list').textContent).toContain('阿青 的朋友')
    click('intro')
    await settle()
    expect(invokeApi).toHaveBeenCalledWith('POST', '/v1/social/intro/request', { reply_id: 'reply1' })
    click('accept')
    await settle()
    expect(invokeApi).toHaveBeenCalledWith('POST', '/v1/social/intro/accept', { reply_id: 'reply2' })
    click('decline')
    await settle()
    expect(invokeApi).toHaveBeenCalledWith('POST', '/v1/social/intro/decline', { reply_id: 'reply2' })
    page.renderOffers({ offers: [] })
    expect(query<HTMLElement>('#fd-wish-offers').hidden).toBe(true)
  })

  it('已在问的介绍保留状态，没有重复认识按钮', async () => {
    rows = [{ ...open(), postcards: [{ reply_id: 'reply1', via_label: '阿青', preview: '朋友常去', requested: true }] }]
    await mount()
    expect(query('#fd-wish-list').textContent).toContain('已在问')
    expect(document.querySelector('[data-wsh-action="intro"]')).toBeNull()
  })
  it('同一正文的创建尚未结束时，离页重入不能再创建第二份草稿', async () => {
    const pending = deferred<unknown>()
    invokeApi.mockImplementation((method, path, body) => path === '/v1/social/wish' ? pending.promise : normal(method, path, body))
    await mount()
    compose('同一份正文')
    await settle()
    lifecycle.deactivateWishes!()
    lifecycle.activateWishes!()
    compose('同一份正文')
    await settle()
    pending.resolve({ ok: true, id: 'only-one', preview: '同一份正文' })
    await settle()
    expect(calls('/v1/social/wish')).toHaveLength(1)
  })

  it.each(['open', 'closed', 'cancelled', 'absent'])('派出结果未知后重新读取确认 %s，旧确认卡不能继续派或算了', async status => {
    await mount()
    compose('准备派出的句子')
    await settle()
    invokeApi.mockImplementation((method, path, body) => path === '/v1/social/wish/send'
      ? Promise.reject(new Error('response was lost')) : normal(method, path, body))
    click('send', 'created')
    await settle()
    rows = status === 'absent' ? [] : [{ ...open('created', '准备派出的句子'), status }]
    query<HTMLButtonElement>('#fd-wish-draft [data-wsh-action="retry"]').click()
    await settle()
    expect(input().value).toBe('准备派出的句子')
    expect(document.querySelector('#fd-wish-draft [data-wsh-action="send"][data-wsh-id="created"]')).toBeNull()
    expect(document.querySelector('#fd-wish-draft [data-wsh-action="discard"][data-wsh-id="created"]')).toBeNull()
  })

  it.each(['send', 'discard'])('同一确认卡的旧 %s 在离页重入后完成，重新读取不能留下已处理卡的操作', async action => {
    await mount()
    compose('原来确认的句子')
    await settle()
    const pending = deferred<unknown>()
    const path = action === 'send' ? '/v1/social/wish/send' : '/v1/social/wish/cancel'
    invokeApi.mockImplementation((method, route, body) => route === path ? pending.promise : normal(method, route, body))
    click(action, 'created')
    await settle()
    lifecycle.deactivateWishes!()
    lifecycle.activateWishes!()
    pending.resolve({ ok: true, sent_to: 1 })
    await settle()
    rows = action === 'send' ? [open('created', '原来确认的句子')] : [{ ...draft('created', '原来确认的句子'), status: 'cancelled' }]
    await page.refreshWishes()
    expect(document.querySelector('#fd-wish-draft [data-wsh-action="send"][data-wsh-id="created"]')).toBeNull()
    expect(document.querySelector('#fd-wish-draft [data-wsh-action="discard"][data-wsh-id="created"]')).toBeNull()
  })

  it('成功重读仍为草稿时保留当前确认卡和新输入', async () => {
    await mount()
    compose('准备派出的句子')
    await settle()
    input().value = '尚未提交的新文字'
    rows = [draft('created', '准备派出的句子')]
    await page.refreshWishes()
    expect(query('.wsh-draft-text').textContent).toBe('准备派出的句子')
    expect(input().value).toBe('尚未提交的新文字')
    expect(query<HTMLButtonElement>('#fd-wish-draft [data-wsh-action="send"]').disabled).toBe(false)
    expect(calls('/v1/social/wish/send')).toHaveLength(0)
  })

  it('未知读取失败不能擅自丢掉未派出的当前确认卡', async () => {
    await mount()
    compose('仍未派出的句子')
    await settle()
    invokeApi.mockImplementation((method, path, body) => path === '/v1/social/wishes'
      ? Promise.reject(new Error('offline')) : normal(method, path, body))
    await page.refreshWishes()
    expect(query('.wsh-draft-text').textContent).toBe('仍未派出的句子')
    expect(input().value).toBe('仍未派出的句子')
    expect(query<HTMLButtonElement>('#fd-wish-draft [data-wsh-action="send"]').disabled).toBe(false)
  })

})
