/**
 * Calibration gate — the single chokepoint every proactive send passes
 * through (agenda-driven care intentions AND gap check-ins today; future
 * proactive features route through here too, with their own `kind`).
 *
 * Pure: no I/O, no `new Date()` / `Date.now()`. All timestamps come in as
 * ISO strings; math is done via `Date.parse`.
 *
 * See docs/superpowers/specs/2026-07-09-proactive-care-design.md §5.
 */

export type CareLevel = 'off' | 'low' | 'high'

export type CareKind = 'agenda' | 'gap'

export interface CareLedgerEntry {
  /** ISO timestamp of the last proactive send claimed for this chat. */
  lastProactiveAtIso?: string
  /** Consecutive proactive sends with no user reply since. */
  noReplyCount: number
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** Max ~1 agenda-driven proactive send per chat per day. */
const AGENDA_COOLDOWN_MS = 20 * HOUR

/** Gap check-in requires this many quiet days, by care level. */
const GAP_DAYS: Record<'low' | 'high', number> = { low: 7, high: 2 }

/** 2 consecutive un-replied proactive sends ⇒ auto-pause gap check-ins. */
const PAUSE_AFTER_NO_REPLIES = 2

/**
 * Resolve the effective care level for a chat. Explicit `prefs.care` always
 * wins. Unset defaults to `low` for the owner's chat (`chatId ===
 * defaultChatId`, and only when `defaultChatId` is defined) and `off` for
 * every other chat.
 */
export function careLevel(
  chatId: string,
  prefs: { care?: CareLevel },
  defaultChatId: string | undefined,
): CareLevel {
  if (prefs.care !== undefined) return prefs.care
  return defaultChatId !== undefined && chatId === defaultChatId ? 'low' : 'off'
}

/**
 * The calibration gate. Every deny carries a stable, loggable `reason`
 * string: `care_off`, `agenda_cooldown`, `never_talked`, `paused_no_reply`,
 * `gap_inbound_recent`, `gap_proactive_recent`.
 */
export function shouldSpeak(args: {
  kind: CareKind
  level: CareLevel
  nowIso: string
  ledger: CareLedgerEntry
  /** Latest user (inbound) message in this chat; undefined = never talked. */
  lastInboundAtIso?: string
}): { ok: true } | { ok: false; reason: string } {
  const { kind, level, nowIso, ledger, lastInboundAtIso } = args

  if (level === 'off') return { ok: false, reason: 'care_off' }

  const nowMs = Date.parse(nowIso)
  if (Number.isNaN(nowMs)) return { ok: false, reason: 'invalid_timestamp' }

  const lastProactiveMs =
    ledger.lastProactiveAtIso !== undefined ? Date.parse(ledger.lastProactiveAtIso) : undefined
  if (lastProactiveMs !== undefined && Number.isNaN(lastProactiveMs)) {
    return { ok: false, reason: 'invalid_timestamp' }
  }

  const lastInboundMs =
    lastInboundAtIso !== undefined ? Date.parse(lastInboundAtIso) : undefined
  if (lastInboundMs !== undefined && Number.isNaN(lastInboundMs)) {
    return { ok: false, reason: 'invalid_timestamp' }
  }

  if (kind === 'agenda') {
    if (lastProactiveMs !== undefined) {
      const sinceProactiveMs = nowMs - lastProactiveMs
      if (sinceProactiveMs < AGENDA_COOLDOWN_MS) return { ok: false, reason: 'agenda_cooldown' }
    }
    return { ok: true }
  }

  // kind === 'gap' — order matters: never_talked → paused_no_reply →
  // gap_inbound_recent → gap_proactive_recent (tests pin this ordering).
  if (lastInboundMs === undefined) return { ok: false, reason: 'never_talked' }
  if (ledger.noReplyCount >= PAUSE_AFTER_NO_REPLIES) return { ok: false, reason: 'paused_no_reply' }

  const gapMs = GAP_DAYS[level] * DAY

  const sinceInboundMs = nowMs - lastInboundMs
  if (sinceInboundMs < gapMs) return { ok: false, reason: 'gap_inbound_recent' }

  if (lastProactiveMs !== undefined) {
    const sinceProactiveMs = nowMs - lastProactiveMs
    if (sinceProactiveMs < gapMs) return { ok: false, reason: 'gap_proactive_recent' }
  }

  return { ok: true }
}
