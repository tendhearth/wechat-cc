import * as fs from 'node:fs/promises'
import { join, dirname, relative, resolve, sep, basename } from 'node:path'
import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { createHash, timingSafeEqual } from 'node:crypto'
import { dependencyInstallPlan, dependencySafePart, publicAddress, type RegistryPackage } from './worktree-dependency-policy'
import { extractPackage, InstallQuota } from './worktree-dependency-archive'
import type { Preparation } from './worktree-preparation'
import type { DependencyOptions } from './worktree-dependencies'

async function resolvePublicHost(hostname: string, budget: Preparation): Promise<{ address: string; family: number }[]> {
  return new Promise((accept, reject) => {
    const finish = (error?: Error, value?: { address: string; family: number }[]) => {
      clearTimeout(timer); budget.options.signal?.removeEventListener('abort', abort)
      if (error) reject(error); else accept(value!)
    }
    const abort = () => finish(Error('worktree_preparation_cancelled'))
    const timer = setTimeout(() => finish(Error('worktree_preparation_timeout')), Math.max(1, budget.deadline - Date.now()))
    budget.options.signal?.addEventListener('abort', abort, { once: true })
    if (budget.options.signal?.aborted) abort()
    else lookup(hostname, { all: true, family: 4 }).then(value => finish(undefined, value), error => finish(error))
  })
}
/** No redirects, cookies, auth, user config, proxy config, or subprocesses. DNS is pinned. */
async function download(pkg: RegistryPackage, quota: InstallQuota): Promise<Buffer> {
  quota.budget.check()
  const url = new URL(pkg.url), addresses = await resolvePublicHost(url.hostname, quota.budget)
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw Error('dependency_registry_address')
  quota.budget.check()
  return new Promise((accept, reject) => {
    const chunks: Buffer[] = []; let bytes = 0, done = false
    const finish = (error?: Error) => {
      if (done) return; done = true
      clearTimeout(timer); quota.budget.options.signal?.removeEventListener('abort', abort)
      req.destroy()
      if (error) reject(error)
      else {
        const data = Buffer.concat(chunks), actual = createHash('sha512').update(data).digest(), expected = Buffer.from(pkg.integrity.slice(7), 'base64')
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) reject(Error('dependency_integrity'))
        else accept(data)
      }
    }
    const req = request(url, { agent: false, family: 4, lookup: (_hostname, _options, callback) => callback(null, addresses[0]!.address, 4), headers: { 'Accept-Encoding': 'identity' } }, res => {
      if (res.statusCode !== 200 || res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') { res.destroy(); finish(Error('dependency_registry_response')); return }
      const cap = Math.min(32 * 1024 ** 2, quota.maxBytes)
      const length = res.headers['content-length']
      if (length && (!/^\d+$/.test(length) || Number(length) > cap || Number(length) > quota.maxBytes - quota.downloaded)) { res.destroy(); finish(Error('dependency_download_budget')); return }
      res.on('data', (chunk: Buffer) => {
        try {
          quota.budget.check()
          if (chunk.length > cap - bytes || chunk.length > quota.maxBytes - quota.downloaded) throw Error('dependency_download_budget')
          bytes += chunk.length; quota.downloaded += chunk.length; chunks.push(chunk)
        } catch (error) { res.destroy(); finish(error as Error) }
      })
      res.on('end', () => finish()); res.on('error', error => finish(error))
    })
    const abort = () => finish(Error('worktree_preparation_cancelled'))
    const timer = setTimeout(() => finish(Error('worktree_preparation_timeout')), Math.max(1, quota.budget.deadline - Date.now()))
    req.on('error', error => finish(error)); quota.budget.options.signal?.addEventListener('abort', abort, { once: true })
    if (quota.budget.options.signal?.aborted) abort(); else req.end()
  })
}
/** Installs a conservative Bun-lock subset without ever executing Bun/Git/SSH or package scripts. */
export async function installDependencies(cwd: string, budget: Preparation, files: Map<string, Buffer>, options: DependencyOptions = {}, limit = 4 * 1024 ** 3): Promise<void> {
  const plan = dependencyInstallPlan(files), quota = new InstallQuota(cwd, budget, options, limit)
  quota.bytes = [...files.values()].reduce((n, b) => n + b.length, 0)
  quota.entries = [...files.keys()].reduce((n, path) => n + path.split('/').length, 0)
  quota.preflight(plan.packages.reduce((n, p) => n + (p.unpackedSize ?? 0), 0), plan.packages.reduce((n, p) => n + (p.fileCount ?? 1), plan.workspaces.length))
  await quota.room()
  // Honour an existing host proxy guard by declining; never silently route around it.
  if (plan.packages.length && Object.keys(process.env).some(k => /^(https?_proxy|all_proxy)$/i.test(k) && process.env[k])) throw Error('dependency_proxy_unsupported')
  for (const pkg of plan.packages) {
    const root = join(cwd, pkg.path)
    await extractPackage(await download(pkg, quota), root, quota)
    const manifest = JSON.parse(await fs.readFile(join(root, 'package.json'), 'utf8'))
    if (manifest.name !== pkg.name || manifest.version !== pkg.version || manifest.bundledDependencies || manifest.bundleDependencies || manifest.directories?.bin) throw Error('dependency_package_unsupported')
  }
  for (const workspace of plan.workspaces) {
    quota.preflight(0, 1); await quota.room(); quota.entries++
    const path = join(cwd, workspace.path), target = join(cwd, workspace.target)
    await quota.directory(dirname(path))
    await fs.symlink(process.platform === 'win32' ? target : relative(dirname(path), target), path, process.platform === 'win32' ? 'junction' : 'dir')
  }
  // Workspace bins save only a logical endpoint. On restore the relocator
  // resolves the new checkout's source, never a task's previous bytes.
  const binsFrom = [
    ...plan.packages.map(pkg => ({ path: pkg.path, root: join(cwd, pkg.path), name: pkg.name, workspace: false })),
    ...plan.workspaces.map(pkg => ({ path: pkg.path, root: join(cwd, pkg.target), name: JSON.parse(files.get(pkg.target + '/package.json')!.toString()).name as string, workspace: true })),
  ]
  for (const pkg of binsFrom) {
    const manifest = JSON.parse(await fs.readFile(join(pkg.root, 'package.json'), 'utf8'))
    const bins = typeof manifest.bin === 'string' ? { [pkg.name.split('/').at(-1)!]: manifest.bin } : manifest.bin ?? {}
    for (const [name, path] of Object.entries(bins)) {
      if (!dependencySafePart(name) || !/^[a-z0-9][a-z0-9._-]*$/i.test(name) || typeof path !== 'string') throw Error('dependency_bin_policy')
      const target = resolve(pkg.root, path)
      if (!target.startsWith(pkg.root + sep) || relative(pkg.root, target).split(sep).some(p => !dependencySafePart(p))) throw Error('dependency_bin_policy')
      if (pkg.workspace && !files.has(relative(cwd, target).split(sep).join('/'))) {
        await quota.file(target, Buffer.alloc(0), true)
      }
      if (!(await fs.lstat(target)).isFile()) throw Error('dependency_bin_policy')
      const parent = dirname(join(cwd, pkg.path))
      const bin = join(basename(parent).startsWith('@') ? dirname(parent) : parent, '.bin', name)
      await quota.directory(dirname(bin)); quota.preflight(0, 1); await quota.room(); quota.entries++
      await fs.chmod(target, 0o700)
      await fs.symlink(relative(dirname(bin), target), bin, 'file')
    }
  }
}
