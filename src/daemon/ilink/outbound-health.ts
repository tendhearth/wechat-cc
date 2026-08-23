/**
 * Outbound send health — passive tracker fed by the ilink-glue sendMessage
 * chokepoint (spec 2026-08-22-outbound-health-design). Pure state machine,
 * zero I/O, time injected. In-memory only: a restart resets to 'unknown'
 * and the next in-flight send (e.g. a reminder retry) re-establishes state
 * within minutes — deliberate trade against persistence complexity.
 *
 * Counts LOGICAL sends (one adapter.sendMessage call), not the 3 internal
 * wire retries; only wire failures reach here (routing errors are excluded
 * at the hook). Exactly one log line per transition — the per-failure
 * record already exists as [RETRY_FAIL] lines.
 */
export type OutboundState = 'unknown' | 'ok' | 'degraded'

export interface OutboundHealth {
  state: OutboundState
  consecutiveFailures: number
  lastOkAt: string | null
  lastFailAt: string | null
  lastError: string | null
  episodeStartedAt: string | null
}

export interface OutboundHealthTracker {
  recordSuccess(nowIso: string): void
  recordFailure(nowIso: string, error: string): void
  snapshot(): OutboundHealth
}

const DEFAULT_DEGRADED_AFTER = 2
const MAX_ERROR_LEN = 200

/** Human-ish duration for the recovery log: 90000ms → "1m", 5h → "5h". */
function humanDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  return `${Math.round(ms / 3_600_000 * 10) / 10}h`
}

export function makeOutboundHealthTracker(deps: {
  log: (tag: string, line: string) => void
  degradedAfter?: number
}): OutboundHealthTracker {
  const threshold = deps.degradedAfter ?? DEFAULT_DEGRADED_AFTER
  const s: OutboundHealth = {
    state: 'unknown', consecutiveFailures: 0,
    lastOkAt: null, lastFailAt: null, lastError: null, episodeStartedAt: null,
  }
  // First failure timestamp of the current run — becomes episodeStartedAt
  // when the run crosses the threshold.
  let runStartedAt: string | null = null

  return {
    recordSuccess(nowIso) {
      if (s.state === 'degraded') {
        const dur = Date.parse(nowIso) - Date.parse(s.episodeStartedAt ?? nowIso)
        deps.log('OUTBOUND', `recovered after ${humanDuration(dur)}, ${s.consecutiveFailures} failures — last error was: ${s.lastError}`)
      }
      s.state = 'ok'
      s.consecutiveFailures = 0
      s.lastOkAt = nowIso
      s.episodeStartedAt = null
      runStartedAt = null
    },
    recordFailure(nowIso, error) {
      s.consecutiveFailures++
      s.lastFailAt = nowIso
      s.lastError = error.slice(0, MAX_ERROR_LEN)
      if (runStartedAt === null) runStartedAt = nowIso
      if (s.state !== 'degraded' && s.consecutiveFailures >= threshold) {
        s.state = 'degraded'
        s.episodeStartedAt = runStartedAt
        deps.log('OUTBOUND', `degraded — ${s.consecutiveFailures} consecutive failures, last: ${s.lastError}`)
      }
    },
    snapshot() {
      return { ...s }
    },
  }
}
