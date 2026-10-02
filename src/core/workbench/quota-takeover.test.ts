import { describe, it, expect } from 'vitest'
import { QUOTA_TAKEOVER_DEFAULT_REQUEST, quotaTakeoverText } from './quota-takeover'

describe('quotaTakeoverText(微信与手机共用的接管正文)', () => {
  it('说清从谁接手、为什么、哪件事、主人的要求', () => {
    expect(quotaTakeoverText('codex', '修登录页', '再加一列')).toBe('接替 Codex（额度用完）继续这件事：修登录页\n主人刚才的要求：再加一列')
  })
  it('没有新要求时用默认那句', () => {
    expect(quotaTakeoverText('claude', 'T', QUOTA_TAKEOVER_DEFAULT_REQUEST)).toContain('接着原来的要求做。')
  })
})
