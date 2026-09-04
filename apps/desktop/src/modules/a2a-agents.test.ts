import { describe, it, expect, vi, beforeEach } from 'vitest'

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
    querySelector() { return null },
    addEventListener: vi.fn(),
    closest: () => null,
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

  it('mailbox unwired (null) → 未启用 note, agent count still shows', () => {
    const el = installDom()
    renderForageDesk({ agents: [{ id: 'a', name: 'A' }], inbound: null })
    expect(el['fd-social-note'].hidden).toBe(false)
    expect(el['fd-social-note'].textContent).toContain('未启用')
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
    expect(el['fd-pair-panel'].innerHTML).toContain('wechat-cc pair 277499')
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
  })

  it('checkPairLanded 发现新 agent → 配对成功文案 + 收起面板', async () => {
    const el = installDom()
    el['fd-pair-panel'].hidden = false
    ;(invokeApi as any).mockResolvedValueOnce({ agents: [{ id: 'old' }, { id: 'fresh', name: '小李的CC' }] })
    ;(invokeApi as any).mockResolvedValue({})   // refresh 级联
    const { __checkPairLandedForTest } = await import('./a2a-agents.js')
    await __checkPairLandedForTest?.(new Set(['old']))
    expect(el['fd-pair-note'].textContent).toContain('小李的CC')
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

  it('mailbox:null → 未启用引导;[] → 空态文案', () => {
    const el = installDom()
    renderForageDesk({ agents: [], inbound: null, mailbox: null })
    expect(el['fd-mailbox'].innerHTML).toContain('data-action="social-enable"')
    renderForageDesk({ agents: [], inbound: null, mailbox: [] })
    expect(el['fd-mailbox'].innerHTML).toContain('还没有笔友')
  })

  function mailCard() {
    const thread = { ...fakeEl(), hidden: true }
    const badge = fakeEl()
    const bubbles = fakeEl()
    const input = fakeEl(); const note = fakeEl()
    const card = { ...fakeEl(), querySelector: (sel: string) =>
      sel === '.fd-mail-thread' ? thread : sel === '.fd-mail-unread' ? badge :
      sel === '.fd-mail-bubbles' ? bubbles : sel === '.fd-mail-input' ? input :
      sel === '.fd-mail-note' ? note : null }
    return { card, thread, badge, bubbles, input, note }
  }

  it('展开线程:拉信渲染气泡、触发标已读、去掉角标', async () => {
    installDom()
    const { card, thread, badge } = mailCard()
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
    expect(thread.innerHTML).toContain('你好呀')
    expect(thread.innerHTML).toContain('fd-out')          // 方向分侧
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
