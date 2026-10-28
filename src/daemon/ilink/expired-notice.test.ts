import { describe, expect, it } from 'vitest'
import { expiredNoticeRecipients } from './expired-notice'

describe('账号被顶替的通知只发给主人', () => {
  it('那个账号下聊过的对话里,只挑 admin;访客拿不到「去桌面重新扫码」这种主人才看得懂的话', () => {
    const admins = new Set(['owner@im.wechat'])
    expect(expiredNoticeRecipients(['guest@im.wechat', 'owner@im.wechat', 'friend@im.wechat'], id => admins.has(id))).toEqual(['owner@im.wechat'])
  })
  it('一个 admin 都没聊过 ⇒ 谁都不发(桌面角标 + 面板仍然看得见)', () => {
    expect(expiredNoticeRecipients(['guest@im.wechat'], () => false)).toEqual([])
  })
})
