import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { execFileSync } from 'node:child_process'

/** Clone installed dependencies, never share writable inodes or links to the source checkout.
 * COPYFILE_FICLONE uses APFS COW and falls back to a normal copy on other filesystems. */
export function copyWorkspaceDependencies(source: string, target: string): string[] {
  const notice = '未能完整复用项目依赖，请在此工作区运行锁定安装；临时目录和缓存已限制在任务工作区内。'
  const inside = (base: string, path: string) => path === base || path.startsWith(base + sep)
  source = realpathSync(source); target = realpathSync(target)
  let manifests: string[]
  try {
    const env = {...process.env}
    for(const key of Object.keys(env))if(key.startsWith('GIT_'))delete env[key]
    manifests = execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'ls-files', '-z', '--', 'package.json', '**/package.json'], { cwd: target, env: {...env,GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'}, encoding: 'utf8', timeout: 30_000 }).split('\0').filter(Boolean)
  } catch { return [notice] }
  if (!manifests.length) return []
  // A stale installation is no substitute for the selected branch's dependencies.
  try { for (const file of [...manifests, 'bun.lock', 'bun.lockb', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']) {
    const a = join(source, file), b = join(target, file)
    if (existsSync(a) !== existsSync(b) || (existsSync(a) && !readFileSync(a).equals(readFileSync(b)))) return [notice]
  } } catch { return [notice] }
  let incomplete = false
  const clone = (from: string, to: string) => {
    const stat = lstatSync(from)
    if (stat.isSymbolicLink()) {
      const linkTarget = realpathSync(from)
      if (!inside(source, linkTarget)) throw new Error('external_dependency_link')
      const finalTarget = join(target, relative(source, linkTarget))
      // Absolute internal links are relocated, including workspace package links.
      symlinkSync(finalTarget, to, lstatSync(linkTarget).isDirectory() ? 'dir' : 'file')
    } else if (stat.isDirectory()) {
      mkdirSync(to)
      for (const name of readdirSync(from)) {
        // Task scratch and tool caches are not installed dependencies.
        if (from.endsWith(sep+'node_modules') && ['.cache','.vite'].includes(name)) continue
        clone(join(from, name), join(to, name))
      }
    } else if (stat.isFile()) copyFileSync(from, to, constants.COPYFILE_FICLONE)
    else throw new Error('unsupported_dependency_file')
  }
  for (const manifest of manifests) {
    const rel = join(dirname(manifest), 'node_modules'), from = join(source, rel), to = join(target, rel)
    if (!existsSync(from) || existsSync(to)) continue
    if (isAbsolute(rel) || rel.split(sep).includes('..')) { incomplete = true; continue }
    const stage = join(dirname(to), `.cc-dependencies-${process.pid}`)
    let ownsStage = false
    try {
      if (!inside(target, realpathSync(dirname(to))) || lstatSync(from).isSymbolicLink() || existsSync(stage)) throw new Error('unsafe_dependency_directory')
      ownsStage = true
      clone(from, stage)
      renameSync(stage, to)
    } catch {
      incomplete = true
      // Only our own staging directory; never follow a repository link out of the checkout.
      if (ownsStage && inside(target, resolve(stage)) && inside(target, realpathSync(dirname(to)))) rmSync(stage, { recursive: true, force: true })
    }
  }
  if (!existsSync(join(target, 'node_modules')) && existsSync(join(target, 'package.json'))) incomplete = true
  return incomplete ? [notice] : []
}
