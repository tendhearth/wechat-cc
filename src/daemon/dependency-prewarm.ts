import { cpus, loadavg } from 'node:os'
import type { Db } from '../lib/db'
import { recentDependencyProjects } from '../adapters/store/workbench/store'
import { repoRootOrFailAsync } from '../adapters/git/worktree-workspaces'
import { Preparation } from '../adapters/git/worktree-preparation'
import { prewarmWorkspaceDependencies } from '../adapters/git/worktree-dependency-cache'
import { startDependencyBackground } from '../adapters/git/worktree-dependency-background'

/** Started at daemon ready, delayed until idle; no fetch or owner dependency copy. */
export function makeDependencyPrewarm(deps: { stateDir: string; db: Db; idle: () => boolean; log: (tag: string, line: string) => void; sampleLoad?: () => { load: number; cores: number } }) {
  const worker = startDependencyBackground(deps.stateDir, line => deps.log('DEPENDENCIES', line))
  const controller = new AbortController()
  let candidates: string[] | undefined, running: Promise<void> | undefined
  const seen = new Set<string>()
  const allowed = () => {
    const sample = deps.sampleLoad?.() ?? { load: loadavg()[0]!, cores: cpus().length }
    return deps.idle() && Number.isFinite(sample.load) && sample.cores > 0 && sample.load < sample.cores * 1.5
  }
  const run = async () => {
    // Do not queue a warmup behind an install with a stale idle/load verdict.
    await worker.drain()
    if (controller.signal.aborted || !allowed()) return
    candidates ??= recentDependencyProjects(deps.db, Date.now() - 14 * 24 * 60 * 60_000)
    while (candidates.length && !controller.signal.aborted && allowed()) {
      const path = candidates.shift()!
      try {
        const budget = new Preparation({ signal: controller.signal, timeoutMs: 30_000 })
        const root = await repoRootOrFailAsync(path, budget.options)
        if (!root || seen.has(root)) continue
        seen.add(root)
        let sha: string
        try { sha = (await budget.git(root, ['rev-parse','--verify','refs/remotes/origin/dev^{commit}'])).trim() }
        catch { budget.check(); sha = (await budget.git(root, ['rev-parse','--verify','HEAD^{commit}'])).trim() }
        if (!allowed()) { seen.delete(root); candidates.unshift(path); return }
        const warmed = await prewarmWorkspaceDependencies(root, deps.stateDir, { baseSha: sha, signal: controller.signal, timeoutMs: budget.deadline - Date.now() }, allowed)
        if (!warmed) { seen.delete(root); candidates.unshift(path); return }
        await worker.drain()
      } catch (error) { deps.log('DEPENDENCIES', `prewarm failed: ${error instanceof Error ? error.message : String(error)}`) }
    }
  }
  return {
    tick(): Promise<void> {
      if (controller.signal.aborted) return Promise.resolve()
      if (!running) running = run().catch(error => deps.log('DEPENDENCIES', `prewarm failed: ${error instanceof Error ? error.message : String(error)}`)).finally(() => { running = undefined })
      return running
    },
    async stop(): Promise<void> { controller.abort(); await worker.stop(); await running },
  }
}
