import { existsSync } from 'node:fs'
import { resolveJobspawn } from '../../lib/jobspawn'
import { spawn } from 'node:child_process'
import { realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { findOnPath } from '../../lib/util'
import type { Preparation } from './worktree-preparation'

/** CC owns cwd and every input. Never run lifecycle scripts or task config. */
export async function installDependencies(cwd: string, budget: Preparation): Promise<void> {
  budget.check()
  const found = findOnPath('bun')
  if (!found) throw Error('dependency_installer_unavailable')
  const binary = await realpath(found)
  await writeFile(join(cwd, '.cc-install.toml'), '', { flag: 'wx', mode: 0o600 })
  const env: NodeJS.ProcessEnv = { HOME: cwd, USERPROFILE: cwd, TMPDIR: cwd, TEMP: cwd, TMP: cwd,
    BUN_INSTALL_CACHE_DIR: join(cwd, '.cc-install-cache'), PATH: process.env.PATH,
    // Preserve the host's network guard, never task-provided settings/preloads.
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(https?_proxy|all_proxy|no_proxy|SystemRoot|WINDIR)$/i.test(key))) }
  const tree=resolveJobspawn({platform:process.platform,arch:process.arch,execPath:process.execPath,env:process.env,exists:existsSync})
  if(tree.kind==='missing')throw Error('worktree_process_tree_unavailable')
  const args = ['install', '--frozen-lockfile', '--ignore-scripts', '--no-cache', '--backend=copyfile', '--config='+join(cwd, '.cc-install.toml')]
  return new Promise<void>((accept, reject) => {
    const child=spawn(tree.kind==='found'?tree.path:binary,tree.kind==='found'?['--require-job',binary,...args]:args, {
      cwd, env, detached: process.platform !== 'win32', windowsHide: true, stdio: 'ignore',
    })
    let failure: Error | undefined
    const kill = (error: Error) => {
      failure ??= error
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL') } catch { /* reaped */ }
    }
    const abort = () => kill(Error('worktree_preparation_cancelled'))
    const timer = setTimeout(() => kill(Error('worktree_preparation_timeout')), Math.max(1, budget.deadline - Date.now()))
    budget.options.signal?.addEventListener('abort', abort, { once: true })
    const finish = (error?: Error) => { clearTimeout(timer); budget.options.signal?.removeEventListener('abort', abort); if (error) reject(error); else accept() }
    child.on('error', error => finish(error))
    child.on('close', code => {
      // A successful Bun may leave an unexpected descendant. POSIX groups and
      // Windows KILL_ON_JOB_CLOSE are drained before staging is inspected.
      if(process.platform!=='win32'&&child.pid)try{process.kill(-child.pid,'SIGKILL')}catch{}
      finish(failure ?? (code === 0 ? undefined : Error('dependency_install_failed')))
    })
    if (budget.options.signal?.aborted) abort()
  })
}
