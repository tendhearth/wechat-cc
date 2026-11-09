import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path'
import { copyWorkspaceDependencies, DEPENDENCY_LOCKS, DEPENDENCY_NOTICE, readPreparationFile, type DependencyOptions } from './worktree-dependencies'
import { Preparation } from './worktree-preparation'
import { installDependencies } from './worktree-dependency-installer'
import { mkdirAnchored, verifyFromFilesystemRoot } from '../workbench/anchored-fs'

export interface DependencyCacheOptions extends DependencyOptions { maxCacheBytes?: number; canPublish?: () => boolean }
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
  return mkdirAnchored(state, ['dependency-cache', 'v2'], 'unsafe_dependency_cache')
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
const completion = (key: string) => JSON.stringify({ key, installer: 'bun', frozen: true, scripts: false, version: 2 })
function supportsCleanInstall(files: Map<string, Buffer>): boolean {
  // Only text Bun locks are currently supported. Never import a mutable local
  // file/directory (including encoded paths) into a host-side installation.
  if (!files.has('bun.lock') || !files.has('package.json')) return false
  const unsafe = (text: string) => /(?:file|link|portal|patch):/i.test(text) || /(?:^|@)(?:[./~]?[\\/]|[A-Za-z]:[\\/])/.test(text) || /(?:^|[\\/:@])\.\.(?:[\\/]|$)/.test(text) || /workspace:(?:[\\/~]|\.[\\/])/i.test(text)
  const validate = (value: unknown): boolean => typeof value === 'string' ? !unsafe(value) :
    value === null || typeof value !== 'object' || Object.entries(value).every(([key, item]) => !unsafe(key) && validate(item))
  const manifestSafe = (manifest: Record<string, unknown>): boolean => {
    for (const field of ['dependencies','devDependencies','optionalDependencies','peerDependencies','overrides','resolutions','patchedDependencies','workspaces','catalog','catalogs']) {
      if (manifest[field] != null && !validate(manifest[field])) return false
    }
    return true
  }
  for (const [path, value] of files) if (path === 'package.json' || path.endsWith('/package.json')) {
    try { if (!manifestSafe(JSON.parse(value.toString()))) return false } catch { return false }
  }
  // Bun text locks are JSONC. Preserve quoted strings while removing comments
  // and trailing commas; JSON.parse rejects any other unsupported syntax.
  const text = files.get('bun.lock')!.toString()
    .replace(/"(?:[^"\\]|\\.)*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, token => token.startsWith('"') ? token : '')
    .replace(/"(?:[^"\\]|\\.)*"|,\s*([}\]])/g, (token, close: string | undefined) => close ?? token)
  let lock: Record<string, unknown>
  try { lock = JSON.parse(text) } catch { return false }
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) return false
  for (const [field, value] of Object.entries(lock)) {
    if (field === 'packages') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false
      for (const [name, tuple] of Object.entries(value)) {
        if (unsafe(name) || !Array.isArray(tuple)) return false
        for (const [index, part] of tuple.entries()) {
          // bin/main/exports are paths inside a package, never install sources.
          if (index === 2 && part && typeof part === 'object' && !Array.isArray(part)) {
            if (!Object.entries(part).every(([key, item]) => ['bin','main','exports'].includes(key) || validate(item))) return false
          } else if (!validate(part)) return false
        }
      }
    } else if (field === 'workspaces') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false
      for (const [name, manifest] of Object.entries(value)) if (unsafe(name) || !manifest || typeof manifest !== 'object' || !manifestSafe(manifest)) return false
    } else if (!validate(value)) return false
  }
  return true
}
async function publish(source: string, stateDir: string, options: DependencyCacheOptions, budget: Preparation): Promise<void> {
  budget.check(); if (options.canPublish && !options.canPublish()) return
  const before = await metadata(source, budget)
  if (!before.key || !supportsCleanInstall(before.files)) return
  const root = await cacheRoot(stateDir), key = `${await scope(source, budget)}-${before.key}`, entry = join(root, key)
  const rel = relative(source, root)
  if (!rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))) throw Error('unsafe_dependency_cache')
  if (await readPreparationFile(entry, '.complete.json', 1024).then(v => v?.toString() === completion(key), () => false)) {
    const now = new Date(); await fs.utimes(entry, now, now); await prune(root, options.maxCacheBytes ?? MAX_CACHE_BYTES, budget); return
  }
  await prune(root, options.maxCacheBytes ?? MAX_CACHE_BYTES, budget)
  const stage = await fs.mkdtemp(join(root, '.stage-'))
  const snapshot = await fs.mkdtemp(join(root, '.stage-'))
  try {
    for (const path of [stage, snapshot]) await fs.writeFile(join(path, '.owner.json'), JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 })
    // No task node_modules, source, bunfig, npmrc, or hooks enter this stage.
    for (const [path, value] of before.files) {
      budget.check(); await fs.mkdir(dirname(join(stage, path)), { recursive: true }); await fs.writeFile(join(stage, path), value, { flag: 'wx', mode: 0o600 })
      await fs.mkdir(dirname(join(snapshot, path)), { recursive: true }); await fs.writeFile(join(snapshot, path), value, { flag: 'wx', mode: 0o600 })
    }
    await installDependencies(stage, budget)
    budget.check()
    for (const [path, value] of before.files) if (!(await readPreparationFile(stage, path, value.length))?.equals(value)) return
    if ((await metadata(source, budget)).key !== before.key || (options.canPublish && !options.canPublish())) return
    const notices = await copyWorkspaceDependencies(stage, snapshot, { ...options, metadataPaths: before.paths, snapshotWorkspaceLinks: true, timeoutMs: budget.deadline - Date.now() })
    if (notices.includes(DEPENDENCY_NOTICE) || !await installed(snapshot, before.paths)) return
    await fs.writeFile(join(snapshot, '.complete.json'), completion(key), { flag: 'wx', mode: 0o600 })
    await fs.unlink(join(snapshot, '.owner.json'))
    const bytes = await sizeOf(snapshot, budget), limit = options.maxCacheBytes ?? MAX_CACHE_BYTES
    if (bytes > limit) return
    // The installer has exited and staging is outside every task's writable roots.
    await fs.rm(stage, { recursive: true, force: true })
    await prune(root, limit, budget, bytes, snapshot)
    budget.check(); if (options.canPublish && !options.canPublish()) return
    await fs.rename(snapshot, entry)
  } finally { await fs.rm(stage, { recursive: true, force: true }); await fs.rm(snapshot, { recursive: true, force: true }) }
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
