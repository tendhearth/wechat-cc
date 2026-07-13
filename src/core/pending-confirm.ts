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

const YES_WORDS = new Set(['是', '好', '好的', '行', '可以', 'y', 'yes', 'ok', '同意', '牵', '牵线'])
const NO_WORDS = new Set(['否', '不', '不用', '不要', '算了', 'n', 'no', '拒绝', '不同意'])

/**
 * Classify free text as a yes/no reply. Trims + lowercases before matching
 * against the known word sets; anything outside both sets is `'unclear'` —
 * NOT auto-treated as no, so callers (resolveByOwner) can choose to leave a
 * pending confirm untouched rather than misfire on an unrelated message.
 */
export function classifyReply(text: string): 'yes' | 'no' | 'unclear' {
  const t = text.trim().toLowerCase()
  if (YES_WORDS.has(t)) return 'yes'
  if (NO_WORDS.has(t)) return 'no'
  return 'unclear'
}

export interface PendingConfirms {
  /** Register a pending confirmation under `key`; resolves `false` after `timeoutMs` if unanswered. */
  ask(key: string, timeoutMs: number): Promise<boolean>
  /** Answer the pending confirmation under `key` with free text. Returns true iff a pending confirmation existed for `key`. */
  resolve(key: string, text: string): boolean
  /** True iff any pending key equals `ownerPrefix` or starts with `ownerPrefix + ':'`. */
  hasPending(ownerPrefix: string): boolean
  /**
   * Resolve the OLDEST pending entry whose key equals `ownerPrefix` or starts
   * with `ownerPrefix + ':'`, classifying `text` as yes/no/unclear first.
   * On `'unclear'`, resolves NOTHING (the entry, if any, stays pending) —
   * this is how a reply that isn't a clear yes/no is distinguished from one
   * that is, so the caller can fall through to a normal turn instead of
   * silently consuming an unrelated message as a confirm answer.
   */
  resolveByOwner(ownerPrefix: string, text: string): 'yes' | 'no' | 'unclear'
}

export function createPendingConfirms(): PendingConfirms {
  const pending = new Map<string, { resolveFn: (v: boolean) => void; timer: ReturnType<typeof setTimeout> }>()

  function matchesOwner(key: string, ownerPrefix: string): boolean {
    return key === ownerPrefix || key.startsWith(`${ownerPrefix}:`)
  }

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
      // Preserve this method's existing contract: unclear text is treated as
      // no (classifyReply's 'unclear' collapses to false here).
      entry.resolveFn(classifyReply(text) === 'yes')
      return true
    },
    hasPending(ownerPrefix) {
      for (const key of pending.keys()) {
        if (matchesOwner(key, ownerPrefix)) return true
      }
      return false
    },
    resolveByOwner(ownerPrefix, text) {
      const verdict = classifyReply(text)
      if (verdict === 'unclear') return 'unclear'
      // Map insertion order is FIFO — the first matching key encountered
      // while iterating is the oldest pending entry under this owner.
      for (const key of pending.keys()) {
        if (!matchesOwner(key, ownerPrefix)) continue
        const entry = pending.get(key)!
        pending.delete(key)
        clearTimeout(entry.timer)
        entry.resolveFn(verdict === 'yes')
        return verdict
      }
      return 'unclear'
    },
  }
}
