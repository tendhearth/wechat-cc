import type { DeviceRowT } from '../backend/types'
import { t, type Lang } from '../i18n'
import { formatSynced } from './connection'

export function devicesView(rows: DeviceRowT[], now: number, lang: Lang) {
  const me = rows.find(r => r.current) ?? null
  const seen = (r: DeviceRowT) => Date.parse(r.last_seen_at)
  const others = rows
    .filter(r => !r.current)
    .sort((a, b) => (seen(b) || 0) - (seen(a) || 0))
    .map(r => ({
      id: r.id,
      label: r.label?.trim() || t(lang, 'devices.unnamed'),
      lastSeen: Number.isFinite(seen(r)) ? t(lang, 'devices.lastSeen', { time: formatSynced(seen(r), now, lang) }) : '',
    }))
  return { me: me ? { id: me.id, label: me.label ?? '' } : null, others }
}
