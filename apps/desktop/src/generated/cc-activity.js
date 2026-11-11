// Generated from packages/protocol/src/cc-activity.js; bun run gen:routes
// @ts-check
// Shared presentation contract. Presence controls light; only current evidence controls acting.
/** @typedef {'idle'|'listening'|'thinking'|'speaking'} CCPhase */
/** @typedef {{scope?:string,activityReady?:boolean,running:{turnId:string}|null,events:readonly {id:string,turnId:string|null,kind:string,text:string}[]}} CCStream */
export const CC_ACTIVITY = Object.freeze({ speechMs: 900, leaseMs: 2500, typingMs: 1600, attentionMs: 12000 })

export function createCCActivity() {
  let turn = '', scope = '', confirmedAt = -Infinity, speechUntil = -Infinity
  /** @type {Map<string,string>} */ let text = new Map()
  return {
    /** A first snapshot, new turn, scope change or suppressed observation establishes a baseline.
     * @param {CCStream|null|undefined} stream @param {number} now @param {boolean} [animate] */
    observe(stream, now, animate = true) {
      animate = animate && stream?.activityReady !== false
      const nextTurn = stream?.running?.turnId ?? ''
      const nextScope = stream?.scope ?? scope
      const baseline = !turn || nextTurn !== turn || nextScope !== scope
      if (baseline || !animate) speechUntil = -Infinity
      const next = baseline ? new Map() : new Map(text)
      for (const event of stream?.events ?? []) {
        if (!nextTurn || event.turnId !== nextTurn || event.kind !== 'agent_message' || !event.text) continue
        next.set(event.id, event.text)
        if (!baseline && animate && text.get(event.id) !== event.text) speechUntil = now + CC_ACTIVITY.speechMs
      }
      text = next; turn = nextTurn; scope = nextScope
      confirmedAt = stream ? now : -Infinity
      if (!turn) speechUntil = -Infinity
    },
    /** @param {{connected:boolean,now:number,typing?:boolean,waiting?:boolean,blocked?:boolean}} facts @returns {CCPhase} */
    phase({ connected, now, typing = false, waiting = false, blocked = false }) {
      if (!connected || waiting || blocked) return 'idle'
      if (turn && now - confirmedAt < CC_ACTIVITY.leaseMs) return now < speechUntil ? 'speaking' : 'thinking'
      return typing ? 'listening' : 'idle'
    },
    /** @param {number} now */
    nextChangeAt(now) { return Math.min(...[speechUntil, confirmedAt + CC_ACTIVITY.leaseMs].filter(at => at > now), Infinity) },
  }
}

/** A result group also contains failure and cancellation. It is never success evidence.
 * @template {{status:string}} T @param {readonly T[]} rows @returns {T[]} */
export const successfulCCResults = rows => rows.filter(row => row.status === 'replied' || row.status === 'done')

// Both renderers use one bounded text-response performance, never an audio/mouth loop.
export const CC_RESPONSE = Object.freeze({ frameMs: 167, frames: 4, cooldownMs: 2400 })
export function createCCResponsePerformance() {
  /** @type {CCPhase} */ let previous = 'idle'
  let started = -Infinity, last = -Infinity
  return {
    /** Suppression consumes the current edge, including one first seen while hidden.
     * @param {CCPhase} phase @param {number} now @param {boolean} [active] @returns {number|null} */
    frame(phase, now, active = true) {
      const entering = phase === 'speaking' && previous !== 'speaking'
      previous = phase
      if (!active || phase !== 'speaking') { started = -Infinity; return null }
      if (entering && now - last >= CC_RESPONSE.cooldownMs) { started = now; last = now }
      const index = Math.floor((now - started) / CC_RESPONSE.frameMs)
      return index >= 0 && index < CC_RESPONSE.frames ? index : null
    },
  }
}
