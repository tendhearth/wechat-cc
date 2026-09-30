import { t, type Lang } from '../i18n'
import { resolveNotification, type PushTarget } from './target'

/** apps/relay/src/push-apns.ts 发给 APNs 的占位正文(plugins/native-guards.test.ts 钉住两边一致)。 */
export const RELAY_PLACEHOLDER_BODY = 'CC 有新动态'

export type Banner = { title: string; body: string; target: PushTarget | null }

const str = (x: unknown) => (typeof x === 'string' ? x : '')
export const BANNER_TITLE_MAX = 80
export const BANNER_BODY_MAX = 240
const clip = (s: string, max: number) => { const a = Array.from(s); return a.length > max ? a.slice(0, max - 1).join('') + '…' : s }

/**
 * 中继控制 aps.alert,不可信。只有两种文字可以显示:扩展解开时带着合法 `tendhearth` 路由的 content 文字,
 * 或 app 兜底解密成功后的明文。其余一律中性占位、目标 null。长度截断。
 */
export function bannerFrom(n: unknown, lang: Lang, fallback?: { key: Uint8Array; now: number }): Banner {
  const content = (n as { request?: { content?: { title?: unknown; body?: unknown } } } | null)?.request?.content
  const r = resolveNotification(n, fallback)
  const neutral: Banner = { title: t(lang, 'push.placeholderTitle'), body: t(lang, 'push.placeholder'), target: null }
  if (!r) return neutral
  const title = r.via === 'decrypted' ? r.title ?? '' : str(content?.title)
  const body = r.via === 'decrypted' ? r.body ?? '' : str(content?.body)
  if (body === '' || body === RELAY_PLACEHOLDER_BODY) return { ...neutral, target: r.target }
  return { title: clip(title || neutral.title, BANNER_TITLE_MAX), body: clip(body, BANNER_BODY_MAX), target: r.target }
}
