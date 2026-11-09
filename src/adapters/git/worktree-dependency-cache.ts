import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { copyWorkspaceDependencies, DEPENDENCY_LOCKS, DEPENDENCY_NOTICE, readPreparationFile, type DependencyOptions } from './worktree-dependencies'
import { Preparation } from './worktree-preparation'
import { mkdirAnchored, verifyFromFilesystemRoot } from '../workbench/anchored-fs'

export interface DependencyCacheOptions extends DependencyOptions { maxCacheBytes?: number; maxCandidates?: number; canPublish?: () => boolean }
const MAX_CACHE_BYTES = 4 * 1024 ** 3
const operations = new Map<string, Promise<unknown>>()
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const installed = async (root: string, paths: string[]) => {
  for (const path of paths.filter(p => p === 'package.json' || p.endsWith('/package.json'))) {
    const stat = await fs.lstat(join(root, dirname(path), 'node_modules')).catch(() => null)
    if (stat?.isDirectory() && !stat.isSymbolicLink()) return true
  }
  return false
}
async function serial<T>(stateDir: string, budget: Preparation, fn: () => Promise<T>): Promise<T> {
  const previous = operations.get(stateDir) ?? Promise.resolve()
  let started = false
  const pending = previous.catch(() => {}).then(() => { budget.check(); started = true; return fn() }); operations.set(stateDir, pending)
  return new Promise<T>((resolve, reject) => {
    const signal = budget.options.signal
    const clear = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
    // Queued work can reject immediately. Active work must finish its owned
    // stage cleanup before shutdown considers this preparation drained.
    const abort = () => { if (!started) { clear(); reject(Error('worktree_preparation_cancelled')) } }
    const timer = setTimeout(() => { if (!started) { clear(); reject(Error('worktree_preparation_timeout')) } }, Math.max(0, budget.deadline - Date.now()))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    pending.then(value => { clear(); resolve(value) }, error => { clear(); reject(error) }).finally(() => { if (operations.get(stateDir) === pending) operations.delete(stateDir) })
  })
}
/** Sorted full metadata set, bounded reads, including untracked ancestor locks. */
async function metadata(root: string, budget: Preparation) {
  const names = ['package.json', '**/package.json', ...DEPENDENCY_LOCKS.flatMap(name => [name, `**/${name}`])]
  const paths = new Set((await budget.git(root, ['ls-files', '-z', '--', ...names])).split('\0').filter(Boolean))
  for (const path of [...paths].filter(p => p === 'package.json' || p.endsWith('/package.json'))) {
    let dir = dirname(path)
    for (;;) { for (const name of DEPENDENCY_LOCKS) paths.add(join(dir, name)); if (dir === '.') break; dir = dirname(dir) }
  }
  const files = new Map<string, Buffer>(), records: string[] = [], locks: string[] = []
  let bytes = 0
  for (const path of [...paths].sort()) {
    budget.check()
    const value = await readPreparationFile(root, path, Math.min(8 * 1024 ** 2, 32 * 1024 ** 2 - bytes))
    records.push(`${path}\0${value === null ? 'missing' : hash(value)}`)
    if (value !== null) { files.set(path, value); bytes += value.length; if (DEPENDENCY_LOCKS.includes(path.split(/[\\/]/).at(-1)!)) locks.push(`${path}\0${hash(value)}`) }
  }
  return { paths: [...paths].sort(), files, key: locks.length ? `${hash(locks.join('\0'))}-${hash(records.join('\0'))}` : null }
}
async function cacheRoot(stateDir: string) {
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 })
  const state = await fs.realpath(stateDir); verifyFromFilesystemRoot(state, 'unsafe_dependency_cache')
  return mkdirAnchored(state, ['dependency-cache', 'v1'], 'unsafe_dependency_cache')
}
async function scope(root: string, budget: Preparation) {
  const common = await fs.realpath(resolve(root, (await budget.git(root, ['rev-parse', '--git-common-dir'])).trim()))
  return hash(`${common}\0${process.platform}\0${process.arch}\0${process.versions.modules}`)
}
async function sizeOf(root: string, budget: Preparation): Promise<number> {
  let bytes = 0, entries = 0
  const visit = async (path: string) => {
    budget.check(); if (++entries > 100_000) throw Error('dependency_entry_budget')
    const stat = await fs.lstat(path)
    if (stat.isFile()) bytes += stat.size
    else if (stat.isDirectory()) { const dir = await fs.opendir(path); for await (const entry of dir) await visit(join(path, entry.name)) }
    else if (!stat.isSymbolicLink()) throw Error('unsafe_dependency_cache')
  }
  await visit(root); return bytes
}
async function prune(root: string, limit: number, budget: Preparation, incoming = 0, currentStage?: string) {
  const entries: { path: string; bytes: number; used: number }[] = []
  const directory = await fs.opendir(root)
  for await (const dirent of directory) {
    budget.check()
    const stage = /^\.stage-[A-Za-z0-9]{6}$/.test(dirent.name)
    if ((!stage && !/^[a-f0-9]{64}-[a-f0-9]{64}-[a-f0-9]{64}$/.test(dirent.name)) || !dirent.isDirectory()) continue
    const path = join(root, dirent.name), stat = await fs.lstat(path)
    if (path === currentStage) continue
    if (stage) {
      let dead = false
      try {
        const owner = JSON.parse((await readPreparationFile(path, '.owner.json', 1024))!.toString())
        if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0) } catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH' }
        }
      } catch { /* Unknown/live owner: count its bytes, never remove it. */ }
      if (dead) { await fs.rm(path, { recursive: true, force: true }); continue }
      incoming += await sizeOf(path, budget)
      continue
    }
    entries.push({ path, bytes: await sizeOf(path, budget), used: stat.mtimeMs })
  }
  let total = incoming + entries.reduce((sum, entry) => sum + entry.bytes, 0)
  for (const entry of entries.sort((a, b) => a.used - b.used)) { if (total <= limit) break; budget.check(); await fs.rm(entry.path, { recursive: true, force: true }); total -= entry.bytes }
  if (total > limit) throw Error('dependency_cache_budget')
}
async function publish(source: string, stateDir: string, options: DependencyCacheOptions, budget: Preparation): Promise<void> {
  budget.check(); if (options.canPublish && !options.canPublish()) return
  const before = await metadata(source, budget)
  if (!before.key || !await installed(source, before.paths)) return
  const root = await cacheRoot(stateDir), key = `${await scope(source, budget)}-${before.key}`, entry = join(root, key)
  if (await fs.lstat(entry).then(s => s.isDirectory() && !s.isSymbolicLink(), () => false)) { const now = new Date(); await fs.utimes(entry, now, now); await prune(root, options.maxCacheBytes ?? MAX_CACHE_BYTES, budget); return }
  await prune(root, options.maxCacheBytes ?? MAX_CACHE_BYTES, budget)
  const stage = await fs.mkdtemp(join(root, '.stage-'))
  try {
    await fs.writeFile(join(stage, '.owner.json'), JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 })
    // Metadata and empty logical endpoints keep workspace/.bin links portable;
    // repository code itself always comes from the receiving checkout.
    for (const [path, value] of before.files) { budget.check(); await fs.mkdir(dirname(join(stage, path)), { recursive: true }); await fs.writeFile(join(stage, path), value, { flag: 'wx', mode: 0o600 }) }
    const notices = await copyWorkspaceDependencies(source, stage, { ...options, metadataPaths: before.paths, snapshotWorkspaceLinks: true, timeoutMs: budget.deadline - Date.now() })
    if (notices.includes(DEPENDENCY_NOTICE) || !await installed(stage, before.paths)) return
    if ((await metadata(source, budget)).key !== before.key || (options.canPublish && !options.canPublish())) return
    const bytes = await sizeOf(stage, budget), limit = options.maxCacheBytes ?? MAX_CACHE_BYTES
    if (bytes > limit) return
    await prune(root, limit, budget, bytes, stage)
    budget.check(); if (options.canPublish && !options.canPublish()) return
    await fs.rename(stage, entry)
    await fs.unlink(join(entry, '.owner.json'))
  } finally { await fs.rm(stage, { recursive: true, force: true }) }
}
/** Best effort snapshot, never executes a package manager or repository code. */
export async function cacheWorkspaceDependencies(source: string, stateDir: string, options: DependencyCacheOptions = {}): Promise<void> {
  const budget = new Preparation({ ...options, timeoutMs: options.timeoutMs ?? 15_000 })
  await serial(stateDir, budget, async () => {
    try { await publish(await fs.realpath(source), stateDir, options, budget) }
    catch { if (options.signal?.aborted) throw Error('worktree_preparation_cancelled') }
  })
}
/** Cache and same-repository candidates share the existing copy/link/space budgets. */
export async function restoreWorkspaceDependencies(repoRoot: string, target: string, stateDir: string, options: DependencyCacheOptions = {}): Promise<string[]> {
  const budget = new Preparation({ ...options, timeoutMs: options.timeoutMs ?? 15_000 })
  return serial(stateDir, budget, async () => {
    try {
      repoRoot = await fs.realpath(repoRoot); target = await fs.realpath(target)
      const expected = await metadata(target, budget)
      if (!expected.paths.some(p => p === 'package.json' || p.endsWith('/package.json'))) return []
      // Preserve #883's direct fast path and copy accounting when the owner's
      // checkout already has the exact metadata and a usable installation.
      if (await installed(repoRoot, expected.paths)) {
        const notices = await copyWorkspaceDependencies(repoRoot, target, { ...options, timeoutMs: budget.deadline - Date.now() })
        if (!notices.includes(DEPENDENCY_NOTICE) && await installed(target, expected.paths)) return notices
      }
      const namespace = await scope(repoRoot, budget)
      try {
        const root = await cacheRoot(stateDir)
        await prune(root, options.maxCacheBytes ?? MAX_CACHE_BYTES, budget)
        const entry = expected.key ? join(root, `${namespace}-${expected.key}`) : null
        if (entry && await fs.lstat(entry).then(s => s.isDirectory() && !s.isSymbolicLink(), () => false)) {
          const notices = await copyWorkspaceDependencies(entry, target, { ...options, metadataPaths: expected.paths, timeoutMs: budget.deadline - Date.now() })
          if (!notices.includes(DEPENDENCY_NOTICE) && await installed(target, expected.paths)) { const now = new Date(); await fs.utimes(entry, now, now); return notices }
        }
      } catch { budget.check() /* Optional cache cannot block another usable worktree. */ }
      const listing = await budget.git(repoRoot, ['worktree', 'list', '--porcelain', '-z'])
      const candidates = [repoRoot, ...listing.split('\0').filter(line => line.startsWith('worktree ')).map(line => line.slice(9))]
      for (const candidate of [...new Set(candidates)].slice(0, options.maxCandidates ?? 32)) {
        budget.check()
        try {
        const source = await fs.realpath(candidate).catch(() => null)
        if (!source || source === target || await scope(source, budget) !== namespace) continue
        const observed = await metadata(source, budget)
        if (observed.key !== expected.key || !await installed(source, observed.paths)) continue
        const notices = await copyWorkspaceDependencies(source, target, { ...options, timeoutMs: budget.deadline - Date.now() })
        // Only the lifecycle/setup boundary may publish a cache snapshot. A
        // discovered worktree may still have an installer/writer in flight.
        if (!notices.includes(DEPENDENCY_NOTICE) && await installed(target, expected.paths)) return notices
        } catch { budget.check() /* stale candidate; continue to the next worktree */ }
      }
      return [DEPENDENCY_NOTICE]
    } catch { if (options.signal?.aborted) throw Error('worktree_preparation_cancelled'); return [DEPENDENCY_NOTICE] }
  })
}
