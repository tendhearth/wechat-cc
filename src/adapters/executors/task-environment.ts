import { realpathSync } from 'node:fs'
import { mkdirAnchored } from '../workbench/anchored-fs'

/** Every task owns its temporary files and package cache inside its workspace.
 * Never follow repository-controlled symlinks while creating these directories. */
export function taskEnvironment(workspace: string, taskId: string): Record<string, string> {
  if (!/^[a-f0-9]{8}$/.test(taskId)) throw new Error('invalid_task_environment')
  // Managed-workspace tests intentionally reject .cc-workbench ancestors. Keep
  // runtime scratch under an ignored package cache so those tests can run too.
  const root = realpathSync(workspace)
  const tmp = mkdirAnchored(root, ['node_modules', '.cache', 'cc-tasks', taskId, 'tmp'], 'invalid_task_environment')
  const cache = mkdirAnchored(root, ['node_modules', '.cache', 'cc-tasks', taskId, 'cache'], 'invalid_task_environment')
  return { TMPDIR: tmp, TEMP: tmp, TMP: tmp, BUN_TMPDIR: tmp, BUN_INSTALL_CACHE_DIR: cache, npm_config_cache: cache, GIT_CEILING_DIRECTORIES: tmp }
}
