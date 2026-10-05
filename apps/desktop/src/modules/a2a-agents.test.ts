import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import {
  Window,
  type Element as TestElement,
  type HTMLFormElement as TestHTMLFormElement,
  type HTMLElement as TestHTMLElement,
  type HTMLInputElement as TestHTMLInputElement,
  type HTMLButtonElement as TestHTMLButtonElement,
  type HTMLDetailsElement as TestHTMLDetailsElement,
} from 'happy-dom'

type ApiMock = Mock<(method: string, path: string, body?: Record<string, unknown>) => Promise<unknown>>

vi.mock('../api.js', () => ({ invokeApi: vi.fn() }))

beforeEach(() => {
  // @ts-expect-error minimal getElementById stub before import
  globalThis.document = { getElementById: () => null }
  class NodeStub { static TEXT_NODE = 3 }
  // @ts-expect-error stub Node
  globalThis.Node = NodeStub
})

const { renderForageDesk, peerReach } = await import('./a2a-agents.js')
const { invokeApi } = await import('../api.js')

function fakeEl() {
  return {
    textContent: '', innerHTML: '', hidden: false, disabled: false, title: '', value: '',
    dataset: {} as Record<string, string>, childNodes: [] as any[],
    classList: {
      values: new Set<string>(),
      add(c: string) { this.values.add(c) },
      remove(c: string) { this.values.delete(c) },
      toggle(c: string, f?: boolean) { f ? this.values.add(c) : this.values.delete(c) },
      contains(c: string) { return this.values.has(c) },
    },
    setAttribute(k: string, v: string) { (this as any)[k] = v },
    appendChild(n: any) { this.childNodes.push(n); return n },
    querySelector(_selector: string): unknown { return null },
    addEventListener: vi.fn(),
    closest: (_selector: string): unknown => null,
    remove: vi.fn(),
  }
}

function installDom(extra: Record<string, any> = {}) {
  const ids = ['fd-hero-status','fd-peers','fd-peers-count','fd-inbound-toggle',
    'fd-inbound-note','fd-social-note',
    'a2a-agents-list','a2a-server-banner',
    'fd-pair-start','fd-pair-accept','fd-pair-code','fd-pair-panel','fd-pair-note','fd-pair-countdown',
    'fd-mailbox','fd-mailbox-count']
  const byId: Record<string, any> = {}
  for (const id of ids) byId[id] = fakeEl()
  Object.assign(byId, extra)
  globalThis.document = {
    getElementById: (id: string) => byId[id] ?? null,
    createElement: () => fakeEl(),
  } as unknown as typeof document
  return byId
}

describe('renderForageDesk — hero + net', () => {
  it('hero status shows agent count', () => {
    const el = installDom()
    renderForageDesk({
      agents: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], inbound: { enabled: true },
    })
    expect(el['fd-hero-status'].innerHTML).toContain('2 位')          // agents.length
  })

  it('inbound toggle reflects enabled state', () => {
    const el = installDom()
    renderForageDesk({ agents: [], inbound: { enabled: true } })
    expect(el['fd-inbound-toggle'].classList.contains('fd-on')).toBe(true)
    expect(el['fd-inbound-toggle']['aria-checked']).toBe('true')
  })

  it('inbound off → toggle not lit', () => {
    const el = installDom()
    renderForageDesk({ agents: [], inbound: { enabled: false } })
    expect(el['fd-inbound-toggle'].classList.contains('fd-on')).toBe(false)
  })

  it('peers summary derives avatars from agent names', () => {
    const el = installDom()
    renderForageDesk({ agents: [{ id: 'a', name: '老王' }, { id: 'b', name: '小李' }], inbound: null })
    expect(el['fd-peers'].innerHTML).toContain('王')
    expect(el['fd-peers-count'].textContent).toContain('连着 2 位')
  })

  it('明确 mailbox 未开启 → 引导说明，agent count still shows', () => {
    const el = installDom()
    renderForageDesk({ agents: [{ id: 'a', name: 'A' }], inbound: null, mailboxError: 'penpal_not_wired' })
    expect(el['fd-social-note'].hidden).toBe(false)
    expect(el['fd-social-note'].textContent).toContain('尚未开启')
    expect(el['fd-social-note'].textContent).toContain('你的觅食网')
    expect(el['fd-hero-status'].innerHTML).toContain('1 位')
  })
})

describe('inbound toggle', () => {
  it('POSTs the flipped state and surfaces restart-required', async () => {
    ;(invokeApi as any).mockResolvedValueOnce({ enabled: true, restart_required: true })
    const toggle = fakeEl(); const note = fakeEl()
    installDom({ 'fd-inbound-toggle': toggle, 'fd-inbound-note': note })
    const { __onInboundToggleForTest } = await import('./a2a-agents.js')
    await __onInboundToggleForTest?.()
    expect((invokeApi as any)).toHaveBeenCalledWith('POST', '/v1/social/inbound', { enabled: true })
    expect(toggle.classList.contains('fd-on')).toBe(true)
    expect(note.textContent).toContain('需重启')
  })
})

describe('配对面板', () => {
  it('start 成功 → 面板显示 6 位码 + 倒计时文本', async () => {
    const el = installDom()
    ;(invokeApi as any).mockResolvedValueOnce({ agents: [{ id: 'old', name: '旧友' }] })  // 快照
    ;(invokeApi as any).mockResolvedValueOnce({ ok: true, code: '277499', expiresAt: Date.now() + 600_000 })
    const { __onPairStartForTest, __stopPairTimersForTest } = await import('./a2a-agents.js')
    await __onPairStartForTest?.()
    __stopPairTimersForTest?.()
    expect((invokeApi as any)).toHaveBeenCalledWith('POST', '/v1/pair/start')
    expect(el['fd-pair-panel'].hidden).toBe(false)
    expect(el['fd-pair-panel'].innerHTML).toContain('277499')
    expect(el['fd-pair-panel'].innerHTML).toContain('对方在觅食页输入就能连接')
    expect(el['fd-pair-panel'].innerHTML).not.toContain('wechat-cc pair')
    expect(el['fd-pair-countdown'].textContent).toContain('有效期还剩')
  })

  it('start relay_drop_failed → 中继文案', async () => {
    const el = installDom()
    ;(invokeApi as any).mockResolvedValueOnce({ agents: [] })
    ;(invokeApi as any).mockResolvedValueOnce({ ok: false, reason: 'relay_drop_failed' })
    const { __onPairStartForTest } = await import('./a2a-agents.js')
    await __onPairStartForTest?.()
    expect(el['fd-pair-note'].textContent).toContain('中继')
  })

  it('start 503 pairing_not_wired → social enable 引导', async () => {
    const el = installDom()
    ;(invokeApi as any).mockResolvedValueOnce({ agents: [] })
    ;(invokeApi as any).mockRejectedValueOnce(new Error('pairing_not_wired'))
    const { __onPairStartForTest } = await import('./a2a-agents.js')
    await __onPairStartForTest?.()
    expect(el['fd-pair-note'].textContent).toContain('到「觅食网」区块可以启用')
  })

  it('accept 本地校验:非 6 位数字不发请求', async () => {
    const el = installDom()
    el['fd-pair-code'].value = '12ab3'
    ;(invokeApi as any).mockClear()
    const { __onPairAcceptForTest } = await import('./a2a-agents.js')
    await __onPairAcceptForTest?.()
    expect((invokeApi as any)).not.toHaveBeenCalled()
    expect(el['fd-pair-note'].textContent).toContain('6 位数字')
  })

  it('accept 成功 → 显示对方名字并清空输入', async () => {
    const el = installDom()
    el['fd-pair-code'].value = '277499'
    ;(invokeApi as any).mockResolvedValueOnce({ ok: true, peer: { self_id: 'cc-b', name: '老王的CC' } })
    ;(invokeApi as any).mockResolvedValue({})   // refresh 级联
    const { __onPairAcceptForTest } = await import('./a2a-agents.js')
    await __onPairAcceptForTest?.()
    expect((invokeApi as any)).toHaveBeenCalledWith('POST', '/v1/pair/accept', { code: '277499' })
    expect(el['fd-pair-note'].textContent).toContain('老王的CC')
    expect(el['fd-pair-note'].textContent).toMatch(/^配对成功：/)
    expect(el['fd-pair-note'].classList.contains('status-success')).toBe(true)
    expect(el['fd-pair-code'].value).toBe('')
  })

  it.each([
    ['expired_or_wrong', '码不对或已过期'],
    ['self_pair', '不能和自己'],
    ['id_conflict', '冲突'],
    ['relay_drop_failed', '中继'],
  ])('accept 失败 %s → 人话文案', async (reason, copy) => {
    const el = installDom()
    el['fd-pair-code'].value = '111111'
    ;(invokeApi as any).mockResolvedValueOnce({ ok: false, reason })
    const { __onPairAcceptForTest } = await import('./a2a-agents.js')
    await __onPairAcceptForTest?.()
    expect(el['fd-pair-note'].textContent).toContain(copy)
    expect(el['fd-pair-note'].classList.contains('status-error')).toBe(true)
  })

  it('checkPairLanded 发现新 agent → 配对成功文案 + 收起面板', async () => {
    const el = installDom()
    el['fd-pair-panel'].hidden = false
    ;(invokeApi as any).mockResolvedValueOnce({ agents: [{ id: 'old' }, { id: 'fresh', name: '小李的CC' }] })
    ;(invokeApi as any).mockResolvedValue({})   // refresh 级联
    const { __checkPairLandedForTest } = await import('./a2a-agents.js')
    await __checkPairLandedForTest?.(new Set(['old']))
    expect(el['fd-pair-note'].textContent).toContain('小李的CC')
    expect(el['fd-pair-note'].textContent).toMatch(/^配对成功：/)
    expect(el['fd-pair-note'].classList.contains('status-success')).toBe(true)
    expect(el['fd-pair-panel'].hidden).toBe(true)
  })

  it('accept 成功时清理 start 的 stale 面板/定时器（收起 fd-pair-panel）', async () => {
    const el = installDom()
    el['fd-pair-panel'].hidden = false   // 模拟：自己此前发起过配对，面板还开着、倒计时/轮询还在跑
    el['fd-pair-code'].value = '277499'
    ;(invokeApi as any).mockResolvedValueOnce({ ok: true, peer: { self_id: 'cc-b', name: '老王的CC' } })
    ;(invokeApi as any).mockResolvedValue({})   // refresh 级联
    const { __onPairAcceptForTest, __stopPairTimersForTest } = await import('./a2a-agents.js')
    await __onPairAcceptForTest?.()
    expect(el['fd-pair-panel'].hidden).toBe(true)
    __stopPairTimersForTest?.()
  })

  it('start 快照 GET 失败 → fail-closed，不发起 POST /v1/pair/start', async () => {
    const el = installDom()
    ;(invokeApi as any).mockRejectedValueOnce(new Error('network down'))  // 快照失败
    const { __onPairStartForTest } = await import('./a2a-agents.js')
    await __onPairStartForTest?.()
    const calls = (invokeApi as any).mock.calls
    expect(calls.some((c: any[]) => c[0] === 'POST' && c[1] === '/v1/pair/start')).toBe(false)
    expect(el['fd-pair-note'].textContent).toContain('稍后再试')
  })
})

describe('笔友信箱', () => {
  const chan = { id: 'ch1', title: '找修相机师傅', peer_label: '老王的CC', degree: 1, unread: 2, last_preview: '你好呀', last_at: new Date().toISOString() }

  it('信道卡渲染:标题/对端/未读角标/预览;总未读进区块头', () => {
    const el = installDom()
    renderForageDesk({ agents: [], inbound: null, mailbox: [chan, { ...chan, id: 'ch2', unread: 0, peer_label: '第2度笔友', title: '' }] })
    const html = el['fd-mailbox'].innerHTML
    expect(html).toContain('老王的CC')
    expect(html).toContain('找修相机师傅')
    expect(html).toContain('fd-mail-unread')
    expect(html).toContain('第2度笔友')
    expect(html).toContain('data-action="mail-toggle"')
    expect(el['fd-mailbox-count'].textContent).toContain('2 封未读')
  })

  it('明确未开启 → 引导;成功空数组 → 空态文案', () => {
    const el = installDom()
    renderForageDesk({ agents: [], inbound: null, mailbox: null, mailboxError: 'penpal_not_wired' })
    expect(el['fd-mailbox'].innerHTML).toContain('data-action="social-enable"')
    renderForageDesk({ agents: [], inbound: null, mailbox: [] })
    expect(el['fd-mailbox'].innerHTML).toContain('还没有笔友')
  })

  function mailCard() {
    const thread = { ...fakeEl(), hidden: true }
    const badge = fakeEl()
    const bubbles = fakeEl()
    const input = fakeEl(); const note = fakeEl()
    let html = ''
    // Mirror the browser's nested bubble container when a full thread is set.
    Object.defineProperty(thread, 'innerHTML', {
      get: () => html,
      set: (value: string) => {
        html = value
        const prefix = '<div class="fd-mail-bubbles">'
        const end = value.indexOf('</div><div class="fd-mail-replyrow">')
        if (value.startsWith(prefix) && end >= 0) bubbles.innerHTML = value.slice(prefix.length, end)
      },
    })
    const card = { ...fakeEl(), querySelector: (sel: string) =>
      sel === '.fd-mail-thread' ? thread : sel === '.fd-mail-unread' ? badge :
      sel === '.fd-mail-bubbles' ? bubbles : sel === '.fd-mail-input' ? input :
      sel === '.fd-mail-note' ? note : null }
    return { card, thread, badge, bubbles, input, note }
  }

  async function activateCard(card: any, id: string) {
    const head = fakeEl(); head.dataset.action = 'mail-toggle'; head.dataset.id = id
    head.closest = (sel: string) => sel === '.fd-mail-chan' ? card : null
    ;(invokeApi as any).mockResolvedValueOnce({ letters: [] }).mockResolvedValueOnce({ ok: true })
    const { __onMailboxActionForTest } = await import('./a2a-agents.js')
    await __onMailboxActionForTest({ target: head } as any)
  }

  it('展开线程:拉信渲染气泡、触发标已读、去掉角标', async () => {
    installDom()
    const { card, thread, badge, bubbles } = mailCard()
    const btn = fakeEl(); btn.dataset.action = 'mail-toggle'; btn.dataset.id = 'ch1'
    ;(btn as any).closest = (sel: string) => sel === '.fd-mail-chan' ? card : null
    ;(invokeApi as any).mockResolvedValueOnce({ letters: [
      { id: 'l2', direction: 'out', plaintext: '我回的', created_at: new Date().toISOString(), read_at: null },
      { id: 'l1', direction: 'in',  plaintext: '你好呀', created_at: new Date().toISOString(), read_at: null },
    ] })
    ;(invokeApi as any).mockResolvedValue({ ok: true })   // read + 后续
    const { __onMailboxActionForTest } = await import('./a2a-agents.js')
    await __onMailboxActionForTest?.({ target: btn } as any)
    expect((invokeApi as any)).toHaveBeenCalledWith('GET', '/v1/penpal/letters?channel_id=ch1')
    expect((invokeApi as any)).toHaveBeenCalledWith('POST', '/v1/penpal/letters/read', { channel_id: 'ch1' })
    expect(thread.hidden).toBe(false)
    expect(bubbles.innerHTML).toContain('你好呀')
    expect(bubbles.innerHTML).toContain('fd-out')          // 方向分侧
    expect(thread.innerHTML).toContain('data-action="mail-send"')
    expect(badge.remove).toHaveBeenCalled()
  })

  it('再点收起线程', async () => {
    installDom()
    const { card, thread } = mailCard(); thread.hidden = false; thread.innerHTML = 'x'
    const btn = fakeEl(); btn.dataset.action = 'mail-toggle'; btn.dataset.id = 'ch1'
    ;(btn as any).closest = (sel: string) => sel === '.fd-mail-chan' ? card : null
    const { __onMailboxActionForTest } = await import('./a2a-agents.js')
    await __onMailboxActionForTest?.({ target: btn } as any)
    expect(thread.hidden).toBe(true)
  })

  it('回信成功:乐观追加气泡、清输入;空文本不发请求', async () => {
    installDom()
    const { card, bubbles, input, note } = mailCard()
    const btn = fakeEl(); btn.dataset.action = 'mail-send'; btn.dataset.id = 'ch1'
    ;(btn as any).closest = (sel: string) => sel === '.fd-mail-chan' ? card : null
    await activateCard(card, btn.dataset.id)
    input.value = '  '
    ;(invokeApi as any).mockClear()
    const { __onMailboxActionForTest } = await import('./a2a-agents.js')
    await __onMailboxActionForTest?.({ target: btn } as any)
    expect((invokeApi as any)).not.toHaveBeenCalled()
    input.value = '这是一封回信'
    ;(invokeApi as any).mockResolvedValueOnce({ ok: true })
    await __onMailboxActionForTest?.({ target: btn } as any)
    expect((invokeApi as any)).toHaveBeenCalledWith('POST', '/v1/penpal/letters', { channel_id: 'ch1', text: '这是一封回信' })
    expect(bubbles.innerHTML).toContain('这是一封回信')
    expect(input.value).toBe('')
    expect(note.hidden).toBe(true)
  })

  it.each([
    ['channel_not_open', '还没打开'],
    ['no_route', '找不到'],
    ['send_failed', '联系不上'],
  ])('回信失败 %s → 人话文案,按钮恢复', async (error, copy) => {
    installDom()
    const { card, input, note } = mailCard(); input.value = 'x'
    const btn = fakeEl(); btn.dataset.action = 'mail-send'; btn.dataset.id = 'ch1'
    ;(btn as any).closest = (sel: string) => sel === '.fd-mail-chan' ? card : null
    await activateCard(card, btn.dataset.id)
    ;(invokeApi as any).mockResolvedValueOnce({ ok: false, error })
    const { __onMailboxActionForTest } = await import('./a2a-agents.js')
    await __onMailboxActionForTest?.({ target: btn } as any)
    expect(note.textContent).toContain(copy)
    expect(btn.disabled).toBe(false)
  })

  it('send_failed 带 letter_id → 同文本重按「寄出」走 resend 而非再封新信', async () => {
    installDom()
    const { card, bubbles, input, note } = mailCard()
    const btn = fakeEl(); btn.dataset.action = 'mail-send'; btn.dataset.id = 'chR'
    ;(btn as any).closest = (sel: string) => sel === '.fd-mail-chan' ? card : null
    await activateCard(card, btn.dataset.id)
    input.value = '重要的一封信'
    ;(invokeApi as any).mockClear()
    ;(invokeApi as any).mockResolvedValueOnce({ ok: false, error: 'send_failed', letter_id: 'lx1' })
    const { __onMailboxActionForTest } = await import('./a2a-agents.js')
    await __onMailboxActionForTest?.({ target: btn } as any)
    expect(note.textContent).toContain('重试同一封')
    expect(input.value).toBe('重要的一封信')             // 草稿保留
    ;(invokeApi as any).mockResolvedValueOnce({ ok: true })
    await __onMailboxActionForTest?.({ target: btn } as any)
    const calls = (invokeApi as any).mock.calls
    expect(calls[calls.length - 1]).toEqual(['POST', '/v1/penpal/letters/resend', { letter_id: 'lx1' }])
    expect(bubbles.innerHTML).toContain('重要的一封信')   // 成功后才乐观追加
    expect(input.value).toBe('')
  })

  it('失败后改了文本再寄 → 走正常 send(新信),不再 resend 旧 id', async () => {
    installDom()
    const { card, input } = mailCard()
    const btn = fakeEl(); btn.dataset.action = 'mail-send'; btn.dataset.id = 'chR2'
    ;(btn as any).closest = (sel: string) => sel === '.fd-mail-chan' ? card : null
    await activateCard(card, btn.dataset.id)
    input.value = '第一稿'
    ;(invokeApi as any).mockClear()
    ;(invokeApi as any).mockResolvedValueOnce({ ok: false, error: 'send_failed', letter_id: 'lx2' })
    const { __onMailboxActionForTest } = await import('./a2a-agents.js')
    await __onMailboxActionForTest?.({ target: btn } as any)
    input.value = '改过的第二稿'
    ;(invokeApi as any).mockResolvedValueOnce({ ok: true })
    await __onMailboxActionForTest?.({ target: btn } as any)
    const calls = (invokeApi as any).mock.calls
    expect(calls[calls.length - 1]).toEqual(['POST', '/v1/penpal/letters', { channel_id: 'chR2', text: '改过的第二稿' }])
  })

  it('点击卡头内的子元素(span,无 data-action)也能展开线程 —— closest 走一级', async () => {
    installDom()
    const { card, thread } = mailCard()
    const head = fakeEl(); head.dataset.action = 'mail-toggle'; head.dataset.id = 'ch1'
    ;(head as any).closest = (sel: string) => sel === '.fd-mail-chan' ? card : null
    const span = fakeEl()   // 真实浏览器里 e.target 是子 span:没有 dataset.action
    ;(span as any).closest = (sel: string) => sel === '[data-action]' ? head : null
    ;(invokeApi as any).mockResolvedValueOnce({ letters: [] })
    ;(invokeApi as any).mockResolvedValue({ ok: true })
    const { __onMailboxActionForTest } = await import('./a2a-agents.js')
    await __onMailboxActionForTest?.({ target: span } as any)
    expect(thread.hidden).toBe(false)
    // 清场:收起,复位模块级 openMailThreadEl
    await __onMailboxActionForTest?.({ target: head } as any)
  })

  it('线程展开期间 refresh 不重建信箱块(未寄出的草稿不被吞);收起后恢复重建', async () => {
    const el = installDom()
    const { card, thread } = mailCard()
    const btn = fakeEl(); btn.dataset.action = 'mail-toggle'; btn.dataset.id = 'ch1'
    ;(btn as any).closest = (sel: string) => sel === '.fd-mail-chan' ? card : null
    ;(invokeApi as any).mockResolvedValueOnce({ letters: [] })
    ;(invokeApi as any).mockResolvedValue({ ok: true })
    const { __onMailboxActionForTest } = await import('./a2a-agents.js')
    await __onMailboxActionForTest?.({ target: btn } as any)          // 展开
    expect(thread.hidden).toBe(false)
    el['fd-mailbox'].innerHTML = 'SENTINEL'
    renderForageDesk({ agents: [], inbound: null, mailbox: [chan] })
    expect(el['fd-mailbox'].innerHTML).toBe('SENTINEL')               // 跳过重建
    await __onMailboxActionForTest?.({ target: btn } as any)          // 收起
    renderForageDesk({ agents: [], inbound: null, mailbox: [chan] })
    expect(el['fd-mailbox'].innerHTML).toContain('fd-mail-chan')      // 恢复重建
  })
})

describe('peerReach — 伙伴卡片的可达性一行', () => {
  it('信箱对端(没有 url)显示中继而不是 "undefined"', () => {
    const line = peerReach({
      transport: 'mailbox',
      mailbox_addr: 'MCowBQYDK2VwAyEAOmw1Jrcc',
      relays: ['https://cc.tendhearth.com/mailbox'],
    })
    expect(line).not.toContain('undefined')
    expect(line).toContain('信箱')
    expect(line).toContain('cc.tendhearth.com')
  })

  it('push 对端仍显示它的 url', () => {
    expect(peerReach({ transport: 'push', url: 'http://127.0.0.1:8790' }))
      .toContain('http://127.0.0.1:8790')
  })

  it('两样都没有时说人话,不吐 undefined', () => {
    const line = peerReach({ transport: 'mailbox' })
    expect(line).not.toContain('undefined')
    expect(line.length).toBeGreaterThan(0)
  })
})

describe('refresh 的级联', () => {
  it('刷觅食台时把心愿也刷了 —— 回信是别人什么时候回就什么时候到,不刷就永远停在 0 张', async () => {
    const win = new Window()
    Object.assign(globalThis, { document: win.document, HTMLButtonElement: win.HTMLButtonElement })
    win.document.body.innerHTML = '<div id="fd-wish-list"></div><div id="fd-wish-count"></div>'
    vi.resetModules()
    const api = (await import('../api.js')).invokeApi as any
    api.mockResolvedValue({})
    const wishes = await import('./wishes.js')
    wishes.activateWishes()
    const { refresh } = await import('./a2a-agents.js')
    await refresh()
    expect(api).toHaveBeenCalledWith('GET', '/v1/social/wishes')
    wishes.deactivateWishes()
    win.happyDOM.abort()
  })
})


describe('觅食读取与信箱的页面所有权', () => {
  let win: Window
  let mod: typeof import('./a2a-agents.js')
  let call: ApiMock
  const channels = [{ id: 'alpha', peer_label: '甲的 CC' }, { id: 'beta', peer_label: '乙的 CC' }]
  const deferred = () => {
    let resolve!: (value: any) => void
    let reject!: (reason: any) => void
    const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
  }
  const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
  const mail = () => win.document.getElementById('fd-mailbox')!
  const card = (id: string) => mail().querySelector(`[data-chan-id="${id}"]`)!
  const input = (id: string) => card(id).querySelector<TestHTMLInputElement>('.fd-mail-input')!
  const act = async (id: string, action = 'mail-toggle') => {
    const target = card(id).querySelector<TestHTMLElement>(`[data-action="${action}"]`)!
    await mod.__onMailboxActionForTest({ target } as any)
  }
  const write = (id: string, text: string) => {
    input(id).value = text
    input(id).dispatchEvent(new win.Event('input', { bubbles: true }))
  }
  const success = (method: string, path: string) => {
    if (path === '/v1/a2a/list') return { agents: [{ id: 'friend', name: '朋友' }] }
    if (path === '/v1/social/inbound') return { enabled: true }
    if (path === '/v1/penpal/channels') return { channels }
    if (path.startsWith('/v1/penpal/letters?')) return { letters: [{ id: 'in1', direction: 'in', plaintext: '已有来信', created_at: new Date().toISOString() }] }
    if (path === '/v1/journal') return { items: [] }
    if (path === '/v1/social/relationships') return { relationships: [] }
    if (path === '/v1/social/wishes') return { wishes: [] }
    if (path === '/v1/a2a/info') return { enabled: true }
    return { ok: true }
  }
  beforeEach(async () => {
    vi.resetModules()
    win = new Window()
    Object.assign(globalThis, { document: win.document, Node: win.Node, HTMLElement: win.HTMLElement, HTMLButtonElement: win.HTMLButtonElement, HTMLDialogElement: win.HTMLDialogElement, KeyboardEvent: win.KeyboardEvent })
    win.document.body.innerHTML = `<section class="dash-pane" data-pane="a2a-agents">
      <div id="fd-hero-status"></div><div id="fd-social-note"></div><div id="fd-peers"></div><div id="fd-peers-count"></div>
      <button id="fd-connect-btn">连接朋友</button><section id="fd-net"><details><summary>你的觅食网</summary><button id="fd-pair-start">生成配对码</button></details></section>
      <button id="fd-inbound-toggle"></button><div id="fd-inbound-note"></div><div id="a2a-server-banner"></div><ul id="a2a-agents-list"></ul>
      <div id="fd-mailbox"></div><span id="fd-mailbox-count"></span><span id="fd-tools-sub"></span>
    </section>`
    const api = await import('../api.js')
    call = api.invokeApi as any
    call.mockReset().mockImplementation(async (method: string, path: string) => success(method, path))
    mod = await import('./a2a-agents.js')
    mod.renderForageDesk({ agents: [{ id: 'friend', name: '朋友' }], inbound: { enabled: true }, mailbox: channels })
  })
  afterEach(() => {
    mod.__stopPairTimersForTest()
    win.happyDOM.abort()
  })

  it('网络读取失败显示可重试错误，不伪装为社交关闭或零位朋友', async () => {
    call.mockImplementation(async (method: string, path: string) => {
      if (['/v1/a2a/list', '/v1/social/inbound', '/v1/penpal/channels'].includes(path)) throw new Error('network down')
      return success(method, path)
    })
    await mod.initA2AAgentsTab()
    const hero = win.document.getElementById('fd-hero-status')!
    expect(hero.textContent).not.toContain('0 位')
    expect(hero.textContent).toContain('暂时')
    expect(win.document.getElementById('fd-social-note')!.textContent).not.toContain('尚未开启')
    expect(mail().textContent).toContain('暂时')
    expect(mail().querySelector('[data-action="social-enable"]')).toBeNull()
    expect(mail().querySelector('[data-action="mailbox-retry"]')).not.toBeNull()
    call.mockImplementation(async (method: string, path: string) => success(method, path))
    mail().querySelector<TestHTMLButtonElement>('[data-action="mailbox-retry"]')!.click()
    await drain()
    expect(mail().textContent).toContain('甲的 CC')
  })

  it('响应缺少 agents / channels 数组时仍是读取错误', async () => {
    call.mockResolvedValue({})
    await mod.refresh()
    expect(win.document.getElementById('fd-hero-status')!.textContent).not.toContain('0 位')
    expect(mail().textContent).not.toContain('还没有笔友')
    expect(mail().querySelector('[data-action="mailbox-retry"]')).not.toBeNull()
  })

  it.each(['social_not_wired', 'penpal_not_wired'])('仅明确 %s 才显示开启引导', async (code) => {
    call.mockImplementation(async (method: string, path: string) => {
      if (path === '/v1/penpal/channels') throw new Error(code)
      return success(method, path)
    })
    await mod.refresh()
    expect(mail().querySelector('[data-action="social-enable"]')).not.toBeNull()
    expect(win.document.getElementById('fd-social-note')!.textContent).toContain('尚未开启')
  })

  it('线程读取失败保留已有正文和新草稿，并可在本线程重试', async () => {
    await act('alpha')
    write('alpha', '未寄出的新草稿')
    await act('alpha')
    call.mockImplementation(async (method: string, path: string) => {
      if (path.includes('letters?channel_id=alpha')) throw new Error('暂时断线')
      return success(method, path)
    })
    await act('alpha')
    expect(input('alpha').value).toBe('未寄出的新草稿')
    expect(card('alpha').textContent).toContain('已有来信')
    expect(card('alpha').querySelector('[data-action="mail-retry"]')).not.toBeNull()
    call.mockImplementation(async (method: string, path: string) => success(method, path))
    await act('alpha', 'mail-retry')
    expect(input('alpha').value).toBe('未寄出的新草稿')
    expect(card('alpha').querySelector('.fd-mail-note')!.textContent).not.toContain('看信失败')
  })

  it('缺少 letters 数组不伪装成零封信，也不标记已读', async () => {
    call.mockImplementation(async (method: string, path: string) => path.includes('letters?') ? {} : success(method, path))
    call.mockClear()
    await act('alpha')
    expect(card('alpha').textContent).toContain('看信失败')
    expect(card('alpha').textContent).not.toContain('还没有信')
    expect(call.mock.calls.some(c => c[1] === '/v1/penpal/letters/read')).toBe(false)
  })

  it('读取挂起后切到另一线程，旧读取不会写回或标已读', async () => {
    const old = deferred()
    call.mockImplementation(async (method: string, path: string) => path.includes('channel_id=alpha') ? old.promise : success(method, path))
    const reading = act('alpha')
    await act('beta')
    write('beta', '乙的新草稿')
    old.resolve({ letters: [{ id: 'late', direction: 'in', plaintext: '甲的迟到来信' }] })
    await reading
    expect(card('alpha').textContent).not.toContain('甲的迟到来信')
    expect(input('beta').value).toBe('乙的新草稿')
    expect(call.mock.calls.some(c => c[1] === '/v1/penpal/letters/read' && c[2]?.channel_id === 'alpha')).toBe(false)
  })

  it('收起、整块刷新、再打开同一线程保留草稿', async () => {
    await act('alpha')
    write('alpha', '保留这一稿')
    await act('alpha')
    await mod.refresh()
    await act('alpha')
    expect(input('alpha').value).toBe('保留这一稿')
  })

  it('首次寄信单飞，成功只清空所提交正文，不吞途中输入的新草稿', async () => {
    await act('alpha')
    write('alpha', '第一封')
    const post = deferred()
    call.mockImplementation(async (method: string, path: string) => method === 'POST' && path === '/v1/penpal/letters' ? post.promise : success(method, path))
    const sending = act('alpha', 'mail-send')
    write('alpha', '写下一封')
    const duplicate = act('alpha', 'mail-send')
    await drain()
    const sends = call.mock.calls.filter(c => c[1] === '/v1/penpal/letters').length
    post.resolve({ ok: true })
    await Promise.all([sending, duplicate])
    expect(sends).toBe(1)
    expect(input('alpha').value).toBe('写下一封')
    expect(card('alpha').querySelector('.fd-mail-bubbles')!.textContent).toContain('第一封')
    expect(card('alpha').querySelector('.fd-mail-bubbles')!.textContent).not.toContain('写下一封')
  })

  it('寄信挂起后切换并重开同一线程，迟到返回不追加、不清空新线程草稿', async () => {
    await act('alpha')
    write('alpha', '已提交的信')
    const post = deferred()
    call.mockImplementation(async (method: string, path: string) => method === 'POST' && path === '/v1/penpal/letters' ? post.promise : success(method, path))
    const sending = act('alpha', 'mail-send')
    await act('beta')
    await act('alpha')
    write('alpha', '重开后的新稿')
    expect(card('alpha').querySelector<TestHTMLButtonElement>('[data-action="mail-send"]')!.disabled).toBe(true)
    post.resolve({ ok: true })
    await sending
    expect(card('alpha').querySelector('.fd-mail-bubbles')!.textContent).not.toContain('已提交的信')
    expect(input('alpha').value).toBe('重开后的新稿')
    expect(card('alpha').querySelector<TestHTMLButtonElement>('[data-action="mail-send"]')!.disabled).toBe(false)
  })

  it('已知 send_failed 同 letter 重投也单飞，并保留途中新稿', async () => {
    await act('alpha')
    write('alpha', '重投内容')
    call.mockImplementation(async (method: string, path: string) => path === '/v1/penpal/letters' ? { ok: false, error: 'send_failed', letter_id: 'same-letter' } : success(method, path))
    await act('alpha', 'mail-send')
    const post = deferred()
    call.mockImplementation(async (method: string, path: string) => path === '/v1/penpal/letters/resend' ? post.promise : success(method, path))
    const sending = act('alpha', 'mail-send')
    const duplicate = act('alpha', 'mail-send')
    write('alpha', '新的草稿')
    await drain()
    const sends = call.mock.calls.filter(c => c[1] === '/v1/penpal/letters/resend').length
    post.resolve({ ok: true })
    await Promise.all([sending, duplicate])
    expect(sends).toBe(1)
    expect(input('alpha').value).toBe('新的草稿')
  })

  it('信箱局部读取错误不重建当前线程或清空未读计数', async () => {
    await act('alpha')
    write('alpha', '继续写')
    win.document.getElementById('fd-mailbox-count')!.textContent = '2 封未读'
    call.mockImplementation(async (method: string, path: string) => {
      if (path === '/v1/penpal/channels') throw new Error('network down')
      return success(method, path)
    })
    await mod.refresh()
    expect(input('alpha').value).toBe('继续写')
    expect(card('alpha').textContent).toContain('已有来信')
    expect(win.document.getElementById('fd-mailbox-count')!.textContent).not.toBe('')
  })

  it('离页使迟到刷新和寄信失效，返回页面后保留未提交草稿', async () => {
    await act('alpha')
    write('alpha', '提交正文')
    const post = deferred()
    call.mockImplementation(async (method: string, path: string) => method === 'POST' && path === '/v1/penpal/letters' ? post.promise : success(method, path))
    const sending = act('alpha', 'mail-send')
    write('alpha', '离页前的新稿')
    mod.deactivateA2AAgentsTab()
    post.resolve({ ok: true })
    await sending
    call.mockImplementation(async (method: string, path: string) => success(method, path))
    await mod.refresh()
    await act('alpha')
    expect(input('alpha').value).toBe('离页前的新稿')
    expect(card('alpha').querySelector('.fd-mail-bubbles')!.textContent).not.toContain('提交正文')
    const read = deferred()
    call.mockImplementation(async (method: string, path: string) => path === '/v1/a2a/list' ? read.promise : success(method, path))
    const refreshing = mod.refresh()
    mod.deactivateA2AAgentsTab()
    win.document.getElementById('fd-hero-status')!.textContent = '离页状态'
    read.resolve({ agents: [] })
    await refreshing
    expect(win.document.getElementById('fd-hero-status')!.textContent).toBe('离页状态')
  })

  it('已收起线程的旧寄信按钮不会提交另一线程之外的草稿', async () => {
    await act('alpha')
    write('alpha', '甲的草稿')
    const oldButton = card('alpha').querySelector('[data-action="mail-send"]')!
    await act('beta')
    call.mockClear()
    await mod.__onMailboxActionForTest({ target: oldButton } as any)
    expect(call.mock.calls.some(c => c[1] === '/v1/penpal/letters')).toBe(false)
    expect(input('alpha').value).toBe('甲的草稿')
  })

  it('提交正文未改就收起重开，迟到成功清理该正文而不向新线程追加', async () => {
    await act('alpha')
    write('alpha', '已经寄出的正文')
    const post = deferred()
    call.mockImplementation(async (method: string, path: string) => method === 'POST' && path === '/v1/penpal/letters' ? post.promise : success(method, path))
    const sending = act('alpha', 'mail-send')
    await act('alpha')
    await act('alpha')
    post.resolve({ ok: true })
    await sending
    expect(input('alpha').value).toBe('')
    expect(card('alpha').querySelector('.fd-mail-bubbles')!.textContent).not.toContain('已经寄出的正文')
    await act('alpha', 'mail-send')
    expect(call.mock.calls.filter(c => c[1] === '/v1/penpal/letters')).toHaveLength(1)
  })

  it('寄信成功使更早的挂起读取失效并重读，不抹掉已寄气泡或新草稿', async () => {
    await act('alpha')
    await act('alpha')
    const oldRead = deferred()
    let reads = 0
    call.mockImplementation(async (method: string, path: string) => {
      if (path.includes('letters?channel_id=alpha')) return ++reads === 1 ? oldRead.promise : {
        letters: [{ id: 'sent', direction: 'out', plaintext: '刚寄出的信', created_at: new Date().toISOString() }, { id: 'in1', direction: 'in', plaintext: '已有来信', created_at: new Date().toISOString() }],
      }
      return success(method, path)
    })
    const reading = act('alpha')
    await drain()
    write('alpha', '刚寄出的信')
    const sending = act('alpha', 'mail-send')
    write('alpha', '接着写的新稿')
    await sending
    await drain()
    oldRead.resolve({ letters: [] })
    await reading
    expect(reads).toBe(2)
    expect(card('alpha').querySelector('.fd-mail-bubbles')!.textContent).toContain('刚寄出的信')
    expect(card('alpha').querySelector('.fd-mail-bubbles')!.textContent).toContain('已有来信')
    expect(input('alpha').value).toBe('接着写的新稿')
  })

  it('首次读取挂起期间寄信成功，即使重读失败也保留已寄正文和新草稿', async () => {
    const oldRead = deferred()
    let reads = 0
    call.mockImplementation(async (method: string, path: string) => {
      if (path.includes('letters?channel_id=alpha')) {
        if (++reads === 1) return oldRead.promise
        throw new Error('短暂断线')
      }
      return success(method, path)
    })
    const reading = act('alpha')
    await drain()
    write('alpha', '已经成功寄出')
    const sending = act('alpha', 'mail-send')
    write('alpha', '新的未提交稿')
    await sending
    await drain()
    oldRead.resolve({ letters: [] })
    await reading
    expect(card('alpha').querySelector('.fd-mail-bubbles')!.textContent).toContain('已经成功寄出')
    expect(input('alpha').value).toBe('新的未提交稿')
    expect(card('alpha').querySelector('[data-action="mail-retry"]')).not.toBeNull()
  })

  it('主配对入口展开觅食网并把焦点给六位码生成按钮', async () => {
    await mod.initA2AAgentsTab()
    win.document.querySelector<TestHTMLButtonElement>('#fd-connect-btn')!.click()
    expect(win.document.querySelector<TestHTMLDetailsElement>('#fd-net>details')!.open).toBe(true)
    expect(win.document.activeElement?.id).toBe('fd-pair-start')
  })
})

describe('配对请求与页面生命周期', () => {
  let page: typeof import('./a2a-agents.js')
  let api: ApiMock
  let el: ReturnType<typeof installDom>
  let starts: number

  function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(done => { resolve = done })
    return { promise, resolve }
  }
  async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve() }
  const calls = (path: string) => api.mock.calls.filter(call => call[1] === path)

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.resetModules()
    api = (await import('../api.js')).invokeApi as unknown as ApiMock
    api.mockReset()
    starts = 0
    api.mockImplementation(async (_method, path) => {
      if (path === '/v1/a2a/list') return { agents: [{ id: 'old', name: '旧友' }] }
      if (path === '/v1/pair/start') return {
        ok: true, code: ++starts === 1 ? '111111' : '222222', expiresAt: Date.now() + 600_000,
      }
      return {}
    })
    page = await import('./a2a-agents.js')
    el = installDom()
    el['fd-pair-panel'].hidden = true
    el['fd-pair-note'].hidden = true
    el['fd-pair-accept'].textContent = '配对'
  })

  afterEach(() => {
    page.__stopPairTimersForTest()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('快照响应缺少 agents 数组时拒绝生成，避免把旧友当新配对', async () => {
    api.mockResolvedValueOnce({})
    await page.__onPairStartForTest()
    expect(calls('/v1/pair/start')).toHaveLength(0)
    expect(el['fd-pair-note'].textContent).toContain('读不到')
  })

  it('生成等待快照时重复触发只创建一次配对码', async () => {
    const snapshot = deferred<{ agents: Array<{ id: string }> }>()
    api.mockImplementation((_method, path) => path === '/v1/a2a/list'
      ? snapshot.promise : Promise.resolve({ ok: true, code: '123456', expiresAt: Date.now() + 600_000 }))
    const first = page.__onPairStartForTest()
    const duplicate = page.__onPairStartForTest()
    expect(calls('/v1/a2a/list')).toHaveLength(1)
    snapshot.resolve({ agents: [] })
    await Promise.all([first, duplicate])
    expect(calls('/v1/pair/start')).toHaveLength(1)
    expect(el['fd-pair-start'].disabled).toBe(false)
  })

  it('接受等待响应时重复触发只提交一次六位码', async () => {
    const result = deferred<{ ok: boolean, reason: string }>()
    el['fd-pair-code'].value = '123456'
    api.mockReturnValue(result.promise)
    const first = page.__onPairAcceptForTest()
    const duplicate = page.__onPairAcceptForTest()
    expect(calls('/v1/pair/accept')).toEqual([['POST', '/v1/pair/accept', { code: '123456' }]])
    result.resolve({ ok: false, reason: 'expired_or_wrong' })
    await Promise.all([first, duplicate])
    expect(el['fd-pair-accept'].disabled).toBe(false)
  })

  it('接受成功不清空等待期间输入的新配对码', async () => {
    const result = deferred<{ ok: boolean, peer: { name: string } }>()
    el['fd-pair-code'].value = '123456'
    api.mockResolvedValueOnce(result.promise)
    const pending = page.__onPairAcceptForTest()
    el['fd-pair-code'].value = '654321'
    result.resolve({ ok: true, peer: { name: '旧码朋友' } })
    await pending
    expect(el['fd-pair-code'].value).toBe('654321')
    expect(el['fd-pair-note'].textContent).toContain('旧码朋友')
  })

  it('生成切到接受后，旧生成响应不得重开面板或启动轮询', async () => {
    const result = deferred<{ ok: boolean, code: string, expiresAt: number }>()
    const normal = api.getMockImplementation()!
    api.mockImplementation((method, path, body) => path === '/v1/pair/start'
      ? result.promise : path === '/v1/pair/accept'
        ? Promise.resolve({ ok: true, peer: { name: '已接受的朋友' } }) : normal(method, path, body))
    const pending = page.__onPairStartForTest()
    await settle()
    el['fd-pair-code'].value = '654321'
    await page.__onPairAcceptForTest()
    result.resolve({ ok: true, code: '123456', expiresAt: Date.now() + 600_000 })
    await pending
    expect(el['fd-pair-panel'].hidden).toBe(true)
    expect(el['fd-pair-note'].textContent).toContain('已接受的朋友')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('接受切到生成后，旧接受成功不得关闭新面板或清空新码', async () => {
    const result = deferred<{ ok: boolean, peer: { name: string } }>()
    el['fd-pair-code'].value = '123456'
    api.mockResolvedValueOnce(result.promise)
    const pending = page.__onPairAcceptForTest()
    await page.__onPairStartForTest()
    el['fd-pair-code'].value = '654321'
    result.resolve({ ok: true, peer: { name: '迟到的朋友' } })
    await pending
    expect(el['fd-pair-panel'].hidden).toBe(false)
    expect(el['fd-pair-panel'].innerHTML).toContain('111111')
    expect(el['fd-pair-code'].value).toBe('654321')
    expect(el['fd-pair-note'].textContent).not.toContain('迟到的朋友')
  })

  it('轮询未返回时跨过多个15秒周期仍只有一个请求', async () => {
    await page.__onPairStartForTest()
    const poll = deferred<{ agents: Array<{ id: string }> }>()
    api.mockResolvedValueOnce(poll.promise)
    const before = calls('/v1/a2a/list').length
    await vi.advanceTimersByTimeAsync(45_000)
    expect(calls('/v1/a2a/list')).toHaveLength(before + 1)
    poll.resolve({ agents: [{ id: 'old' }] })
    await settle()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(calls('/v1/a2a/list')).toHaveLength(before + 2)
  })

  it('重新生成后，迟到轮询不得关闭新码面板或写配对成功', async () => {
    await page.__onPairStartForTest()
    const poll = deferred<{ agents: Array<{ id: string, name?: string }> }>()
    api.mockResolvedValueOnce(poll.promise)
    const pending = page.__checkPairLandedForTest(new Set(['old']))
    await page.__onPairStartForTest()
    poll.resolve({ agents: [{ id: 'old' }, { id: 'late', name: '迟到邻居' }] })
    await pending
    expect(el['fd-pair-panel'].hidden).toBe(false)
    expect(el['fd-pair-panel'].innerHTML).toContain('222222')
    expect(el['fd-pair-note'].textContent).not.toContain('迟到邻居')
    expect(vi.getTimerCount()).toBe(2)
  })

  it('停止计时器也作废正在读取的配对轮询', async () => {
    await page.__onPairStartForTest()
    const poll = deferred<{ agents: Array<{ id: string, name: string }> }>()
    api.mockResolvedValueOnce(poll.promise)
    const pending = page.__checkPairLandedForTest(new Set(['old']))
    page.__stopPairTimersForTest()
    poll.resolve({ agents: [{ id: 'late', name: '停后返回' }] })
    await pending
    expect(el['fd-pair-panel'].hidden).toBe(false)
    expect(el['fd-pair-note'].textContent).not.toContain('停后返回')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('离页后清理倒计时和轮询', async () => {
    await page.__onPairStartForTest()
    expect(vi.getTimerCount()).toBe(2)
    page.deactivateA2AAgentsTab()
    expect(vi.getTimerCount()).toBe(0)
    expect(el['fd-pair-panel'].hidden).toBe(true)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(calls('/v1/a2a/list')).toHaveLength(1)
  })

  it('离页后迟到的快照不得继续生成配对码', async () => {
    const snapshot = deferred<{ agents: Array<{ id: string }> }>()
    api.mockResolvedValueOnce(snapshot.promise)
    const pending = page.__onPairStartForTest()
    page.deactivateA2AAgentsTab()
    snapshot.resolve({ agents: [] })
    await pending
    expect(calls('/v1/pair/start')).toHaveLength(0)
    expect(el['fd-pair-panel'].hidden).toBe(true)
  })

  it('重进后旧finally不得解除新一轮接受的busy或覆盖新状态', async () => {
    const oldResult = deferred<{ ok: boolean, peer: { name: string } }>()
    const newResult = deferred<{ ok: boolean, reason: string }>()
    const normal = api.getMockImplementation()!
    api.mockImplementation((method, path, body) => path === '/v1/pair/accept'
      ? (body?.code === '123456' ? oldResult.promise : newResult.promise) : normal(method, path, body))
    el['fd-pair-code'].value = '123456'
    const oldPending = page.__onPairAcceptForTest()
    page.deactivateA2AAgentsTab()
    await page.refresh()
    el['fd-pair-code'].value = '654321'
    const newPending = page.__onPairAcceptForTest()
    oldResult.resolve({ ok: true, peer: { name: '上一页朋友' } })
    await oldPending
    expect(el['fd-pair-accept'].disabled).toBe(true)
    expect(el['fd-pair-accept'].textContent).toBe('配对中…')
    expect(el['fd-pair-code'].value).toBe('654321')
    expect(el['fd-pair-note'].textContent).not.toContain('上一页朋友')
    newResult.resolve({ ok: false, reason: 'expired_or_wrong' })
    await newPending
    expect(el['fd-pair-accept'].disabled).toBe(false)
  })

  it('倒计时过期后迟到轮询不得盖掉过期提示', async () => {
    await page.__onPairStartForTest()
    const poll = deferred<{ agents: Array<{ id: string, name: string }> }>()
    api.mockResolvedValueOnce(poll.promise)
    const pending = page.__checkPairLandedForTest(new Set(['old']))
    await vi.advanceTimersByTimeAsync(600_000)
    expect(el['fd-pair-note'].textContent).toContain('已过期')
    poll.resolve({ agents: [{ id: 'late', name: '过期后返回' }] })
    await pending
    expect(el['fd-pair-note'].textContent).toContain('已过期')
    expect(el['fd-pair-panel'].hidden).toBe(true)
  })
})

describe('觅食管理动作的页面、实体与弹层所有权', () => {
  let win: Window
  let page: typeof import('./a2a-agents.js')
  let call: ReturnType<typeof vi.mocked<typeof invokeApi>>
  const wait = async () => { for (let i=0;i<30;i++) await Promise.resolve() }
  const pending = () => { let resolve!: (value: unknown) => void; const promise = new Promise<unknown>(r=>{resolve=r}); return {promise,resolve} }
  const q = <T extends TestElement = TestHTMLElement>(selector: string) => win.document.querySelector<T>(selector)!
  const press = (action: string, id='alpha') => q<TestHTMLButtonElement>(`#a2a-agents-list [data-action="${action}"][data-id="${id}"]`).click()
  const basic = async (_method: string, path: string): Promise<unknown> => {
    if(path==='/v1/a2a/list')return {agents:[{id:'alpha',name:'Alpha',url:'https://a.test'},{id:'beta',name:'Beta',url:'https://b.test'}]}
    if(path==='/v1/social/inbound')return {enabled:false}
    if(path==='/v1/a2a/info')return {enabled:true,base_url:'https://home.test'}
    if(path==='/v1/penpal/channels')return {channels:[]}
    if(path==='/v1/journal')return {items:[]}
    if(path==='/v1/social/relationships')return {relationships:[]}
    if(path==='/v1/social/wishes')return {wishes:[]}
    if(path==='/v1/social/intro/offers')return {offers:[]}
    return {ok:true}
  }
  beforeEach(async()=>{
    vi.resetModules()
    win=new Window({url:'http://localhost/'})
    for(const name of ['window','document','HTMLElement','HTMLButtonElement','HTMLInputElement','HTMLFormElement','HTMLDialogElement','Node','Event'] as const)vi.stubGlobal(name,name==='window'?win:win[name])
    vi.stubGlobal('confirm',()=>true)
    ;(win.HTMLDialogElement.prototype as any).showModal=function(){this.open=true}
    ;(win.HTMLDialogElement.prototype as any).close=function(){this.open=false}
    win.document.body.innerHTML=`<article class="dash-pane" data-pane="a2a-agents"><span id="fd-hero-status"></span><span id="fd-peers-count"></span><span id="fd-peers"></span><div id="fd-social-note"></div><button id="fd-inbound-toggle"></button><div id="fd-inbound-note"></div><div id="fd-mailbox"></div><span id="fd-mailbox-count"></span><span id="fd-tools-sub"></span><div id="a2a-server-banner"></div><ul id="a2a-agents-list"></ul><button id="a2a-add-btn"></button><div id="fd-catch"></div><span id="fd-catch-count"></span><div id="fd-people"></div><span id="fd-people-count"></span></article>
      <aside id="a2a-activity-drawer" hidden><h3 id="a2a-activity-title"></h3><ul id="a2a-activity-list"></ul><button id="a2a-activity-close"></button></aside>
      <dialog id="a2a-test-modal"><h3 id="a2a-test-title"></h3><input id="a2a-test-text"><div id="a2a-test-result"></div><button id="a2a-test-inbound"></button><button id="a2a-test-outbound"></button><button id="a2a-test-close"></button><button id="a2a-test-modal-close"></button></dialog>
      <dialog id="a2a-add-modal"><form id="a2a-add-form"><input name="url"><button type="submit">预览</button></form><section id="a2a-add-preview" hidden><h4 id="a2a-preview-name"></h4><p id="a2a-preview-description"></p><ul id="a2a-preview-capabilities"></ul><input name="id"><input name="outbound_key"><button id="a2a-install-confirm"></button><button id="a2a-install-cancel"></button></section><section id="a2a-add-success" hidden><pre id="a2a-add-curl"></pre><button id="a2a-add-close"></button></section><button id="a2a-add-modal-close"></button></dialog>`
    page=await import('./a2a-agents.js')
    call=vi.mocked((await import('../api.js')).invokeApi)
    call.mockReset().mockImplementation((method,path)=>basic(method,path))
    await page.initA2AAgentsTab()
  })
  afterEach(async()=>{page.deactivateA2AAgentsTab();await win.happyDOM.abort();vi.unstubAllGlobals()})

  it.each(['pause','remove'])('离页后迟到 %s 不重新激活觅食或刷新隐藏页面',async action=>{
    const post=pending();const path=`/v1/a2a/${action}`
    call.mockImplementation((method,route)=>route===path?post.promise:basic(method,route))
    press(action);await wait();page.deactivateA2AAgentsTab();q<TestHTMLElement>('.dash-pane').hidden=true
    q('#fd-hero-status').textContent='离页后的当前状态';call.mockClear()
    post.resolve({ok:true});await wait()
    expect(call.mock.calls.some(c=>c[0]==='GET')).toBe(false)
    expect(q('#fd-hero-status').textContent).toBe('离页后的当前状态')
  })
  it('同一朋友的暂停请求未结束时只能提交一次',async()=>{
    const post=pending();call.mockImplementation((method,path)=>path==='/v1/a2a/pause'?post.promise:basic(method,path))
    press('pause');press('pause');await wait();const count=call.mock.calls.filter(c=>c[1]==='/v1/a2a/pause').length
    post.resolve({ok:true});await wait();expect(count).toBe(1)
  })
  it('入站开关的请求未结束时只能提交一次',async()=>{
    const post=pending();call.mockImplementation((method,path)=>method==='POST'&&path==='/v1/social/inbound'?post.promise:basic(method,path))
    const first=page.__onInboundToggleForTest();const second=page.__onInboundToggleForTest();await wait();const count=call.mock.calls.filter(c=>c[0]==='POST'&&c[1]==='/v1/social/inbound').length
    post.resolve({enabled:true});await Promise.all([first,second]);expect(count).toBe(1)
  })
  it('跨页的旧入站响应不能覆盖重入后读出的开关状态',async()=>{
    const post=pending();call.mockImplementation((method,path)=>method==='POST'&&path==='/v1/social/inbound'?post.promise:basic(method,path))
    const old=page.__onInboundToggleForTest();page.deactivateA2AAgentsTab();await page.refresh()
    expect(q('#fd-inbound-toggle').getAttribute('aria-checked')).toBe('false')
    post.resolve({enabled:true});await old
    expect(q('#fd-inbound-toggle').getAttribute('aria-checked')).toBe('false')
  })
  it('往来先打开甲后打开乙，甲的迟到内容不能写到乙的标题下',async()=>{
    const old=pending();call.mockImplementation((method,path)=>path.includes('/activity?agent_id=alpha')?old.promise:path.includes('/activity?agent_id=beta')?Promise.resolve({events:[{ts:'2026-10-03',direction:'in',status:'ok',text:'乙的往来'}]}):basic(method,path))
    press('activity','alpha');await wait();press('activity','beta');await wait();old.resolve({events:[{ts:'2026-10-03',direction:'in',status:'ok',text:'甲的迟到往来'}]});await wait()
    expect(q('#a2a-activity-title').textContent).toContain('beta')
    expect(q('#a2a-activity-list').textContent).toContain('乙的往来')
    expect(q('#a2a-activity-list').textContent).not.toContain('甲的迟到往来')
  })
  it('旧测试关闭重开后完成不能刷新页面或污染新朋友测试结果',async()=>{
    const old=pending();call.mockImplementation((method,path)=>path==='/v1/a2a/test'?old.promise:basic(method,path))
    press('test','alpha');q<TestHTMLButtonElement>('#a2a-test-outbound').click();await wait();q<TestHTMLButtonElement>('#a2a-test-close').click();press('test','beta');call.mockClear()
    old.resolve({ok:true,direction:'out',http_status:200});await wait()
    expect(q('#a2a-test-title').textContent).toContain('beta')
    expect(q('#a2a-test-result').textContent).toBe('')
    expect(call.mock.calls.some(c=>c[0]==='GET')).toBe(false)
  })
  it('测试请求未结束时重复点击不会再次发测试消息',async()=>{
    const old=pending();call.mockImplementation((method,path)=>path==='/v1/a2a/test'?old.promise:basic(method,path))
    press('test');q<TestHTMLButtonElement>('#a2a-test-outbound').click();q<TestHTMLButtonElement>('#a2a-test-outbound').click();await wait();const count=call.mock.calls.filter(c=>c[1]==='/v1/a2a/test').length
    old.resolve({ok:true,direction:'out'});await wait();expect(count).toBe(1)
  })
  it('关闭重开手动连接后，旧预览不能把当前朋友换成旧朋友',async()=>{
    const old=pending();call.mockImplementation((method,path,body)=>path==='/v1/a2a/preview'?(body?.url==='https://alpha.test'?old.promise:Promise.resolve({name:'Beta',description:'当前朋友',capabilities:[]})):basic(method,path))
    const preview=(url:string)=>{q<TestHTMLInputElement>('#a2a-add-form input').value=url;q<TestHTMLFormElement>('#a2a-add-form').dispatchEvent(new win.Event('submit',{bubbles:true,cancelable:true}))}
    q<TestHTMLButtonElement>('#a2a-add-btn').click();preview('https://alpha.test');await wait();q<TestHTMLButtonElement>('#a2a-add-modal-close').click();q<TestHTMLButtonElement>('#a2a-add-btn').click();preview('https://beta.test');await wait()
    old.resolve({name:'Alpha',description:'迟到旧朋友',capabilities:[]});await wait()
    expect(q('#a2a-preview-name').textContent).toBe('Beta')
    expect(q<TestHTMLInputElement>('#a2a-add-preview input[name="id"]').value).toBe('beta')
  })
  it('旧安装关闭重开后成功，不能隐藏当前朋友预览或展示旧钥匙',async()=>{
    const old=pending();call.mockImplementation((method,path,body)=>path==='/v1/a2a/preview'?Promise.resolve({name:body?.url==='https://alpha.test'?'Alpha':'Beta',description:'朋友',capabilities:[]}):path==='/v1/a2a/install'?old.promise:basic(method,path))
    const preview=async(url:string)=>{q<TestHTMLButtonElement>('#a2a-add-btn').click();q<TestHTMLInputElement>('#a2a-add-form input').value=url;q<TestHTMLFormElement>('#a2a-add-form').dispatchEvent(new win.Event('submit',{bubbles:true,cancelable:true}));await wait()}
    await preview('https://alpha.test');q<TestHTMLButtonElement>('#a2a-install-confirm').click();await wait();q<TestHTMLButtonElement>('#a2a-add-modal-close').click();await preview('https://beta.test');old.resolve({ok:true,inbound_api_key:'old-demo-key'});await wait()
    expect(q('#a2a-preview-name').textContent).toBe('Beta')
    expect(q<TestHTMLElement>('#a2a-add-preview').hidden).toBe(false)
    expect(q<TestHTMLElement>('#a2a-add-success').hidden).toBe(true)
    expect(q('#a2a-add-curl').textContent).not.toContain('old-demo-key')
  })
})
