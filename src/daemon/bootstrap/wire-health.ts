/**
 * wire-health.ts — construct the connection-health runtime (spec
 * 2026-08-03: 静默 10.5 小时故障 postmortem).
 *
 * Built unconditionally (no config gate, unlike wire-pairing/wire-social):
 * every daemon has a wechat connection and (usually) an LLM provider, and the
 * whole point is that a silent failure must never again go unnoticed. Wired
 * here (in bootstrap, not main.ts directly) so it's ready BEFORE
 * registerPolling starts the long-poll loops — poll-loop.ts's very first
 * getUpdates call already needs `health.onFailure`/`onSuccess` wired.
 *
 * `notify` is log-only for now (Task 7) — the real desktop notification
 * channel lands in Task 8, which reads `health-incidents.json` written by
 * the incident store underneath makeHealthRuntime.
 */
import { makeHealthRuntime, type HealthRuntime } from '../health'

export interface HealthWireDeps {
  stateDir: string
  log: (tag: string, line: string, fields?: Record<string, unknown>) => void
}

export function wireHealth(deps: HealthWireDeps): HealthRuntime {
  return makeHealthRuntime({
    stateDir: deps.stateDir,
    now: () => Date.now(),
    log: deps.log,
    // Task 7: log-only. Task 8 swaps this for a real desktop notification
    // delivery (the incident store already persists everything a later
    // desktop-side read needs, independent of whether notify ever fires).
    notify: (n) => {
      deps.log('HEALTH_NOTIFY', `${n.actionable ? '[actionable] ' : ''}${n.title} — ${n.body}`)
    },
  })
}
