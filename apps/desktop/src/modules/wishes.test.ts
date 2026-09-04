import { describe, expect, it, vi, beforeEach } from 'vitest'

const showToast = vi.fn()
const invokeApi = vi.fn()
vi.mock('../view.js', () => ({ escapeHtml: (s: string) => String(s), showToast: (m: string) => showToast(m) }))
vi.mock('../api.js', () => ({ invokeApi: (...a: unknown[]) => invokeApi(...a) }))

const els = new Map<string, { innerHTML: string; textContent: string; value: string; hidden: boolean; addEventListener: () => void }>()
const mkEl = () => ({ innerHTML: '', textContent: '', value: '', hidden: false, addEventListener: () => {} })
// @ts-expect-error minimal DOM stub before import (same shape as journal.test.ts)
globalThis.document = { getElementById: (id: string) => els.get(id) ?? null }

const { renderWishes, onWishCompose, onWishAction } = await import('./wishes.js')

describe('心愿区块', () => {
  beforeEach(() => { for (const id of ['fd-wish-count', 'fd-wish-draft', 'fd-wish-list', 'fd-wish-text']) els.set(id, mkEl()); invokeApi.mockReset() })

  it('renderWishes:每条有状态字、派给几人、几张回信;计数 = open 条数;null → 不可用文案', () => {
    renderWishes({ wishes: [
      { id: 'a1', text: '找搭子', status: 'open', created_at: 'c', expires_at: 'e', sent_to: 2, replies: 1 },
      { id: 'b2', text: '旧的', status: 'expired', created_at: 'c', expires_at: 'e', sent_to: 1, replies: 0 },
    ] })
    const html = els.get('fd-wish-list')!.innerHTML
    expect(html).toContain('找搭子'); expect(html).toContain('等回音'); expect(html).toContain('派给 2 人 · 1 张回信'); expect(html).toContain('过期')
    expect(html).toContain('data-wsh-action="cancel" data-wsh-id="a1"'); expect(html).not.toContain('data-wsh-id="b2"')
    expect(els.get('fd-wish-count')!.textContent).toBe('1')
    renderWishes({ wishes: null })
    expect(els.get('fd-wish-list')!.innerHTML).toContain('社交没开')
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
