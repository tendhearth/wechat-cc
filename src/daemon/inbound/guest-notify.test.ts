import { describe, expect, it, vi } from 'vitest'
import { makeGuestOwnerNotify } from './guest-notify'

describe('访客申请告诉主人:经 CC 开口那道门(guest_request,blocking)', () => {
  it('交给门就算办完:说出去了 / 进了待说队列都回 {} —— mw-access 标记已通知,访客下一句不会再塞一份进队列', async () => {
    for (const said of [true, false]) {
      const tell = vi.fn(async () => said)
      const notify = makeGuestOwnerNotify({ speech: () => ({ tell }), adminChatId: () => 'owner', log: () => {} })
      expect(await notify('有人想跟 CC 说话。回「允许 12」')).toEqual({})
      expect(tell).toHaveBeenCalledWith('guest_request', 'owner', '有人想跟 CC 说话。回「允许 12」')
    }
  })
  it('没有主人 ⇒ 照旧回 no_admin_chat_configured;门没接上 ⇒ 回错误,mw-access 下一句再试', async () => {
    expect(await makeGuestOwnerNotify({ speech: () => ({ tell: async () => true }), adminChatId: () => null, log: () => {} })('x')).toEqual({ error: 'no_admin_chat_configured' })
    expect(await makeGuestOwnerNotify({ speech: () => null, adminChatId: () => 'owner', log: () => {} })('x')).toEqual({ error: 'speech_not_wired' })
  })
})
