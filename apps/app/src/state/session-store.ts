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
