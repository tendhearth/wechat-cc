/**
 * pending-confirm — a tiny pure keyed yes/no confirmation map.
 *
 * `ask(key, timeoutMs)` registers a pending promise under `key` and resolves
 * it `false` if nobody calls `resolve(key, ...)` within `timeoutMs`. The next
 * inbound text addressed to `key` is fed through `resolve`, which interprets
 * it as yes/no and settles the pending promise.
 *
 * Used to capture an operator's next 1:1 reply as a yes/no answer to an
 * async question posed out-of-band (e.g. "CC-B 也爱摄影, 牵个线? (回复 是/否)")
 * without blocking the caller on a synchronous prompt. Pure — no timers
 * beyond `setTimeout`, no `Date.now()`/`Math.random()`, fully unit-testable.
 */

const YES_WORDS = new Set(['是', '好', 'y', 'yes', 'ok', '同意', '牵', '行'])

function isYes(text: string): boolean {
  return YES_WORDS.has(text.trim().toLowerCase())
}

export interface PendingConfirms {
  /** Register a pending confirmation under `key`; resolves `false` after `timeoutMs` if unanswered. */
  ask(key: string, timeoutMs: number): Promise<boolean>
  /** Answer the pending confirmation under `key` with free text. Returns true iff a pending confirmation existed for `key`. */
  resolve(key: string, text: string): boolean
}

export function createPendingConfirms(): PendingConfirms {
  const pending = new Map<string, { resolveFn: (v: boolean) => void; timer: ReturnType<typeof setTimeout> }>()

  return {
    ask(key, timeoutMs) {
      return new Promise<boolean>((resolvePromise) => {
        // resolve() clears this timer before deleting the entry, so this
        // callback only ever fires when nobody has resolved yet.
        const timer = setTimeout(() => {
          pending.delete(key)
          resolvePromise(false)
        }, timeoutMs)
        pending.set(key, { resolveFn: resolvePromise, timer })
      })
    },
    resolve(key, text) {
      const entry = pending.get(key)
      if (!entry) return false
      pending.delete(key)
      clearTimeout(entry.timer)
      entry.resolveFn(isYes(text))
      return true
    },
  }
}
