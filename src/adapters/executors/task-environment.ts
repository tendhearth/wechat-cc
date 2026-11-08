import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { mkdirAnchored, verifyChain } from '../workbench/anchored-fs'
import { Preparation, type PreparationOptions } from '../git/worktree-preparation'

export const TASK_RUNTIME_DIRECTORY = '.cc-tasks'
/** Every task owns ignored scratch outside package-manager installations. */
export async function taskEnvironment(workspace: string, taskId: string, options: PreparationOptions = {}): Promise<Record<string, string>> {
  if (!/^[a-f0-9]{8}$/.test(taskId)) throw new Error('invalid_task_environment')
  const root = realpathSync(workspace)
  const budget = new Preparation({ ...options, timeoutMs: options.timeoutMs ?? 5000 })
  try {
    const tracked = await budget.git(root, ['ls-files','-z','--',`:(icase,glob)**/${TASK_RUNTIME_DIRECTORY}/**`])
    if (tracked) throw Error('invalid_task_environment')
  } catch (e) {
    // Managed workspaces need not be Git repositories. All other failures are closed.
    if (!/not a git repository/i.test(String((e as {detail?:string}).detail ?? ''))) throw e
  }
  budget.check()
  const runtime = mkdirAnchored(root, [TASK_RUNTIME_DIRECTORY], 'invalid_task_environment')
  const ignore = join(runtime, '.gitignore')
  let fd: number
  try { fd = openSync(ignore, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); try { writeSync(fd, '*\n') } finally { closeSync(fd) } }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw Error('invalid_task_environment') }
  verifyChain(root, [TASK_RUNTIME_DIRECTORY, '.gitignore'], 'invalid_task_environment')
  fd = openSync(ignore, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd), bytes = Buffer.alloc(3)
    if (!stat.isFile() || stat.size !== 2 || readSync(fd, bytes, 0, 3, null) !== 2 || bytes.subarray(0,2).toString() !== '*\n') throw Error('invalid_task_environment')
  } finally { closeSync(fd) }
  const tmp = mkdirAnchored(root, [TASK_RUNTIME_DIRECTORY, taskId, 'tmp'], 'invalid_task_environment')
  const cache = mkdirAnchored(root, [TASK_RUNTIME_DIRECTORY, taskId, 'cache'], 'invalid_task_environment')
  return { TMPDIR: tmp, TEMP: tmp, TMP: tmp, BUN_TMPDIR: tmp, BUN_INSTALL_CACHE_DIR: cache, npm_config_cache: cache, GIT_CEILING_DIRECTORIES: tmp }
}
