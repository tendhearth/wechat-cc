// CC 的明暗与顶栏状态行(spec 2026-10-01 §4)。纯 TS。
import type { Connection } from '../backend/types'
import { t, type Lang } from '../i18n'
import { formatSynced } from './connection'

export type CCPresence = 'here' | 'away'

/** 隧道握手成功、daemon 在答话 ⇒ 在身边。电脑合盖 / 关机 / daemon 没跑都落到「够不着」。
 * 演示:演示后端永远「在线」,但那不是真信号 ⇒ 暗(主人规矩:只有真信号才亮)。 */
/** 这次启动已经成功同步过(令牌被电脑认过)才算真在线:hello 是明文,「online」本身不证明令牌有效。 */
const verified = (c: Connection): boolean => c.state === 'online' && c.lastSyncedAt !== null

export function ccPresence(c: Connection, opts?: { demo?: boolean }): CCPresence {
  return !opts?.demo && verified(c) ? 'here' : 'away'
}

/** 顶栏状态行:`text` 是看得见的短句(窄屏放得下);`label` 给读屏,离线时带上「你看到的是 HH:MM 的样子」(连接页也写着)。
 * 演示模式:演示后端永远「在线」,但根本没有电脑 ⇒ 灰点 +「演示 · 没有连电脑」,界面不说它不知道的事。
 * 离线 = 「家里的电脑暂时连不上」,不是出错:灰点,不上红;只有撤销才是红点。分不出原因 ⇒ 不说「事情先停着」(可能是假话)。 */
export function statusLine(c: Connection, now: number, lang: Lang, opts?: { demo?: boolean }): { dot: 'ok' | 'bad' | 'unknown'; text: string; label: string } {
  const home = t(lang, 'common.computerHome')
  const same = (dot: 'ok' | 'bad' | 'unknown', text: string) => ({ dot, text, label: text })
  if (opts?.demo) return same('unknown', t(lang, 'common.demoStatus'))
  if (verified(c)) return same('ok', `${home} · ${t(lang, 'common.computerOnline')}`)
  if (c.state === 'connecting' || c.state === 'online') return same('unknown', `${home} · ${t(lang, 'common.computerConnecting')}`)
  if (c.state === 'revoked') return same('bad', t(lang, 'common.computerRevoked'))
  const text = t(lang, 'common.computerOffline')
  const synced = c.lastSyncedAt === null ? '' : ` · ${t(lang, 'common.syncedAt', { time: formatSynced(c.lastSyncedAt, now, lang) })}`
  return { dot: 'unknown', text, label: text + synced }
}

/** 状态行里只有「你看到的是 HH:MM 的样子」会随时间变(离线且同步过);只有这时才值得每 30 秒重算一次。 */
export function statusLineTicks(c: Connection, opts?: { demo?: boolean }): boolean {
  return !opts?.demo && c.state === 'offline' && c.lastSyncedAt !== null
}
