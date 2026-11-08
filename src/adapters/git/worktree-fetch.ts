import * as fs from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import { Preparation, type PreparationOptions } from './worktree-preparation'

export interface FetchOptions extends PreparationOptions { maxFetchBytes?: number; fetchTimeoutMs?: number }
/** Fetch into private objects and remote-tracking refs. Publish only after checking budgets.
 * Explicit refspec + empty refmap ignore even a force-to-refs/heads repository configuration. */
export async function refreshWorktreeRemotes(repo: string, options: FetchOptions = {}): Promise<void> {
  const controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  const budget = new Preparation({ signal, timeoutMs: options.fetchTimeoutMs ?? Math.min(10_000, (options.timeoutMs ?? 30_000) / 2) })
  const objects = resolve(repo, (await budget.git(repo, ['rev-parse', '--git-path', 'objects'])).trim())
  const stage = await fs.mkdtemp(join(objects, 'cc-fetch-'))
  const prefix = `refs/remotes/cc-preparation-${randomBytes(12).toString('hex')}/`
  const env = { GIT_OBJECT_DIRECTORY: stage, GIT_ALTERNATE_OBJECT_DIRECTORIES: objects }
  let monitoring = false, bytes = 0, entries = 0, monitorError: unknown
  const checkSize = async (path = stage): Promise<void> => {
    budget.check()
    const dir = await fs.opendir(path).catch(e => { if(e.code==='ENOENT')return null;throw e })
    if(!dir)return
    for await (const file of dir) {
      if (++entries > 10_000) throw Error('fetch_entry_budget')
      const full = join(path, file.name), stat = await fs.lstat(full).catch(e => { if(e.code==='ENOENT')return null;throw e })
      if(!stat)continue
      if (stat.isDirectory()) await checkSize(full)
      else if (stat.isFile()) { bytes += stat.size; if (bytes > (options.maxFetchBytes ?? 256 * 1024 * 1024)) throw Error('fetch_byte_budget') }
      else throw Error('unsafe_fetch_object')
    }
  }
  const measure = async () => {
    if (monitoring) return
    monitoring = true
    try { bytes = 0; entries = 0; await checkSize() }
    catch (e) { monitorError = e; controller.abort() }
    finally { monitoring = false }
  }
  const timer = setInterval(() => { void measure() }, 25)
  let keepStage = false
  try {
    const remotes = (await budget.git(repo, ['remote'])).trim().split('\n').filter(Boolean)
    if (remotes.length > 32) throw Error('fetch_remote_budget')
    for (const remote of remotes) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(remote)) throw Error('unsafe_fetch_remote')
      // The repository may set remote.*.uploadpack/core.sshCommand/protocol helpers.
      await budget.git(repo, ['-c', 'fetch.unpackLimit=1', '-c', `remote.${remote}.uploadpack=git-upload-pack`,
        'fetch','--no-tags','--no-recurse-submodules','--no-write-fetch-head','--no-auto-maintenance','--refmap=',
        '--upload-pack=git-upload-pack', remote, `+refs/heads/*:${prefix}${remote}/*`], undefined, env)
    }
    clearInterval(timer)
    while (monitoring) await new Promise(r => setTimeout(r, 1))
    if (monitorError) throw monitorError
    bytes = 0; entries = 0; await checkSize()
    const refs = (await budget.git(repo, ['for-each-ref','--format=%(refname) %(objectname)',prefix], undefined, env)).trim().split('\n').filter(Boolean)
    // unpackLimit=1 keeps received objects in pack files. No repository code owns this directory.
    await fs.mkdir(join(objects, 'pack'), { recursive: true })
    const pack = join(stage, 'pack')
    for (const entry of await fs.readdir(pack).catch(e => { if (e.code === 'ENOENT') return []; throw e })) {
      budget.check()
      if (!/^pack-[0-9a-f]{40,64}\.(pack|idx|rev|keep)$/.test(entry)) throw Error('unsafe_fetch_pack')
      await fs.rename(join(pack, entry), join(objects, 'pack', entry))
    }
    const updates = refs.map(line => {
      const [ref, sha] = line.split(' ')
      if (!ref?.startsWith(prefix) || !/^[0-9a-f]{40,64}$/.test(sha ?? '') || isAbsolute(ref)) throw Error('unsafe_fetch_ref')
      return `update refs/remotes/${ref.slice(prefix.length)} ${sha}\ndelete ${ref}`
    })
    if (updates.length) await budget.git(repo, ['update-ref','--no-deref','--stdin'], `start\n${updates.join('\n')}\nprepare\ncommit\n`)
  } finally {
    clearInterval(timer)
    while (monitoring) await new Promise(r => setTimeout(r, 1))
    // An aborted fetch may already have installed temporary refs. Never leave dangling refs.
    const cleanup = new Preparation({ timeoutMs: 5000 })
    try {
      const refs = (await cleanup.git(repo, ['for-each-ref','--format=%(refname)',prefix], undefined, env)).trim().split('\n').filter(Boolean)
      if (refs.length) await cleanup.git(repo, ['update-ref','--no-deref','--stdin'], refs.map(ref => `delete ${ref}`).join('\n') + '\n', env)
    } catch { keepStage = true }
    if (!keepStage) await fs.rm(stage, { recursive: true, force: true })
  }
}
