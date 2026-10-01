// CC 的明暗与顶栏状态行(spec 2026-10-01 §4)。纯 TS。
import type { Connection } from '../backend/types'
import { t, type Lang } from '../i18n'
import { formatSynced } from './connection'

export type CCPresence = 'here' | 'away'

/** 隧道握手成功、daemon 在答话 ⇒ 在身边。电脑合盖 / 关机 / daemon 没跑都落到「够不着」。 */
export function ccPresence(c: Connection): CCPresence {
  return c.state === 'online' ? 'here' : 'away'
}

export function statusLine(c: Connection, now: number, lang: Lang): { dot: 'ok' | 'bad' | 'unknown'; text: string } {
  const home = t(lang, 'common.computerHome')
  if (c.state === 'online') return { dot: 'ok', text: `${home} · ${t(lang, 'common.computerOnline')}` }
  if (c.state === 'connecting') return { dot: 'unknown', text: `${home} · ${t(lang, 'common.computerConnecting')}` }
  if (c.state === 'revoked') return { dot: 'bad', text: `${home} · ${t(lang, 'common.computerRevoked')}` }
  const synced = c.lastSyncedAt === null ? '' : ` · ${t(lang, 'common.syncedAt', { time: formatSynced(c.lastSyncedAt, now, lang) })}`
  return { dot: 'bad', text: `${home} · ${t(lang, 'common.computerOffline')}${synced}` }
}
