import { b64uEncode, derivePushKey } from '@wechat-cc/protocol'
import type { Lang } from '../i18n'
import type { SecureStoreLike } from '../net/credentials'

/**
 * 推送密钥记录(spec §4「身份与存储」):扩展 / 消息服务只读这一条,读不到设备令牌。
 * iOS:service `tendhearth.push`、access group 与通知扩展共享(`9Y6JAPDP7A.com.tendhearth.app.shared`,AFTER_FIRST_UNLOCK,
 * 选项由调用方的 shared 传入);安卓:同一份 expo-secure-store,Kotlin 按它的存储格式直接读。
 * 改键名、改 service、改格式 ⇒ 同时改 native/ 两端。
 * 纯 TS(根目录测试会 import):不引 react / react-native / expo-*。
 */
export const PUSH_KEY_ITEM = 'tendhearth.pushkey.v1'
export const PUSH_KEY_SERVICE = 'tendhearth.push'
/** 上次登记成功的指纹(设备 id + 平台 + token)与时间;本地(默认 service),不共享。 */
export const PUSH_REG_ITEM = 'tendhearth.pushreg.v1'

/** 序列化后恰好是 `{"v":1,"key":"<base64url 32 字节>","lang":"en"|"zh-Hans"|null}`(字段顺序即写入顺序)。 */
export type PushKeyRecord = { v: 1; key: string; lang: Lang | null }
export type PushReg = { fp: string; at: number }

export interface PushKeyStore {
  /** 从设备令牌推出推送密钥,连同语言写进共享钥匙串;内容没变就不写。 */
  ensure(deviceToken: string, lang: Lang | null): Promise<void>
  loadReg(): Promise<PushReg | null>
  saveReg(r: PushReg): Promise<void>
  /** 撤销 / 解除配对:推送密钥与登记指纹都清掉。 */
  clear(): Promise<void>
}

export function pushKeyRecord(deviceToken: string, lang: Lang | null): PushKeyRecord {
  return { v: 1, key: b64uEncode(derivePushKey(deviceToken)), lang }
}

/** 只给开发构建的模拟器验证用:形状与真设备令牌(d + 48 位 hex)刻意不同。 */
export function isDevPushToken(s: string): boolean {
  return /^dev[0-9a-f]{48}$/.test(s)
}

export function makePushKeyStore(ss: SecureStoreLike, opts: { shared: Record<string, unknown>; local: Record<string, unknown> }): PushKeyStore {
  return {
    async ensure(deviceToken, lang) {
      const next = JSON.stringify(pushKeyRecord(deviceToken, lang))
      const cur = await ss.getItemAsync(PUSH_KEY_ITEM, opts.shared)
      if (cur !== next) await ss.setItemAsync(PUSH_KEY_ITEM, next, opts.shared)
    },
    async loadReg() {
      const raw = await ss.getItemAsync(PUSH_REG_ITEM, opts.local)
      if (raw === null) return null
      try {
        const r = JSON.parse(raw) as { fp?: unknown; at?: unknown } | null
        return r && typeof r.fp === 'string' && typeof r.at === 'number' ? { fp: r.fp, at: r.at } : null
      } catch { return null }
    },
    saveReg: r => ss.setItemAsync(PUSH_REG_ITEM, JSON.stringify(r), opts.local),
    async clear() {
      await Promise.all([ss.deleteItemAsync(PUSH_KEY_ITEM, opts.shared), ss.deleteItemAsync(PUSH_REG_ITEM, opts.local)])
    },
  }
}
