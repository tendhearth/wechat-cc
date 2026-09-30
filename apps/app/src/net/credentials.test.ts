import { describe, it, expect } from 'vitest'
import { makeCredentialStore, PAIRING_KEY, PREFS_KEY, type SecureStoreLike } from './credentials'
import type { PairingRecord } from './pairing'

function fakeSS() {
  const m = new Map<string, string>()
  const opts: unknown[] = []
  const ss: SecureStoreLike = {
    async getItemAsync(k, o) { opts.push(o); return m.get(k) ?? null },
    async setItemAsync(k, v, o) { opts.push(o); m.set(k, v) },
    async deleteItemAsync(k) { m.delete(k) },
  }
  return { ss, m, opts }
}
const REC: PairingRecord = { v: 1, daemonId: 'r' + 'a'.repeat(26), relayHost: 'relay.tendhearth.com', relayUrl: 'wss://relay.tendhearth.com/v2/phone?id=r' + 'a'.repeat(26), deviceToken: 'd' + '1'.repeat(48), deviceId: 'aa11bb22', pairedAt: 1 }

describe('credentials', () => {
  it('存取往返;选项原样传给 SecureStore', async () => {
    const f = fakeSS()
    const s = makeCredentialStore(f.ss, { keychainAccessible: 'AFTER_FIRST_UNLOCK' })
    expect(await s.load()).toBeNull()
    await s.save(REC)
    expect(await s.load()).toEqual(REC)
    expect(f.opts).toContainEqual({ keychainAccessible: 'AFTER_FIRST_UNLOCK' })
  })
  it('clear 只清配对,偏好留着', async () => {
    const f = fakeSS()
    const s = makeCredentialStore(f.ss)
    await s.save(REC); await s.savePrefs({ lang: 'zh-Hans' })
    await s.clear()
    expect(f.m.has(PAIRING_KEY)).toBe(false)
    expect(await s.loadPrefs()).toEqual({ lang: 'zh-Hans' })
  })
  it('坏数据(不是 JSON / 形状不对 / 令牌不像设备令牌)⇒ 当没有,并删掉', async () => {
    for (const raw of ['{', JSON.stringify({ ...REC, v: 2 }), JSON.stringify({ ...REC, deviceToken: 't' + '0'.repeat(32) })]) {
      const f = fakeSS(); f.m.set(PAIRING_KEY, raw)
      expect(await makeCredentialStore(f.ss).load()).toBeNull()
      expect(f.m.has(PAIRING_KEY)).toBe(false)
    }
  })
  it('偏好缺省 / 坏数据 ⇒ { lang: null }', async () => {
    const f = fakeSS()
    expect(await makeCredentialStore(f.ss).loadPrefs()).toEqual({ lang: null })
    f.m.set(PREFS_KEY, '{"lang":"fr"}')
    expect(await makeCredentialStore(f.ss).loadPrefs()).toEqual({ lang: null })
  })
})
