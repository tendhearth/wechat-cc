import type { Connection } from '../backend/types'
import { t, type Lang } from '../i18n'

const pad = (n: number) => String(n).padStart(2, '0')

/** 上次同步时间:一分钟内「刚刚」;同一天 HH:MM;否则带月日。用本地时区。 */
export function formatSynced(ts: number, now: number, lang: Lang): string {
  if (now - ts < 60_000) return t(lang, 'conn.justNow')
  const d = new Date(ts), n = new Date(now)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return hm
  return lang === 'zh-Hans' ? `${d.getMonth() + 1}月${d.getDate()}日 ${hm}` : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

/** spec §3:离线显示上次同步时间;撤销与离线分开表达;在线不提示。 */
export function connectionNotice(c: Connection, now: number, lang: Lang): null | { kind: 'connecting' | 'offline' | 'revoked'; text: string } {
  if (c.state === 'online') return null
  if (c.state === 'revoked') return { kind: 'revoked', text: t(lang, 'conn.revokedBody') }
  if (c.state === 'connecting') return { kind: 'connecting', text: t(lang, 'conn.connecting') }
  return {
    kind: 'offline',
    text: c.lastSyncedAt === null ? t(lang, 'conn.offlineNever') : t(lang, 'conn.offline', { time: formatSynced(c.lastSyncedAt, now, lang) }),
  }
}

/** 发送 / 批准 / 拒绝 / 回答只在在线时可点(连接中、离线、撤销一律锁住;草稿照写)。 */
export const canSubmit = (c: Connection): boolean => c.state === 'online'
