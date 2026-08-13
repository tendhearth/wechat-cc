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
 * channel lands in Task 8, which reads the incident store exposed on the
 * returned HealthRuntime (`.incidents`, backed by health-incidents.json)
 * via internal-api's `setIncidents()` late-bind (see main.ts).
 */
import { makeHealthRuntime, type HealthRuntime } from '../health'
import { classifyFailure } from '../health/classify'

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

/**
 * Reports one coordinator TurnRecord's outcome to the health runtime (Task
 * 9). Called from bootstrap/index.ts's `recordTurn` sink — the narrowest
 * point that sees every solo/parallel/chatroom provider call's
 * success/failure, without threading health deps through
 * conversation-coordinator.ts's own control flow. Extracted as a pure
 * function (health + two primitives in, no TurnRecord/coordinator import)
 * so the outcome→failure-kind mapping below is unit-testable on its own,
 * against a real health runtime, without constructing a full Bootstrap.
 *
 * `outcome`/`error` are `TurnRecord['outcome']` / `TurnRecord['error']` by
 * caller convention, typed as primitives here to avoid this module (bootstrap
 * layer) importing core/conversation-coordinator's TurnRecord type just for
 * a string literal union.
 */
export function reportLlmTurnOutcome(health: HealthRuntime, outcome: string, error: string | undefined): void {
  if (outcome === 'completed') {
    health.onSuccess('llm')
    return
  }
  // NOT every non-'completed' outcome is a connectivity/auth problem.
  // `outcome: 'error'` is populated from collectTurn's aggregation of
  // AgentEvent{kind:'error'} (src/core/agent-provider.ts), which several
  // PROVIDER-INTERNAL, connectivity-unrelated conditions also push into:
  // e.g. openai-agent-provider.ts's tool-call step-budget exhaustion, or
  // claude-agent-provider.ts's non-'success' result subtype (max_turns
  // etc). Those don't match classify.ts's NETWORK_RE/LLM_AUTH_RE, so they
  // fall into the 'unknown' bucket — reachable and authenticated, just a
  // normal business-logic failure for that one turn.
  //
  // Reporting 'unknown' as an 'llm' failure would be actively harmful: a
  // user on a flaky tool (or a provider that legitimately hits max_turns a
  // lot) could rack up ≥3 'unknown' failures across DIFFERENT chats within
  // the 60s confirmation window with the LLM link itself perfectly healthy
  // — mw-llm-health would then degrade EVERY chat to template-only replies,
  // breaking a working bot for everyone instead of just the one flaky tool.
  // So only report the kinds classify.ts can actually attribute to the LLM
  // connection/auth itself; 'unknown' (and 'login_taken_over', which is the
  // wechat side's own failure kind) are deliberately swallowed here, never
  // passed to onFailure at all.
  //
  // This is a conservative, ASYMMETRIC tradeoff, consistent with the rest of
  // this machine: better to miss a real LLM outage that happens to surface
  // as an unrecognized error string (worst case: no alert) than to
  // misclassify a business failure as a connection failure (worst case:
  // silences every chat's real replies).
  const kind = classifyFailure(error ?? outcome).kind
  if (kind === 'network' || kind === 'llm_auth') {
    health.onFailure('llm', error ?? outcome)
  }
}
