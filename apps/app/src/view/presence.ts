// CC 的明暗与顶栏状态行(spec 2026-10-01 §4)。纯 TS。
import type { Connection } from '../backend/types'
import { t, type Lang } from '../i18n'
import { formatSynced } from './connection'

export type CCPresence = 'here' | 'away'

/** 隧道握手成功、daemon 在答话 ⇒ 在身边。电脑合盖 / 关机 / daemon 没跑都落到「够不着」。 */
export function ccPresence(c: Connection): CCPresence {
  return c.state === 'online' ? 'here' : 'away'
}

/** 顶栏状态行:`text` 是看得见的短句(窄屏放得下);`label` 给读屏,离线时带上次同步时间(连接页也写着)。
 * 演示模式:演示后端永远「在线」,但根本没有电脑 ⇒ 灰点 +「演示 · 没有连电脑」,界面不说它不知道的事。 */
export function statusLine(c: Connection, now: number, lang: Lang, opts?: { demo?: boolean }): { dot: 'ok' | 'bad' | 'unknown'; text: string; label: string } {
  const home = t(lang, 'common.computerHome')
  const same = (dot: 'ok' | 'bad' | 'unknown', text: string) => ({ dot, text, label: text })
  if (opts?.demo) return same('unknown', t(lang, 'common.demoStatus'))
  if (c.state === 'online') return same('ok', `${home} · ${t(lang, 'common.computerOnline')}`)
  if (c.state === 'connecting') return same('unknown', `${home} · ${t(lang, 'common.computerConnecting')}`)
  if (c.state === 'revoked') return same('bad', `${home} · ${t(lang, 'common.computerRevoked')}`)
  const text = `${home} · ${t(lang, 'common.computerOffline')}`
  const synced = c.lastSyncedAt === null ? '' : ` · ${t(lang, 'common.syncedAt', { time: formatSynced(c.lastSyncedAt, now, lang) })}`
  return { dot: 'bad', text, label: text + synced }
}

/** 状态行里只有「HH:MM 同步」会随时间变(离线且同步过);只有这时才值得每 30 秒重算一次。 */
export function statusLineTicks(c: Connection, opts?: { demo?: boolean }): boolean {
  return !opts?.demo && c.state === 'offline' && c.lastSyncedAt !== null
}
