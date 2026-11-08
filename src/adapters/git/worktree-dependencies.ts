import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { Preparation, type PreparationOptions } from './worktree-preparation'

export const DEPENDENCY_NOTICE = '未能完整复用项目依赖，请在此工作区运行锁定安装；临时目录和缓存已限制在任务工作区内。'
export const DEPENDENCY_COPY_NOTICE = '此工作区的依赖已独立复制，会额外占用磁盘空间。'
const LOCKS = ['bun.lock','bun.lockb','package-lock.json','npm-shrinkwrap.json','pnpm-lock.yaml','yarn.lock']
const inside = (base: string, path: string) => path === base || path.startsWith(base + sep)
const safeRelative = (path: string) => !isAbsolute(path) && !path.split(/[\\/]/).some(p => p === '..' || p === '.git')
export interface DependencyOptions extends PreparationOptions {
  maxEntries?: number
  /** Actual fallback copy bytes. Successful COW clones consume no data-copy budget. */
  maxBytes?: number
  maxMetadataBytes?: number
  minFreeBytes?: number
}
/** No symlinks or devices, even for lockfiles. O_NONBLOCK also protects the open-before-fstat boundary. */
export async function readPreparationFile(root: string, path: string, maxBytes: number): Promise<Buffer | null> {
  if (!safeRelative(path)) throw Error('unsafe_preparation_file')
  const full = join(root, path)
  let stat
  try { stat = await fs.lstat(full) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e }
  if (!stat.isFile() || stat.size > maxBytes || !inside(root, await fs.realpath(full))) throw Error('unsafe_preparation_file')
  const file = await fs.open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = await file.stat()
    if (!opened.isFile() || opened.size > maxBytes) throw Error('unsafe_preparation_file')
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, opened.size + 1))
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset > maxBytes || offset > opened.size) throw Error('preparation_metadata_budget')
    return buffer.subarray(0, offset)
  } finally { await file.close() }
}

/** Async, bounded independent copies. Nothing is published until every relocated link is checked. */
export async function copyWorkspaceDependencies(source: string, target: string, options: DependencyOptions = {}): Promise<string[]> {
  const budget = new Preparation({ ...options, timeoutMs: options.timeoutMs ?? 15_000 })
  const stages: Array<{ from: string; to: string; stage: string }> = []
  let published = false, usedFallback = false, entries = 0, bytes = 0, metadata = 0
  const maxBytes = options.maxBytes ?? 1024 * 1024 * 1024, maxEntries = options.maxEntries ?? 100_000
  const minFree = options.minFreeBytes ?? 64 * 1024 * 1024
  const room = async (needed: number) => {
    budget.check()
    const disk = await fs.statfs(target)
    if (Number(disk.bavail) * Number(disk.bsize) < needed + minFree) throw Error('dependency_space_budget')
  }
  try {
    source = await fs.realpath(source); target = await fs.realpath(target)
    await room(0)
    const patterns = ['package.json','**/package.json', ...LOCKS.flatMap(f => [f, `**/${f}`])]
    const lists = await Promise.all([source, target].map(root => budget.git(root, ['ls-files','-z','--',...patterns])))
    const tracked = new Set(lists.flatMap(list => list.split('\0').filter(Boolean)))
    const manifests = [...tracked].filter(p => p === 'package.json' || p.endsWith('/package.json'))
    if (!manifests.length) return []
    for (const manifest of manifests) {
      let dir = dirname(manifest)
      for (;;) {
        for (const name of LOCKS) tracked.add(join(dir, name))
        if (dir === '.') break
        dir = dirname(dir)
      }
    }
    for (const path of tracked) {
      budget.check()
      const limit = Math.min(8 * 1024 * 1024, (options.maxMetadataBytes ?? 32 * 1024 * 1024) - metadata)
      if (limit < 0) throw Error('preparation_metadata_budget')
      const a = await readPreparationFile(source, path, limit), b = await readPreparationFile(target, path, limit)
      metadata += (a?.length ?? 0) + (b?.length ?? 0)
      if (metadata > (options.maxMetadataBytes ?? 32 * 1024 * 1024) || (a === null) !== (b === null) || (a && b && !a.equals(b))) throw Error('dependency_lock_mismatch')
    }
    const links: Array<{ path: string; destination: string; directory: boolean }> = []
    const clone = async (from: string, to: string): Promise<void> => {
      budget.check()
      if (++entries > maxEntries) throw Error('dependency_entry_budget')
      // Clones still allocate directory/file metadata. Sample free space without
      // paying a statfs syscall for each of a large repository's tiny files.
      if (entries % 256 === 0) await room(0)
      const stat = await fs.lstat(from)
      if (stat.isSymbolicLink()) {
        const actual = await fs.realpath(from)
        if (!inside(source, actual)) throw Error('external_dependency_link')
        const destination = join(target, relative(source, actual))
        links.push({ path: to, destination, directory: (await fs.stat(actual)).isDirectory() })
      } else if (stat.isDirectory()) {
        await fs.mkdir(to)
        // opendir bounds memory even for an adversarial flat directory.
        const directory = await fs.opendir(from)
        for await (const entry of directory) {
          budget.check()
          if (from.endsWith(sep + 'node_modules') && ['.cache','.vite'].includes(entry.name)) continue
          await clone(join(from, entry.name), join(to, entry.name))
        }
      } else if (stat.isFile()) {
        // Bun 1.3.14 on Windows ignores FICLONE_FORCE and calls CopyFileW.
        // Never mistake that full copy for COW and bypass byte/space budgets.
        let cloned = false
        if (process.platform !== 'win32') {
          try { await fs.copyFile(from, to, constants.COPYFILE_FICLONE_FORCE); cloned = true }
          catch (error) {
            if (!['ENOTSUP','EOPNOTSUPP','EXDEV','EINVAL','ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
          }
        }
        if (!cloned) {
          usedFallback = true
          if (stat.size > maxBytes - bytes) throw Error('dependency_byte_budget')
          await room(stat.size)
          const input = await fs.open(from, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
          try {
            const opened = await input.stat()
            if (!opened.isFile() || opened.size !== stat.size) throw Error('unsupported_dependency_file')
            const output = await fs.open(to, 'wx', stat.mode & 0o777)
            try {
              const buffer = Buffer.alloc(Math.min(1024 * 1024, stat.size + 1))
              let copied = 0
              for (;;) {
                budget.check()
                const { bytesRead } = await input.read(buffer)
                if (!bytesRead) break
                copied += bytesRead
                if (copied > stat.size || bytesRead > maxBytes - bytes) throw Error('dependency_byte_budget')
                let offset = 0
                while (offset < bytesRead) {
                  budget.check()
                  const written = (await output.write(buffer, offset, bytesRead - offset)).bytesWritten
                  if (!written) throw Error('dependency_copy_stalled')
                  offset += written; bytes += written
                }
              }
            } finally { await output.close() }
          } finally { await input.close() }
        }
        budget.check()
      } else throw Error('unsupported_dependency_file')
    }
    for (const manifest of manifests) {
      budget.check()
      const rel = join(dirname(manifest), 'node_modules')
      if (!safeRelative(rel)) throw Error('unsafe_dependency_directory')
      const from = join(source, rel), to = join(target, rel)
      const existing = await fs.lstat(to).catch(e => { if(e.code==='ENOENT')return null;throw e })
      // A tracked ordinary directory may contain source-pointing links or stale
      // files. We cannot claim or replace the user's existing installation.
      if (existing) throw Error('unsafe_dependency_directory')
      const src = await fs.lstat(from).catch(e => { if (e.code === 'ENOENT') return null; throw e })
      if (!src) continue
      if (!src.isDirectory() || !inside(source, await fs.realpath(from)) || !inside(target, await fs.realpath(dirname(to)))) throw Error('unsafe_dependency_directory')
      const stage = await fs.mkdtemp(join(dirname(to), '.cc-dependencies-'))
      stages.push({ from, to, stage })
      // mkdtemp reserves ownership; clone creates the installation directory inside it.
      await clone(from, join(stage, 'tree'))
    }
    const stagedPath = (path: string) => {
      const owner = stages.find(s => inside(s.to, path))
      return owner ? join(owner.stage, 'tree', relative(owner.to, path)) : path
    }
    // Resolve prospective links against the staged forest plus the target checkout.
    // Do this before creating any link; the source's real targets have no symlinks left.
    for (const link of links) {
      budget.check()
      const destination = stagedPath(link.destination)
      const actual = await fs.realpath(destination)
      if (!inside(target, actual)) throw Error('external_relocated_dependency_link')
      await fs.symlink(link.destination, link.path, link.directory ? 'dir' : 'file')
    }
    for (const stage of stages) { budget.check(); await fs.rename(join(stage.stage, 'tree'), stage.to) }
    // Validate the final target chain too (including links between installations).
    for (const link of links) {
      budget.check()
      if (!inside(target, await fs.realpath(link.destination))) throw Error('external_relocated_dependency_link')
    }
    published = true
    if (!await fs.lstat(join(target, 'node_modules')).then(() => true, () => false) && manifests.includes('package.json')) return [DEPENDENCY_NOTICE]
    return usedFallback ? [DEPENDENCY_COPY_NOTICE] : []
  } catch {
    if (options.signal?.aborted) throw Error('worktree_preparation_cancelled')
    return [DEPENDENCY_NOTICE]
  } finally {
    // Only paths reserved by this invocation; never delete an existing installation.
    for (const stage of stages) {
      if (!published) await fs.rm(stage.to, { recursive: true, force: true })
      await fs.rm(stage.stage, { recursive: true, force: true })
    }
  }
}
