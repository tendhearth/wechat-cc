import type { NativeSessionPageT, NativeSessionRowT } from '../backend/types'
import { t, type Lang } from '../i18n'
import { phoneTime } from './phone-time'

export function sessionRows(items: NativeSessionRowT[], now: number, lang: Lang): Array<{ key: string; title: string; meta: string; active: boolean }> {
  return items.map(s => ({
    key: s.key, title: s.title, active: s.active,
    meta: [s.project, phoneTime(s.updatedAt, now, lang)].filter(Boolean).join(' · ') || t(lang, 'sessions.unknownTime'),
  }))
}

/** 第一页 + 「继续查找」追加的页:按 key 去重(先出现的留下),顺序不变。 */
export function mergeSessionPages(first: NativeSessionRowT[], extra: NativeSessionRowT[]): NativeSessionRowT[] {
  const seen = new Set<string>()
  return [...first, ...extra].filter(r => (seen.has(r.key) ? false : (seen.add(r.key), true)))
}

export function mergeSessionMessages(first: NativeSessionPageT['messages'], extra: NativeSessionPageT['messages']): NativeSessionPageT['messages'] {
  const seen = new Set<string>()
  return [...first, ...extra].filter(message => (seen.has(message.id) ? false : (seen.add(message.id), true)))
}

export function sessionSearch(text: string): string | null {
  return text.length > 200 || text.includes('\0') ? null : text.trim()
}
