import { describe, it, expect, vi } from 'vitest'
import type { CredentialStore } from '../net/credentials'
import type { PairingRecord } from '../net/pairing'
import { loadSession, quietly } from './session-store'

const REC: PairingRecord = { v: 1, daemonId: 'r' + 'a'.repeat(26), relayHost: 'relay.tendhearth.com', relayUrl: 'wss://relay.tendhearth.com/v2/phone?id=r' + 'a'.repeat(26), deviceToken: 'd' + '1'.repeat(48), deviceId: 'aa11bb22', pairedAt: 1 }
const store = (o: Partial<CredentialStore>): CredentialStore => ({
  load: async () => null, save: async () => {}, clear: async () => {}, loadPrefs: async () => ({ lang: null }), savePrefs: async () => {}, ...o,
})

describe('loadSession(配对与偏好各读各的)', () => {
  it('两样都读到', async () => {
    expect(await loadSession(store({ load: async () => REC, loadPrefs: async () => ({ lang: 'zh-Hans' }) }))).toEqual({ pairing: REC, lang: 'zh-Hans' })
  })
  it('只有偏好读失败 ⇒ 配对照样在(不会悄悄变成演示)', async () => {
    const log = vi.fn()
    expect(await loadSession(store({ load: async () => REC, loadPrefs: async () => { throw new Error('keychain') } }), log)).toEqual({ pairing: REC, lang: null })
    expect(log).toHaveBeenCalledWith('prefs load failed (Error)')
  })
  it('只有配对读失败 ⇒ 当没配对,偏好照样在', async () => {
    expect(await loadSession(store({ load: async () => { throw new Error('x') }, loadPrefs: async () => ({ lang: 'en' }) }), () => {})).toEqual({ pairing: null, lang: 'en' })
  })
})

describe('quietly(钥匙串写失败不抛未处理的拒绝,日志只有操作名与错误类型)', () => {
  it('拒绝被接住并记一行,不含错误文本', async () => {
    const log = vi.fn()
    const e = Object.assign(new Error('d' + '1'.repeat(48)), { code: 'ERR_KEYCHAIN' })
    quietly(Promise.reject(e), 'clear', log)
    await new Promise(r => setTimeout(r, 0))
    expect(log).toHaveBeenCalledWith('clear failed (ERR_KEYCHAIN)')
    expect(JSON.stringify(log.mock.calls)).not.toContain('d111')
  })
  it('成功不记', async () => {
    const log = vi.fn()
    quietly(Promise.resolve(), 'savePrefs', log)
    await new Promise(r => setTimeout(r, 0))
    expect(log).not.toHaveBeenCalled()
  })
})

import { clearStored, leftoverPushKey } from './session-store'

describe('撤销 / 解除配对:推送密钥一起清(spec §3「设备被撤销」、§4)', () => {
  it('两条都清;推送那条清失败只记一行、不连累配对', async () => {
    const calls: string[] = []
    const logs: string[] = []
    const store = { clear: async () => { calls.push('pairing') } } as any
    await clearStored(store, { clear: async () => { calls.push('push'); throw Object.assign(new Error('x'), { code: 'E_KEYCHAIN' }) } }, l => logs.push(l))
    expect(calls.sort()).toEqual(['pairing', 'push'])
    expect(logs).toEqual(['pushClear failed (E_KEYCHAIN)'])
  })
  it('配对那条清失败 ⇒ 抛(设置页据此提示「没能清掉」),推送那条照样清', async () => {
    const calls: string[] = []
    const store = { clear: async () => { throw new Error('nope') } } as any
    await expect(clearStored(store, { clear: async () => { calls.push('push') } }, () => {})).rejects.toThrow('nope')
    expect(calls).toEqual(['push'])
  })
  it('leftoverPushKey:会话读完、没有配对 ⇒ 该清(上次清失败 / 从老版本升级)', () => {
    expect(leftoverPushKey(true, null)).toBe(true)
    expect(leftoverPushKey(false, null)).toBe(false)
    expect(leftoverPushKey(true, { deviceId: 'ab12cd34' } as any)).toBe(false)
  })
})
