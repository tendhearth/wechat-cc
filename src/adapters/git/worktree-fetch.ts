import * as fs from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import { Preparation, type PreparationOptions } from './worktree-preparation'

export interface FetchOptions extends PreparationOptions { maxFetchBytes?: number; fetchTimeoutMs?: number }
const fetches = new Map<string, Promise<void>>()

/** Worktrees share objects. A failed fetch must finish rollback before another
 * fetch can negotiate using objects it is about to remove. Queue time is bounded. */
async function fetchTurn<T>(objects: string, budget: Preparation, operation: () => Promise<T>): Promise<T> {
  const previous = fetches.get(objects) ?? Promise.resolve()
  let release!: () => void
  const turn = new Promise<void>(resolve => { release = resolve })
  const queued = previous.then(() => turn)
  fetches.set(objects, queued)
  let timer: ReturnType<typeof setTimeout> | undefined
  const abort = () => rejectWait?.(Error('worktree_preparation_cancelled'))
  let rejectWait: ((error: Error) => void) | undefined
  try {
    await Promise.race([previous, new Promise<never>((_resolve, reject) => {
      rejectWait = reject
      timer = setTimeout(() => reject(Error('worktree_preparation_timeout')), Math.max(0, budget.deadline - Date.now()))
      budget.options.signal?.addEventListener('abort', abort, { once: true })
      if (budget.options.signal?.aborted) abort()
    })])
    clearTimeout(timer); budget.options.signal?.removeEventListener('abort', abort)
    budget.check()
    return await operation()
  } finally {
    clearTimeout(timer); budget.options.signal?.removeEventListener('abort', abort)
    release()
    void queued.then(() => { if (fetches.get(objects) === queued) fetches.delete(objects) })
  }
}
/** Fetch into private objects and remote-tracking refs. Publish only after checking budgets.
 * Explicit refspec + empty refmap ignore even a force-to-refs/heads repository configuration. */
export async function refreshWorktreeRemotes(repo: string, options: FetchOptions = {}): Promise<void> {
  const controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  const budget = new Preparation({ signal, timeoutMs: options.fetchTimeoutMs ?? Math.min(10_000, (options.timeoutMs ?? 30_000) / 2) })
  const objects = await fs.realpath(resolve(repo, (await budget.git(repo, ['rev-parse', '--git-path', 'objects'])).trim()))
  return fetchTurn(objects, budget, () => fetchRemotes(repo, objects, budget, controller, options))
}

async function fetchRemotes(repo: string, objects: string, budget: Preparation, controller: AbortController, options: FetchOptions): Promise<void> {
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
  let keepStage = false, published = false, updatingRefs = false
  const installed: string[] = []
  const intended = new Map<string, string>(), original = new Map<string, string>()
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
    const updates = refs.map(line => {
      const [ref, sha] = line.split(' ')
      if (!ref?.startsWith(prefix) || !/^[0-9a-f]{40,64}$/.test(sha ?? '') || isAbsolute(ref)) throw Error('unsafe_fetch_ref')
      intended.set(`refs/remotes/${ref.slice(prefix.length)}`, sha!)
      return `update refs/remotes/${ref.slice(prefix.length)} ${sha}\ndelete ${ref}`
    })
    for (const line of (await budget.git(repo, ['for-each-ref','--format=%(refname) %(objectname)','refs/remotes/'])).trim().split('\n')) {
      const [ref, sha] = line.split(' ')
      if (ref && sha && intended.has(ref)) original.set(ref, sha)
    }
    // Preflight the entire set before publishing anything. Partial clones need
    // their .promisor markers, including when the fetch contains only commits.
    const pack = join(stage, 'pack')
    const names = await fs.readdir(pack).catch(e => { if (e.code === 'ENOENT') return []; throw e })
    const files = new Set(names)
    for (const name of names) {
      budget.check()
      const match = /^(pack-[0-9a-f]{40}(?:[0-9a-f]{24})?)\.(pack|idx|rev|keep|promisor)$/.exec(name)
      if (!match || !(await fs.lstat(join(pack, name))).isFile() || !files.has(`${match[1]}.pack`) || !files.has(`${match[1]}.idx`)) throw Error('unsafe_fetch_pack')
    }
    await fs.mkdir(join(objects, 'pack'), { recursive: true })
    // Publish markers/indexes first. Exclusive links never replace an existing
    // pack; rollback owns only the paths successfully created by this fetch.
    names.sort((a,b) => Number(a.endsWith('.pack')) - Number(b.endsWith('.pack')))
    for (const name of names) {
      budget.check()
      const destination = join(objects, 'pack', name)
      try { await fs.link(join(pack, name), destination); installed.push(destination) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
    if (updates.length) {
      updatingRefs = true
      await budget.git(repo, ['update-ref','--no-deref','--stdin'], `start\n${updates.join('\n')}\nprepare\ncommit\n`)
    }
    published = true
  } finally {
    clearInterval(timer)
    while (monitoring) await new Promise(r => setTimeout(r, 1))
    // An aborted fetch may already have installed temporary refs. Never leave dangling refs.
    const cleanup = new Preparation({ timeoutMs: 5000 })
    try {
      const refs = (await cleanup.git(repo, ['for-each-ref','--format=%(refname)',prefix], undefined, env)).trim().split('\n').filter(Boolean)
      // A deadline can race successful commit, or interrupt the files backend
      // between individual ref writes. Preserve any objects already referenced.
      if (updatingRefs && !refs.length) published = true
      if (updatingRefs && !published) {
        const current = await cleanup.git(repo, ['for-each-ref','--format=%(refname) %(objectname)','refs/remotes/'], undefined, env)
        for (const line of current.trim().split('\n')) {
          const [ref, sha] = line.split(' ')
          if (ref && sha && intended.get(ref) === sha && original.get(ref) !== sha) published = true
        }
      }
      if (refs.length) await cleanup.git(repo, ['update-ref','--no-deref','--stdin'], refs.map(ref => `delete ${ref}`).join('\n') + '\n', env)
    } catch { keepStage = true }
    if (!published && !keepStage) for (const path of installed.reverse()) await fs.unlink(path)
    if (!keepStage) await fs.rm(stage, { recursive: true, force: true })
  }
}
