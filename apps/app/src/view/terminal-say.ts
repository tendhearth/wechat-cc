import type { CliSessionRowT } from '../backend/types'
import { t, type Lang } from '../i18n'

/**
 * 手机说一句之后那行小字(2026-10-20):送进开着的窗口是后台的,daemon 只回「收下」。
 * 回了 say_id ⇒ 看会话行的 last_say 对上同一个 id 才改口(送到 / 没送进去);对不上不说送到。
 * 没回 say_id:不开窗口那条路 ⇒ 收下就是开跑了;开着窗口却没 say_id ⇒ 老 daemon,只说收下了。
 */
export type SayTrack = {
  /** POST /m/api/cli/say 回的;没有 ⇒ null */
  sayId: string | null
  /** 发出时这条会话开在窗口里 */
  live: boolean
  /** 手机时钟,发出那一刻 */
  sentAt: number
  /** 发出前列表上那条 last_say 的 id:列表还没刷新时看到的是它,不算别人的新一句 */
  prevId: string | null
}
export type SayView =
  | { kind: 'sending' }
  | { kind: 'sent' }
  | { kind: 'failed'; error: string }
  /** 等了 SAY_CONFIRM_MS 还是 sending */
  | { kind: 'unconfirmed' }
  /** 后来又有一句(别的设备 / 别处)盖掉了这句的结果:看不到这句送没送到 */
  | { kind: 'superseded' }
  /** 不开窗口那条路:收下即开跑 */
  | { kind: 'accepted' }
  /** 开着窗口、电脑没给 say_id(老 daemon):只能说收下了 */
  | { kind: 'acceptedUnknown' }

/** 在送时快拉列表的间隔;最多快拉这么久就改说「还没确认」。 */
export const SAY_FAST_POLL_MS = 2_000
export const SAY_CONFIRM_MS = 60_000

// 还没确认的不算定下:之后照常 15 秒一拉,迟到的送到 / 没送进去照样改过来
const settled = (v: SayView | null): v is SayView => !!v && v.kind !== 'sending' && v.kind !== 'unconfirmed'

/** 已经定下的不再改(之后列表变了也不翻案);在送 / 还没确认的会往前走。 */
export function nextSayView(prev: SayView | null, track: SayTrack, last: CliSessionRowT['last_say'] | undefined, now: number): SayView {
  if (settled(prev)) return prev
  if (track.sayId === null) return { kind: track.live ? 'acceptedUnknown' : 'accepted' }
  if (last && last.id === track.sayId) {
    if (last.state === 'sent') return { kind: 'sent' }
    if (last.state === 'failed') return { kind: 'failed', error: last.error ?? '' }
  } else if (last && last.id !== track.prevId) {
    return { kind: 'superseded' }
  }
  // 对上了还在送 / 列表还是发出前那份 / 还没带 last_say
  return now - track.sentAt >= SAY_CONFIRM_MS ? { kind: 'unconfirmed' } : { kind: 'sending' }
}

export function sayNote(v: SayView, lang: Lang): string {
  switch (v.kind) {
    case 'sending': return t(lang, 'terminal.sayLiveSending')
    case 'sent': return t(lang, 'terminal.sentLive')
    // daemon 给的 error 本来就是一句人话(「没送进电脑上开着的窗口(…)」),原样显示,不再加前缀(重复)
    case 'failed': return v.error ? v.error : t(lang, 'terminal.sayLiveFailedBare')
    case 'unconfirmed': return t(lang, 'terminal.sayLiveUnconfirmed')
    case 'superseded':
    case 'acceptedUnknown': return t(lang, 'terminal.sayLiveAccepted')
    case 'accepted': return t(lang, 'terminal.sent')
  }
}
