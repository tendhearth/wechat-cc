import { describe, expect, it, vi, beforeEach } from 'vitest'

const showToast = vi.fn()
const invokeApi = vi.fn()
vi.mock('../view.js', () => ({ escapeHtml: (s: string) => String(s), showToast: (m: string) => showToast(m) }))
vi.mock('../api.js', () => ({ invokeApi: (...a: unknown[]) => invokeApi(...a) }))

const els = new Map<string, { innerHTML: string; textContent: string; value: string; hidden: boolean; addEventListener: () => void }>()
const mkEl = () => ({ innerHTML: '', textContent: '', value: '', hidden: false, addEventListener: () => {} })
// @ts-expect-error minimal DOM stub before import (same shape as journal.test.ts)
globalThis.document = { getElementById: (id: string) => els.get(id) ?? null }

const { renderWishes, renderOffers, onWishCompose, onWishAction } = await import('./wishes.js')

describe('心愿区块', () => {
  beforeEach(() => { for (const id of ['fd-wish-count', 'fd-wish-draft', 'fd-wish-list', 'fd-wish-text']) els.set(id, mkEl()); invokeApi.mockReset() })

  it('renderWishes:只列开着的(草稿 / 等回音),往事不上榜;计数 = open 条数;null → 不可用文案', () => {
    renderWishes({ wishes: [
      { id: 'a1', text: '找搭子', status: 'open', created_at: 'c', expires_at: 'e', sent_to: 2, replies: 1 },
      { id: 'c3', text: '还没派的', status: 'draft', created_at: 'c', expires_at: null, sent_to: 0, replies: 0 },
      { id: 'b2', text: '旧的', status: 'expired', created_at: 'c', expires_at: 'e', sent_to: 1, replies: 0 },
    ] })
    const html = els.get('fd-wish-list')!.innerHTML
    expect(html).toContain('找搭子'); expect(html).toContain('等回音'); expect(html).toContain('派给 2 人 · 1 张回信')
    expect(html).toContain('data-wsh-action="cancel" data-wsh-id="a1"')
    expect(html).toContain('data-wsh-id="c3"')       // 草稿也算开着的
    expect(html).not.toContain('旧的'); expect(html).not.toContain('过期')   // 过期的不再渲染
    expect(els.get('fd-wish-count')!.textContent).toBe('1')
    renderWishes({ wishes: null })
    expect(els.get('fd-wish-list')!.innerHTML).toContain('社交没开')
  })

  it('全是往事(没有草稿也没有等回音)→ 和一条没有一样,给「写一句」的空文案', () => {
    renderWishes({ wishes: [{ id: 'b2', text: '旧的', status: 'closed', created_at: 'c', expires_at: 'e', sent_to: 1, replies: 1 }] })
    expect(els.get('fd-wish-list')!.innerHTML).toContain('还没有心愿')
    expect(els.get('fd-wish-count')!.textContent).toBe('0')
  })

  it('compose:过门 → 草稿显示 preview + 派/算了;不过门 → 显示不能说的', async () => {
    invokeApi.mockResolvedValueOnce({ ok: true, id: 'a1', preview: '找搭子' })
    els.get('fd-wish-text')!.value = '找搭子'
    await onWishCompose({ preventDefault() {} })
    expect(invokeApi).toHaveBeenCalledWith('POST', '/v1/social/wish', { text: '找搭子' })
    expect(els.get('fd-wish-draft')!.innerHTML).toContain('data-wsh-action="send" data-wsh-id="a1"')
    invokeApi.mockResolvedValueOnce({ ok: false, error: 'gate_failed', violations: ['住址'] })
    await onWishCompose({ preventDefault() {} })
    expect(els.get('fd-wish-draft')!.innerHTML).toContain('住址')
  })

  it('send / discard / cancel 各打对路由;no_channels 有提示', async () => {
    invokeApi.mockResolvedValueOnce({ ok: true, sent_to: 2 }).mockResolvedValueOnce({ wishes: [] })
    await onWishAction({ target: { closest: () => ({ getAttribute: (k: string) => (k === 'data-wsh-action' ? 'send' : 'a1') }) } })
    expect(invokeApi).toHaveBeenCalledWith('POST', '/v1/social/wish/send', { id: 'a1' })
    invokeApi.mockResolvedValueOnce({ ok: false, reason: 'no_channels' })
    await onWishAction({ target: { closest: () => ({ getAttribute: (k: string) => (k === 'data-wsh-action' ? 'send' : 'a1') }) } })
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('先配对'))
    invokeApi.mockResolvedValueOnce({ ok: true, status: 'cancelled' }).mockResolvedValueOnce({ wishes: [] })
    await onWishAction({ target: { closest: () => ({ getAttribute: (k: string) => (k === 'data-wsh-action' ? 'cancel' : 'a1') }) } })
    expect(invokeApi).toHaveBeenCalledWith('POST', '/v1/social/wish/cancel', { id: 'a1' })
  })
})

describe('介绍:想认识 TA / 待你点头', () => {
  beforeEach(() => { for (const id of ['fd-wish-count', 'fd-wish-draft', 'fd-wish-list', 'fd-wish-text', 'fd-wish-offers']) els.set(id, mkEl()); invokeApi.mockReset() })
  const wishWithPostcards = (requested = false) => ({ wishes: [{ id: 'w1', text: '找搭子', status: 'open', created_at: 'c', expires_at: 'e', sent_to: 1, replies: 1,
    postcards: [{ reply_id: 'ab12cd34', via_label: '阿A', preview: '我朋友常去', at: 't', requested }] }] })
  it('心愿下列出 hop 2 明信片:「阿A 的朋友」+ 预览 + 想认识按钮;requested 时显示「已在问」且没有按钮', () => {
    renderWishes(wishWithPostcards())
    const html = els.get('fd-wish-list')!.innerHTML
    expect(html).toContain('阿A 的朋友'); expect(html).toContain('我朋友常去')
    expect(html).toContain('data-wsh-action="intro" data-wsh-reply="ab12cd34"')
    renderWishes(wishWithPostcards(true))
    const html2 = els.get('fd-wish-list')!.innerHTML
    expect(html2).toContain('已在问'); expect(html2).not.toContain('data-wsh-action="intro"')
  })
  it('renderOffers:每条邀约有 同意 / 不了;空 → 区块隐藏', () => {
    renderOffers({ offers: [{ reply_id: 'ab12cd34', hint: '找搭子', via_label: '阿A', at: 't' }] })
    const box = els.get('fd-wish-offers')!
    expect(box.hidden).toBe(false)
    expect(box.innerHTML).toContain('阿A 的朋友'); expect(box.innerHTML).toContain('找搭子')
    expect(box.innerHTML).toContain('data-wsh-action="accept" data-wsh-reply="ab12cd34"')
    expect(box.innerHTML).toContain('data-wsh-action="decline" data-wsh-reply="ab12cd34"')
    renderOffers({ offers: [] })
    expect(box.hidden).toBe(true)
  })
  it('三个动作打对路由并 toast', async () => {
    const click = (action: string) => onWishAction({ target: { closest: () => ({ getAttribute: (k: string) => (k === 'data-wsh-action' ? action : k === 'data-wsh-reply' ? 'ab12cd34' : null) }) } })
    invokeApi.mockResolvedValueOnce({ ok: true, reply_id: 'ab12cd34' }).mockResolvedValue({ wishes: [], offers: [] })
    await click('intro')
    expect(invokeApi).toHaveBeenCalledWith('POST', '/v1/social/intro/request', { reply_id: 'ab12cd34' })
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('托'))
    invokeApi.mockReset(); invokeApi.mockResolvedValueOnce({ ok: false, reason: 'already_requested' }).mockResolvedValue({ wishes: [], offers: [] })
    await click('intro'); expect(showToast).toHaveBeenLastCalledWith(expect.stringContaining('已经在问'))
    invokeApi.mockReset(); invokeApi.mockResolvedValueOnce({ ok: true, reply_id: 'ab12cd34' }).mockResolvedValue({ wishes: [], offers: [] })
    await click('accept'); expect(invokeApi).toHaveBeenCalledWith('POST', '/v1/social/intro/accept', { reply_id: 'ab12cd34' })
    invokeApi.mockReset(); invokeApi.mockResolvedValueOnce({ ok: true, reply_id: 'ab12cd34' }).mockResolvedValue({ wishes: [], offers: [] })
    await click('decline'); expect(invokeApi).toHaveBeenCalledWith('POST', '/v1/social/intro/decline', { reply_id: 'ab12cd34' })
  })
})
