import type { CliSessionRowT } from '../backend/types'
import { t, type Lang, type MessageKey } from '../i18n'
import type { Dot } from './connections'
import { formatSynced } from './connection'

/**
 * 终端里的会话(2026-10-14):主人在 CC 外面开的 Claude Code / Codex。CC 是所有执行者的总管 ——
 * 这些会话和 CC 自己的事并排出现在「一起做」,等你批准的也算进「此刻」那个数。
 */
export type TerminalStatus = CliSessionRowT['status']
export type TerminalRow = {
  id: string
  project: string
  source: string
  status: TerminalStatus
  stale: boolean
  summary: string | null
  ago: string
  /** 等批准的那一项(「Bash: npm run deploy」);不在等 ⇒ null。 */
  pendingText: string | null
  /** 中继在微信里开了码(主人不在电脑前)⇒ 手机上能拍;终端自己在问 ⇒ false。 */
  actionable: boolean
  hash: string | null
}

export const TERMINAL_DOT: Record<TerminalStatus, Dot> = { waiting: 'warn', running: 'unknown', idle: 'ok', ended: 'unknown' }

/** 「刚刚 / 5 分钟前 / 3 小时前」,一天以上退回日期。 */
export function relAgo(ts: number, now: number, lang: Lang): string {
  const d = Math.max(0, now - ts)
  if (d < 60_000) return t(lang, 'terminal.justNow')
  if (d < 3_600_000) return t(lang, 'terminal.minutesAgo', { n: Math.floor(d / 60_000) })
  if (d < 86_400_000) return t(lang, 'terminal.hoursAgo', { n: Math.floor(d / 3_600_000) })
  return formatSynced(ts, now, lang)
}

export function terminalRow(s: CliSessionRowT, now: number, lang: Lang): TerminalRow {
  const p = s.pending
  return {
    id: s.session_id,
    project: s.project,
    source: t(lang, s.source === 'codex' ? 'sessions.codex' : s.source === 'cursor' ? 'sessions.cursor' : 'sessions.claude'),
    status: s.status,
    stale: s.stale,
    summary: s.last_summary,
    ago: relAgo(s.last_event_at, now, lang),
    pendingText: s.status === 'waiting' && p ? (p.summary ? `${p.tool}: ${p.summary}` : p.tool) : null,
    // 老 daemon 不带 actionable ⇒ 当作不可拍
    actionable: s.status === 'waiting' && p?.actionable === true && typeof p.hash === 'string',
    hash: p?.hash ?? null,
  }
}

/** 「一起做」那一段:等你批准的在前,其余按最近动静(daemon 已排好,这里只防老数据乱序);结束了的不占位置。 */
export function terminalRows(sessions: CliSessionRowT[] | undefined, now: number, lang: Lang): TerminalRow[] {
  return (sessions ?? [])
    .filter(s => s.status !== 'ended')
    .sort((a, b) => (Number(b.status === 'waiting') - Number(a.status === 'waiting')) || b.last_event_at - a.last_event_at)
    .map(s => terminalRow(s, now, lang))
}

/** 等你、而且手机上拍得了的那几条(「此刻」的数与行)。够不着电脑时这份是旧的 ⇒ 0。 */
export function terminalNeedsYou(sessions: CliSessionRowT[] | undefined, known: boolean): CliSessionRowT[] {
  if (!known) return []
  return (sessions ?? []).filter(s => s.status === 'waiting' && s.pending?.actionable === true && typeof s.pending.hash === 'string')
}

/** 能不能接着说一句:只有歇着的能(在跑 / 在等批准 ⇒ 这一轮还没完;结束了 ⇒ 接不上)。 */
export function canSayTo(status: TerminalStatus | undefined): boolean {
  return status === 'idle'
}

/** 提交失败的一句话。 */
export function terminalErrorKey(code: string): MessageKey {
  switch (code) {
    case 'stale': return 'terminal.stale'
    case 'cli_not_actionable': return 'terminal.askedLocally'
    case 'busy': return 'terminal.sayBusy'
    case 'cli_ended': return 'terminal.sayEnded'
    case 'cli_remote': return 'terminal.remote'
    case 'not_found': return 'terminal.gone'
    case 'uncertain': return 'terminal.uncertain'
    default: return 'terminal.failed'
  }
}
