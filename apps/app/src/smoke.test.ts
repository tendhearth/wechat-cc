import { describe, it, expect } from 'vitest'
import { HomeTopic } from '@wechat-cc/protocol'
describe('app 工程', () => {
  it('能用协议包', () => { expect(HomeTopic.safeParse({ unread: 0, presenceState: null, nextCursor: null }).success).toBe(true) })
})
