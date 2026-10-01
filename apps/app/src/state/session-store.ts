import type { Lang } from '../i18n'
import type { CredentialStore } from '../net/credentials'
import type { PairingRecord } from '../net/pairing'

// 会话读写钥匙串的纯逻辑(不引 react,方便测试)。日志只写操作名与错误类型 / code,从不写错误文本(可能带令牌)。

type Log = (line: string) => void
const devLog: Log = l => { if (typeof __DEV__ !== 'undefined' && __DEV__) console.log(`[session] ${l}`) }
const kind = (e: unknown): string => {
  const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined
  if (typeof code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(code)) return code
  return e instanceof Error ? e.name : 'unknown'
}

/** 配对与偏好各读各的:偏好读失败不连累配对(否则已配对的手机会悄悄跑成演示);配对读失败 ⇒ 当没配对。 */
export async function loadSession(store: CredentialStore, log: Log = devLog): Promise<{ pairing: PairingRecord | null; lang: Lang | null }> {
  const [p, prefs] = await Promise.allSettled([store.load(), store.loadPrefs()])
  if (p.status === 'rejected') log(`pairing load failed (${kind(p.reason)})`)
  if (prefs.status === 'rejected') log(`prefs load failed (${kind(prefs.reason)})`)
  return { pairing: p.status === 'fulfilled' ? p.value : null, lang: prefs.status === 'fulfilled' ? prefs.value.lang : null }
}

/** 不等结果的钥匙串写:失败只记一行,不留未处理的拒绝。 */
export function quietly(p: Promise<unknown>, op: string, log: Log = devLog): void {
  p.catch(e => log(`${op} failed (${kind(e)})`))
}

/** 撤销 / 解除配对:配对记录与推送密钥一起清(spec §3)。推送那条失败只记一行;配对那条失败照样抛给调用方。 */
export async function clearStored(store: CredentialStore, push: { clear(): Promise<void> }, log: Log = devLog): Promise<void> {
  const [p] = await Promise.allSettled([store.clear(), push.clear().catch(e => log(`pushClear failed (${kind(e)})`))])
  if (p.status === 'rejected') throw p.reason
}

/** 会话读完却没有配对 ⇒ 钥匙串里若还留着推送密钥就该清(上次清失败 / 老版本升级上来)。 */
export function leftoverPushKey(ready: boolean, pairing: PairingRecord | null): boolean {
  return ready && pairing === null
}

/**
 * 等在飞的同步 / 写停下之后、真正清推送密钥之前再判一次:记下的是当时的配对(撤销)或 null(没配对)。
 * 现在没配对 ⇒ 清;还是那条配对且仍被撤销 ⇒ 清;其余(这期间重新配对了)⇒ 不清,免得清掉新配对的密钥与指纹。
 */
export function stillClearPushKey(captured: PairingRecord | null, now: { pairing: PairingRecord | null; revoked: boolean }): boolean {
  if (now.pairing === null) return true
  return captured !== null && now.pairing === captured && now.revoked
}
