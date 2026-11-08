import { describe, expect, it } from 'vitest'
import { makeOwnerPresence, PRESENT_IDLE_S } from './owner-presence'

describe('owner-presence(S3b)', () => {
  it('空闲不足阈值 ⇒ 在电脑前;够了 ⇒ 不在;探不到 / 探针抛 ⇒ 当作不在', async () => {
    expect(await makeOwnerPresence({ machineIdle: async () => PRESENT_IDLE_S - 1 }).atDesk()).toBe(true)
    expect(await makeOwnerPresence({ machineIdle: async () => PRESENT_IDLE_S }).atDesk()).toBe(false)
    expect(await makeOwnerPresence({ machineIdle: async () => null }).atDesk()).toBe(false)
    expect(await makeOwnerPresence({ machineIdle: async () => { throw new Error('ioreg') } }).atDesk()).toBe(false)
  })
})
