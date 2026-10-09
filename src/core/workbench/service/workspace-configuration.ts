import { validateIsolatedConfiguration } from '../isolated-configuration'
import type { StoredTask } from '../store'
import type { ServiceCtx } from './ctx'

/** A new executor inherits the directory, but must pass its own configuration admission. */
export async function validateWorkspaceProvider(ctx: ServiceCtx, task: StoredTask, providerId: string): Promise<void> {
  if (!task.gitWorkspaceId) return
  const workspace = ctx.store.gitWorkspaces.get(task.gitWorkspaceId)
  if (!workspace || workspace.status !== 'ready' || workspace.executionPath !== task.path) throw Error('git_workspace_needs_recovery')
  await validateIsolatedConfiguration({ sourcePath: workspace.sourcePath, executionPath: workspace.executionPath, providerId }, ctx.deps.isolatedConfiguration)
  const current = ctx.store.gitWorkspaces.get(workspace.id), live = ctx.store.get(task.id)
  if (JSON.stringify(current) !== JSON.stringify(workspace) || live.gitWorkspaceId !== workspace.id || live.path !== task.path) throw Error('git_workspace_changed')
}
