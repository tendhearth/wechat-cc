import { t, type Lang } from '../i18n'
import { targetFromNotification, type PushTarget } from './target'

/** apps/relay/src/push-apns.ts 发给 APNs 的占位正文(plugins/native-guards.test.ts 钉住两边一致)。 */
export const RELAY_PLACEHOLDER_BODY = 'CC 有新动态'

export type Banner = { title: string; body: string; target: PushTarget | null }

const str = (x: unknown) => (typeof x === 'string' ? x : '')

export function bannerFrom(n: unknown, lang: Lang, fallback?: { key: Uint8Array; now: number }): Banner {
  const content = (n as { request?: { content?: { title?: unknown; body?: unknown } } } | null)?.request?.content
  const title = str(content?.title)
  const body = str(content?.body)
  const target = targetFromNotification(n, fallback)
  const neutral = body === '' || body === RELAY_PLACEHOLDER_BODY
  return {
    title: neutral ? t(lang, 'push.placeholderTitle') : title || t(lang, 'push.placeholderTitle'),
    body: neutral ? t(lang, 'push.placeholder') : body,
    target,
  }
}
