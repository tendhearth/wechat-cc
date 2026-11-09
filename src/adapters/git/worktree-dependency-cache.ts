import { createHash, randomBytes } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path'
import { copyWorkspaceDependencies, DEPENDENCY_LOCKS, DEPENDENCY_NOTICE, readPreparationFile, samePreparationMetadata, type DependencyOptions } from './worktree-dependencies'
import { Preparation } from './worktree-preparation'
import { dependencyInstallPlan, dependencySafePart } from './worktree-dependency-policy'
import { installDependencies } from './worktree-dependency-installer'
import { mkdirAnchored, verifyFromFilesystemRoot } from '../workbench/anchored-fs'

export interface DependencyCacheOptions extends DependencyOptions { baseSha?: string; maxCacheBytes?: number; canPublish?: () => boolean }
const MAX_CACHE_BYTES = 4 * 1024 ** 3
// Bind both the completion receipt and its location to the archive policy.
// Old entries must neither restore unvalidated trees nor block a new publish.
const CACHE_POLICY = 'committed-public-registry-portable-v2'
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
const metadataName = (path: string) => /(?:^|\/)(?:package\.json|bun\.lockb?|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(path) || ['.npmrc','bunfig.toml'].includes(path)
/** Immutable task origin only; checkout bytes are comparison inputs, never installer inputs. */
async function metadata(root: string, budget: Preparation, baseSha?: string) {
  if (!baseSha || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseSha)) throw Error('dependency_origin_missing')
  const tree = (await budget.git(root, ['ls-tree', '-r', '-z', '--full-tree', baseSha])).split('\0').filter(Boolean)
  const blobs = new Map<string, string>()
  for (const row of tree) {
    const match = /^(\d+) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(row)
    if (!match || !metadataName(match[3]!)) continue
    if (!['100644','100755'].includes(match[1]!)) throw Error('unsafe_preparation_file')
    if (match[3]!.split('/').some(p => !dependencySafePart(p))) throw Error('unsafe_preparation_file')
    blobs.set(match[3]!, match[2]!)
  }
  const paths = new Set(blobs.keys())
  for (const path of [...paths].filter(p => p === 'package.json' || p.endsWith('/package.json'))) {
    let dir = dirname(path)
    for (;;) { for (const name of DEPENDENCY_LOCKS) paths.add(join(dir, name)); if (dir === '.') break; dir = dirname(dir) }
  }
  const files = new Map<string, Buffer>(), records: string[] = [], locks: string[] = []
  let bytes = 0
  for (const path of [...paths].sort()) {
    budget.check()
    const value = blobs.has(path) ? Buffer.from(await budget.git(root, ['cat-file', 'blob', blobs.get(path)!])) : null
    if (value && (value.length > 8 * 1024 ** 2 || (bytes += value.length) > 32 * 1024 ** 2)) throw Error('preparation_metadata_budget')
    records.push(`${path}\0${value === null ? 'missing' : hash(value)}`)
    if (value !== null) { files.set(path, value); if (DEPENDENCY_LOCKS.includes(path.split(/[\\/]/).at(-1)!)) locks.push(`${path}\0${hash(value)}`) }
  }
  return { paths: [...paths].sort(), files, key: locks.length ? `${hash(locks.join('\0'))}-${hash(records.join('\0'))}` : null }
}
async function unchanged(root: string, expected: Awaited<ReturnType<typeof metadata>>, budget: Preparation): Promise<boolean> {
  const paths = new Set([...expected.paths, ...(await budget.git(root, ['ls-files','-z','--cached','--others','--exclude-standard'])).split('\0').filter(p => metadataName(p) && !['.npmrc','bunfig.toml'].includes(p))])
  for (const path of paths) {
    budget.check()
    const current = await readPreparationFile(root, path, 8 * 1024 ** 2), original = expected.files.get(path)
    if (original ? !current || !samePreparationMetadata(path, original, current) : current !== null) return false
  }
  return true
}
async function cacheRoot(stateDir: string) {
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 })
  const state = await fs.realpath(stateDir); verifyFromFilesystemRoot(state, 'unsafe_dependency_cache')
  return mkdirAnchored(state, ['dependency-cache', 'v2'], 'unsafe_dependency_cache')
}
async function scope(root: string, budget: Preparation) {
  const common = await fs.realpath(resolve(root, (await budget.git(root, ['rev-parse', '--git-common-dir'])).trim()))
  return hash(`${common}\0${process.platform}\0${process.arch}\0${process.versions.modules}\0${CACHE_POLICY}`)
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
      if (dead) { await fs.rm(path, { recursive: true, force: true }); await fs.rm(path + '.owner.json', { force: true }); continue }
      incoming += await sizeOf(path, budget)
      continue
    }
    entries.push({ path, bytes: await sizeOf(path, budget), used: stat.mtimeMs })
  }
  let total = incoming + entries.reduce((sum, entry) => sum + entry.bytes, 0)
  for (const entry of entries.sort((a, b) => a.used - b.used)) { if (total <= limit) break; budget.check(); await fs.rm(entry.path, { recursive: true, force: true }); total -= entry.bytes }
  if (total > limit) throw Error('dependency_cache_budget')
}
const completion = (key: string) => JSON.stringify({ key, installer: 'cc-registry', frozen: true, scripts: false, version: 2, sourcePolicy: CACHE_POLICY })
function supportsCleanInstall(files: Map<string, Buffer>): boolean {
  try { dependencyInstallPlan(files); return true } catch { return false }
}
/** Journal precedes mkdir: a crash can never leave an unrecorded new stage. */
async function createStage(root: string): Promise<string> {
  const path = join(root, '.stage-' + randomBytes(3).toString('hex'))
  const journal = path + '.owner.json'
  await fs.writeFile(journal, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 })
  let created = false
  try {
    await fs.mkdir(path, { mode: 0o700 }); created = true
    await fs.writeFile(join(path, '.owner.json'), JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 })
    return path
  } catch (error) { if (created) await fs.rm(path, { recursive: true, force: true }); await fs.rm(journal, { force: true }); throw error }
}
/** Startup and preparation share the same lock. Only dead, recorded owners are reclaimed. */
export async function recoverDependencyStages(stateDir: string): Promise<void> {
  const budget = new Preparation({ timeoutMs: 15_000 })
  await serial(stateDir, budget, async () => {
    const root = await cacheRoot(stateDir)
    const directory = await fs.opendir(root)
    for await (const entry of directory) {
      const match = /^(\.stage-[a-f0-9]{6})\.owner\.json$/.exec(entry.name)
      if (!match || !entry.isFile()) continue
      budget.check()
      try {
        const owner = JSON.parse((await readPreparationFile(root, entry.name, 1024))!.toString())
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) continue
        try { process.kill(owner.pid, 0); continue } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') continue }
        await fs.rm(join(root, match[1]!), { recursive: true, force: true })
        await fs.unlink(join(root, entry.name))
      } catch { /* malformed/live records are never grounds to remove a directory */ }
    }
    await prune(root, MAX_CACHE_BYTES, budget)
  })
}
async function publish(source: string, stateDir: string, options: DependencyCacheOptions, budget: Preparation): Promise<void> {
  budget.check(); if (options.canPublish && !options.canPublish()) return
  const before = await metadata(source, budget, options.baseSha)
  if (!before.key || !supportsCleanInstall(before.files) || !await unchanged(source, before, budget)) return
  const root = await cacheRoot(stateDir), key = `${await scope(source, budget)}-${before.key}`, entry = join(root, key)
  const rel = relative(source, root)
  if (!rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))) throw Error('unsafe_dependency_cache')
  if (await readPreparationFile(entry, '.complete.json', 1024).then(v => v?.toString() === completion(key), () => false)) {
    const now = new Date(); await fs.utimes(entry, now, now); await prune(root, options.maxCacheBytes ?? MAX_CACHE_BYTES, budget); return
  }
  await prune(root, options.maxCacheBytes ?? MAX_CACHE_BYTES, budget)
  const metadataBytes = [...before.files.values()].reduce((sum, value) => sum + value.length, 0)
  const limit = options.maxCacheBytes ?? MAX_CACHE_BYTES
  if (metadataBytes * 2 > limit || metadataBytes > (options.maxBytes ?? 1024 ** 3) || [...before.files.keys()].reduce((n, path) => n + path.split('/').length, 0) * 2 > (options.maxEntries ?? 100_000)) return
  const disk = await fs.statfs(root)
  if (Number(disk.bavail) * Number(disk.bsize) < metadataBytes * 2 + (options.minFreeBytes ?? 64 * 1024 ** 2)) return
  let stage: string | undefined, snapshot: string | undefined
  try {
    stage = await createStage(root)
    snapshot = await createStage(root)
    // Only committed input bytes enter staging; configs are parsed as data.
    for (const [path, value] of before.files) {
      budget.check(); await fs.mkdir(dirname(join(stage, path)), { recursive: true }); await fs.writeFile(join(stage, path), value, { flag: 'wx', mode: 0o600 })
      await fs.mkdir(dirname(join(snapshot, path)), { recursive: true }); await fs.writeFile(join(snapshot, path), value, { flag: 'wx', mode: 0o600 })
    }
    await installDependencies(stage, budget, before.files, options, options.maxCacheBytes ?? MAX_CACHE_BYTES)
    budget.check()
    for (const [path, value] of before.files) if (!(await readPreparationFile(stage, path, value.length))?.equals(value)) return
    if (!await unchanged(source, before, budget) || (options.canPublish && !options.canPublish())) return
    const notices = await copyWorkspaceDependencies(stage, snapshot, { ...options, metadataPaths: before.paths, snapshotWorkspaceLinks: true, timeoutMs: budget.deadline - Date.now() })
    if (notices.includes(DEPENDENCY_NOTICE) || !await installed(snapshot, before.paths)) return
    await fs.writeFile(join(snapshot, '.complete.json'), completion(key), { flag: 'wx', mode: 0o600 })
    const bytes = await sizeOf(snapshot, budget)
    if (bytes > limit) return
    // No writer remains; staging is outside every task's writable roots.
    await fs.rm(stage, { recursive: true, force: true })
    await prune(root, limit, budget, bytes, snapshot)
    budget.check(); if (options.canPublish && !options.canPublish()) return
    await fs.rename(snapshot, entry)
    // The owner survives the rename. No ownerless publication window exists.
    await fs.unlink(join(entry, '.owner.json'))
  } finally {
    if (stage) { await fs.rm(stage, { recursive: true, force: true }); await fs.rm(stage + '.owner.json', { force: true }) }
    if (snapshot) { await fs.rm(snapshot, { recursive: true, force: true }); await fs.rm(snapshot + '.owner.json', { force: true }) }
  }
}
/** CC installs from frozen metadata; task installations are NEVER promoted. */
export async function cacheWorkspaceDependencies(source: string, stateDir: string, options: DependencyCacheOptions = {}): Promise<void> {
  const budget = new Preparation({ ...options, timeoutMs: options.timeoutMs ?? 15_000 })
  await serial(stateDir, budget, async () => {
    try { await publish(await fs.realpath(source), stateDir, options, budget) }
    catch { if (options.signal?.aborted) throw Error('worktree_preparation_cancelled') }
  })
}
/** Only the owner checkout or a completed CC installation may supply dependencies. */
export async function restoreWorkspaceDependencies(repoRoot: string, target: string, stateDir: string, options: DependencyCacheOptions = {}): Promise<string[]> {
  const budget = new Preparation({ ...options, timeoutMs: options.timeoutMs ?? 15_000 })
  return serial(stateDir, budget, async () => {
    try {
      repoRoot = await fs.realpath(repoRoot); target = await fs.realpath(target)
      const expected = await metadata(target, budget, options.baseSha)
      if (!await unchanged(target, expected, budget)) return [DEPENDENCY_NOTICE]
      if (!expected.paths.some(p => p === 'package.json' || p.endsWith('/package.json'))) return []
      // Preserve #883's direct fast path and copy accounting when the owner's
      // checkout already has the exact metadata and a usable installation.
      if (await installed(repoRoot, expected.paths)) {
        const notices = await copyWorkspaceDependencies(repoRoot, target, { ...options, timeoutMs: budget.deadline - Date.now() })
        if (!notices.includes(DEPENDENCY_NOTICE) && await installed(target, expected.paths)) return notices
      }
      if (!supportsCleanInstall(expected.files)) return [DEPENDENCY_NOTICE]
      const namespace = await scope(repoRoot, budget)
      try {
        const root = await cacheRoot(stateDir)
        await prune(root, options.maxCacheBytes ?? MAX_CACHE_BYTES, budget)
        const entry = expected.key ? join(root, `${namespace}-${expected.key}`) : null
        if (entry && await readPreparationFile(entry, '.complete.json', 1024).then(v => v?.toString() === completion(`${namespace}-${expected.key}`), () => false)) {
          const notices = await copyWorkspaceDependencies(entry, target, { ...options, metadataPaths: expected.paths, timeoutMs: budget.deadline - Date.now() })
          if (!notices.includes(DEPENDENCY_NOTICE) && await installed(target, expected.paths)) { const now = new Date(); await fs.utimes(entry, now, now); return notices }
        }
        // A miss can install only in supervisor-owned clean staging. Sibling
        // tasks are never candidates, even if they forge a completion marker.
        await publish(target, stateDir, options, budget)
        if (entry && await readPreparationFile(entry, '.complete.json', 1024).then(v => v?.toString() === completion(`${namespace}-${expected.key}`), () => false)) {
          const notices = await copyWorkspaceDependencies(entry, target, { ...options, metadataPaths: expected.paths, timeoutMs: budget.deadline - Date.now() })
          if (!notices.includes(DEPENDENCY_NOTICE) && await installed(target, expected.paths)) return notices
        }
      } catch { budget.check() /* Cache/install unavailable: preserve the locked-install notice. */ }
      return [DEPENDENCY_NOTICE]
    } catch { if (options.signal?.aborted) throw Error('worktree_preparation_cancelled'); return [DEPENDENCY_NOTICE] }
  })
}
