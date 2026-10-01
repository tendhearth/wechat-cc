import type { NativeSessionRowT } from '../backend/types'
import { t, type Lang } from '../i18n'
import { shortDate } from './connections'

export function sessionRows(items: NativeSessionRowT[], _now: number, lang: Lang): Array<{ key: string; title: string; meta: string; active: boolean }> {
  return items.map(s => ({
    key: s.key, title: s.title, active: s.active,
    meta: [s.project, s.updatedAt === null ? null : shortDate(s.updatedAt, lang)].filter(Boolean).join(' · ') || t(lang, 'sessions.unknownTime'),
  }))
}
