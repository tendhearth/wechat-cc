import type { NativeSessionRowT } from '../backend/types'
import { t, type Lang } from '../i18n'
import { shortDate } from './connections'

export function sessionRows(items: NativeSessionRowT[], _now: number, lang: Lang): Array<{ key: string; title: string; meta: string; active: boolean }> {
  return items.map(s => ({
    key: s.key, title: s.title, active: s.active,
    meta: [s.project, s.updatedAt === null ? null : shortDate(s.updatedAt, lang)].filter(Boolean).join(' · ') || t(lang, 'sessions.unknownTime'),
  }))
}

/** 第一页 + 「继续查找」追加的页:按 key 去重(先出现的留下),顺序不变。 */
export function mergeSessionPages(first: NativeSessionRowT[], extra: NativeSessionRowT[]): NativeSessionRowT[] {
  const seen = new Set<string>()
  return [...first, ...extra].filter(r => (seen.has(r.key) ? false : (seen.add(r.key), true)))
}
