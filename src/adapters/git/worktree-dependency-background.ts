/** One cancellable daemon-owned queue; foreground restores never wait on it. */
export const DEPENDENCY_BACKGROUND_BUDGET = { timeoutMs: 15 * 60_000, maxBytes: 4 * 1024 ** 3, maxCacheBytes: 4 * 1024 ** 3, maxEntries: 200_000 }
export class DependencyBackground {
  private controller = new AbortController()
  private tail: Promise<void> = Promise.resolve()
  private keys = new Set<string>()
  constructor(private log: (line: string) => void = () => {}) {}
  setLogger(log: (line: string) => void) { this.log = log }
  get stopped() { return this.controller.signal.aborted }
  enqueue(key: string, run: (signal: AbortSignal) => Promise<void>): boolean {
    if (this.stopped || this.keys.has(key)) return false
    this.keys.add(key)
    this.tail = this.tail.then(async () => {
      if (this.stopped) return
      this.log(`start ${key}`)
      try { await run(this.controller.signal); this.log(`complete ${key}`) }
      catch (error) { this.log(`failed ${key}: ${error instanceof Error ? error.message : String(error)}`) }
    }).finally(() => { this.keys.delete(key) })
    return true
  }
  drain(): Promise<void> { return this.tail }
  async stop(): Promise<void> { this.controller.abort(); await this.tail }
}
const workers = new Map<string, DependencyBackground>()
export function dependencyBackground(stateDir: string): DependencyBackground {
  let worker = workers.get(stateDir)
  if (!worker) { worker = new DependencyBackground(); workers.set(stateDir, worker) }
  return worker
}
export function startDependencyBackground(stateDir: string, log: (line: string) => void): DependencyBackground {
  const previous = workers.get(stateDir)
  if (previous && !previous.stopped) { previous.setLogger(log); return previous }
  const worker = new DependencyBackground(log); workers.set(stateDir, worker); return worker
}
