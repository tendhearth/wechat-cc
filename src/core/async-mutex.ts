/**
 * async-mutex — a tiny per-key async mutex used to serialize concurrent
 * turns on the same chatId (Task 1 of session-serialization).
 *
 * Implementation: a `Map<string, Promise<void>>` tail-chain. Each call to
 * `runExclusive(key, fn)` appends `fn` to the end of that key's chain and
 * becomes the new tail. Different keys have independent, unrelated chains
 * (no cross-key blocking).
 *
 * Crucially, the tail is a *settled-guard* promise (`.then(()=>{}, ()=>{})`)
 * — it always fulfills, even if `fn` (or a prior link) rejects. Chaining on
 * a promise that can reject would otherwise "poison" the chain: `.then()`
 * on a rejected promise skips straight to the next `.then()`'s rejection
 * handler, and without a catch at every link a single throwing `fn` would
 * permanently break every subsequent waiter on that key. The settled-guard
 * ensures a throwing `fn` still releases the lock for the next caller.
 *
 * The map entry is removed once its chain drains (no unbounded growth —
 * a chat that goes quiet doesn't leak an entry forever).
 */
export interface ChatMutex {
  /**
   * Run `fn` exclusively with respect to any other `runExclusive` call for
   * the same `chatId` — a second call for the same key waits for the first
   * to settle (fulfill OR reject) before starting. Calls for different keys
   * run fully concurrently. Returns (a promise for) `fn`'s own result or
   * rejection — the mutex itself never swallows or rewrites it.
   */
  runExclusive<T>(chatId: string, fn: () => Promise<T>): Promise<T>
  /**
   * Test-only: number of keys with a live (pending or not-yet-cleaned-up)
   * chain entry. Not part of the public contract — used by async-mutex.test.ts
   * to assert the map doesn't grow unboundedly.
   */
  _size(): number
}

export function makeChatMutex(): ChatMutex {
  const tails = new Map<string, Promise<void>>()

  function runExclusive<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
    const prev = tails.get(chatId) ?? Promise.resolve()
    // Run fn after prev settles, regardless of whether prev fulfilled or
    // rejected — a rejected prior turn must not block the next one.
    const run = prev.then(() => fn(), () => fn())
    // The tail we publish is a settled-guard over `run`: it always
    // fulfills so the NEXT runExclusive's `prev.then(...)` above can use
    // the simple fulfillment branch without needing its own reject guard.
    const tail = run.then(() => undefined, () => undefined)
    tails.set(chatId, tail)
    tail.then(() => {
      // Only delete if no newer call has replaced our tail in the meantime.
      if (tails.get(chatId) === tail) tails.delete(chatId)
    })
    return run
  }

  return {
    runExclusive,
    _size: () => tails.size,
  }
}
