import { describe, expect, it, vi } from 'vitest'

import { runApprove } from './approve'
import { fakeState, memoryStore } from './pipeline.fixture'
import type { SelfChangeState } from './state'

function storeWith(over: Partial<SelfChangeState> = {}) {
  const s = fakeState({
    step: 'approval',
    result: null,
    approval: { hash: 'deadbeefcafe', code: '07', decision: 'pending', askedAt: 1, delivered: false },
    ...over,
  })
  return { store: memoryStore([s]), id: s.id }
}

describe('runApprove', () => {
  it('停在 approval 且还活着 ⇒ 拍下去,话里说「放行 / 拒绝」不说 allow / deny', async () => {
    for (const [decision, word] of [['allow', '放行'], ['deny', '拒绝']] as const) {
      const { store, id } = storeWith()
      const resolve = vi.fn(async () => true)
      const r = await runApprove(store, { resolve }, id, decision)
      expect(r).toEqual({ ok: true, code: 'resolved', message: `已拍板:${word}(hash deadbeef)` })
      // 桌面那张权限卡同一个 consume —— 拍的是存盘里的那个 hash。
      expect(resolve).toHaveBeenCalledWith('deadbeefcafe', decision)
    }
  })

  it('没有这条 ⇒ self_change_not_found,一个请求都不发', async () => {
    const { store } = storeWith()
    const resolve = vi.fn(async () => true)
    const r = await runApprove(store, { resolve }, '不存在', 'allow')
    expect(r).toMatchObject({ ok: false, code: 'self_change_not_found' })
    expect(r.message).toContain('--list')
    expect(resolve).not.toHaveBeenCalled()
  })

  // 已经收场的那条也得说人话:「hash 过期或已被拍过」是对的,但没用 ——
  // 人想知道的是「这条早就完了」。
  it('已经收场 ⇒ self_change_settled,带上原来的结局,不去够 daemon', async () => {
    const { store, id } = storeWith({ result: 'approval_timeout' })
    const resolve = vi.fn(async () => true)
    const r = await runApprove(store, { resolve }, id, 'allow')
    expect(r).toMatchObject({ ok: false, code: 'self_change_settled' })
    expect(r.message).toContain('approval_timeout')
    expect(resolve).not.toHaveBeenCalled()
  })

  it('还活着但不在等拍板(或者压根没开过卡)⇒ self_change_not_awaiting', async () => {
    const resolve = vi.fn(async () => true)
    const running = storeWith({ step: 'tests' })
    const a = await runApprove(running.store, { resolve }, running.id, 'allow')
    expect(a).toMatchObject({ ok: false, code: 'self_change_not_awaiting' })
    expect(a.message).toContain('tests')

    // step 是 approval 但 hash 还没落盘(卡还没开出来)—— 同样拍不了。
    const noHash = storeWith({ approval: { hash: null, code: null, decision: null, askedAt: null, delivered: null } })
    expect(await runApprove(noHash.store, { resolve }, noHash.id, 'allow')).toMatchObject({ ok: false, code: 'self_change_not_awaiting' })
    expect(resolve).not.toHaveBeenCalled()
  })

  it('daemon 那边条目已经没了(超时扫走 / 微信先拍了)⇒ self_change_resolve_failed', async () => {
    const { store, id } = storeWith()
    const r = await runApprove(store, { resolve: async () => false }, id, 'deny')
    expect(r).toEqual({ ok: false, code: 'self_change_resolve_failed', message: '拍板没成功:hash 过期或已被拍过' })
  })
})
