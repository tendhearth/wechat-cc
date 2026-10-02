import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { b64uEncode, derivePushKey } from '@wechat-cc/protocol'
import { makePushKeyStore, pushKeyRecord, isDevPushToken, PUSH_KEY_ITEM, PUSH_KEY_SERVICE, PUSH_REG_ITEM } from './key-store'
import { memSecureStore } from './mem-secure-store'

const TOKEN = 'd' + 'ab'.repeat(24)
const SHARED = { keychainService: PUSH_KEY_SERVICE, accessGroup: 'TEAM.com.tendhearth.app.shared' }

describe('推送密钥记录(扩展 / 服务只拿到它,拿不到设备令牌)', () => {
  it('键名 / service 与原生端约定一致', () => {
    expect([PUSH_KEY_ITEM, PUSH_KEY_SERVICE, PUSH_REG_ITEM]).toEqual(['tendhearth.pushkey.v1', 'tendhearth.push', 'tendhearth.pushreg.v1'])
  })
  it('pushKeyRecord:key = base64url(derivePushKey(设备令牌)),lang 原样', () => {
    expect(pushKeyRecord(TOKEN, 'zh-Hans')).toEqual({ v: 1, key: b64uEncode(derivePushKey(TOKEN)), lang: 'zh-Hans' })
  })
  it('序列化格式固定为 {"v":1,"key":…,"lang":…}(原生端按它解析)', () => {
    const r = pushKeyRecord(TOKEN, null)
    expect(JSON.stringify(r)).toBe(`{"v":1,"key":"${r.key}","lang":null}`)
    expect(r.key).toMatch(/^[A-Za-z0-9_-]{43}$/)   // 32 字节、无填充
  })
  it('与协议包回归向量一致', () => {
    const v = JSON.parse(readFileSync(new URL('../../../../packages/protocol/vectors/push.json', import.meta.url), 'utf8'))
    expect(pushKeyRecord(v.deviceToken, null).key).toBe(v.key)
  })
  it('ensure 只写进共享那组选项;内容没变不重写;语言变了才重写', async () => {
    const { m, ss } = memSecureStore()
    const s = makePushKeyStore(ss, { shared: SHARED, local: {} })
    await s.ensure(TOKEN, null)
    await s.ensure(TOKEN, null)
    expect(ss.setItemAsync).toHaveBeenCalledTimes(1)
    expect(ss.setItemAsync.mock.calls[0]![0]).toBe(PUSH_KEY_ITEM)
    expect(ss.setItemAsync.mock.calls[0]![2]).toEqual(SHARED)
    expect(JSON.parse(m.get(`${PUSH_KEY_SERVICE}/${PUSH_KEY_ITEM}`)!)).toEqual(pushKeyRecord(TOKEN, null))
    await s.ensure(TOKEN, 'en')
    expect(ss.setItemAsync).toHaveBeenCalledTimes(2)
    expect([...m.values()].join()).not.toContain(TOKEN)          // 设备令牌本身从不写进这里
  })
  it('登记指纹走本地选项;clear 两条都删', async () => {
    const { m, ss } = memSecureStore()
    const s = makePushKeyStore(ss, { shared: SHARED, local: {} })
    await s.ensure(TOKEN, null)
    await s.saveReg({ fp: 'x', at: 1 })
    expect(m.get(`app/${PUSH_REG_ITEM}`)).toBe('{"fp":"x","at":1}')
    expect(await s.loadReg()).toEqual({ fp: 'x', at: 1 })
    await s.clear()
    expect(m.size).toBe(0)
  })
  it('登记指纹读出来不合形状 ⇒ 当没有', async () => {
    const { m, ss } = memSecureStore()
    m.set(`app/${PUSH_REG_ITEM}`, '{"fp":1}')
    expect(await makePushKeyStore(ss, { shared: SHARED, local: {} }).loadReg()).toBeNull()
    m.set(`app/${PUSH_REG_ITEM}`, 'not json')
    expect(await makePushKeyStore(ss, { shared: SHARED, local: {} }).loadReg()).toBeNull()
  })
  it('isDevPushToken:只认 dev + 48 位 hex,真设备令牌(d…)不算', () => {
    expect(isDevPushToken('dev' + 'a'.repeat(48))).toBe(true)
    expect(isDevPushToken(TOKEN)).toBe(false)
    expect(isDevPushToken('dev' + 'a'.repeat(47))).toBe(false)
  })
})
