import { cacheWorkspaceDependencies } from '../../../adapters/git/worktree-dependency-cache'
import type { ServiceCtx } from './ctx'
import { trackPreparation } from './state'

/** Revalidate the same quiet/closed boundary after queueing and before publish. */
export async function publishTaskDependencies(ctx: ServiceCtx, id: string, canPublish: () => boolean): Promise<void> {
  try {
    if (ctx.state.stopping || !canPublish()) return
    const wt = ctx.store.worktrees.get(id)
    if (!wt || wt.removedAt !== null) return
    await trackPreparation(ctx.state, cacheWorkspaceDependencies(wt.root, ctx.stateDir, {
      signal: ctx.state.preparationAbort.signal, canPublish: () => !ctx.state.stopping && canPublish(),
    }))
  } catch { /* Cache misses and bookkeeping failures never alter the task result. */ }
}
