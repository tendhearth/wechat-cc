import { describe, it, expect } from 'vitest'
import { PAIRING_KEY } from '../net/credentials'
import { PUSH_REG_ITEM } from '../push/key-store'
import { memSecureStore } from '../push/mem-secure-store'
import { E2E_STASH_KEY, e2eOp, restorePairing, stashPairing, stashStatus } from './e2e-stash'

const OPTS = {} // 内存桩只认 keychainService;真钥匙串的选项由 dev-e2e 页传
const OWNER = JSON.stringify({ v: 1, deviceToken: 'd' + 'a'.repeat(48), deviceId: '47e03ec0' })
const TEST = JSON.stringify({ v: 1, deviceToken: 'd' + 'b'.repeat(48), deviceId: 'aaaaaaaa' })

describe('真机验收:主人的配对先收起来、测完放回去', () => {
  it('收:配对搬进收纳格,配对清空;放:原样搬回,删推送登记指纹与收纳格', async () => {
    const { ss, m } = memSecureStore()
    await ss.setItemAsync(PAIRING_KEY, OWNER, OPTS)
    await ss.setItemAsync(PUSH_REG_ITEM, '{"fp":"x","at":1}', OPTS)
    expect(await stashPairing(ss, OPTS)).toBe('stashed')
    expect(await ss.getItemAsync(PAIRING_KEY, OPTS)).toBeNull()
    expect(await ss.getItemAsync(E2E_STASH_KEY, OPTS)).toBe(OWNER)
    expect(await stashStatus(ss, OPTS)).toBe('stash-only')
    // 测试设备配上(app 当没配过),再被撤销清掉 —— 放回去之前可能还在,也可能已经清了
    await ss.setItemAsync(PAIRING_KEY, TEST, OPTS)
    expect(await stashStatus(ss, OPTS)).toBe('stash-and-pairing')
    expect(await restorePairing(ss, OPTS)).toBe('restored')
    expect(await ss.getItemAsync(PAIRING_KEY, OPTS)).toBe(OWNER)
    expect(await ss.getItemAsync(PUSH_REG_ITEM, OPTS)).toBeNull()
    expect(await ss.getItemAsync(E2E_STASH_KEY, OPTS)).toBeNull()
    expect([...m.values()]).toEqual([OWNER])
  })
  it('已经收着一份(上一轮中途挂了)⇒ 不再收,免得测试设备顶掉主人的那份', async () => {
    const { ss } = memSecureStore()
    await ss.setItemAsync(E2E_STASH_KEY, OWNER, OPTS)
    await ss.setItemAsync(PAIRING_KEY, TEST, OPTS)
    expect(await stashPairing(ss, OPTS)).toBe('already_stashed')
    expect(await ss.getItemAsync(E2E_STASH_KEY, OPTS)).toBe(OWNER)
    expect(await ss.getItemAsync(PAIRING_KEY, OPTS)).toBe(TEST)
  })
  it('没配对 ⇒ 收什么都不做;没收纳格 ⇒ 放什么都不做(配对不动)', async () => {
    const { ss } = memSecureStore()
    expect(await stashPairing(ss, OPTS)).toBe('nothing')
    expect(await stashStatus(ss, OPTS)).toBe('empty')
    await ss.setItemAsync(PAIRING_KEY, TEST, OPTS)
    expect(await restorePairing(ss, OPTS)).toBe('nothing')
    expect(await ss.getItemAsync(PAIRING_KEY, OPTS)).toBe(TEST)
    expect(await stashStatus(ss, OPTS)).toBe('pairing-only')
  })
  it('收纳格写进去读回来不一致 ⇒ 抛,配对原样留着', async () => {
    const { ss } = memSecureStore()
    await ss.setItemAsync(PAIRING_KEY, OWNER, OPTS)
    ss.setItemAsync.mockImplementationOnce(async () => { /* 写丢了 */ })
    await expect(stashPairing(ss, OPTS)).rejects.toThrow('stash_verify_failed')
    expect(await ss.getItemAsync(PAIRING_KEY, OPTS)).toBe(OWNER)
  })
  it('op 只认三个', () => {
    expect(e2eOp('stash')).toBe('stash')
    expect(e2eOp('restore')).toBe('restore')
    expect(e2eOp('status')).toBe('status')
    expect(e2eOp('wipe')).toBeNull()
    expect(e2eOp(undefined)).toBeNull()
  })
})
