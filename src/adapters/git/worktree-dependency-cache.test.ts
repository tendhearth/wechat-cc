import { afterEach, expect, it, vi } from 'vitest'
import * as fsPromises from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cacheWorkspaceDependencies, restoreWorkspaceDependencies } from './worktree-dependency-cache'
import { DEPENDENCY_NOTICE } from './worktree-dependencies'
import { removeTempDir } from '../../lib/test-temp'
import { preparationJobspawnFixture } from '../../test-support/preparation-jobspawn'
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
preparationJobspawnFixture()
const dirs: string[] = []
afterEach(() => { vi.restoreAllMocks(); dirs.splice(0).forEach(removeTempDir) })
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-dep-cache-'))); dirs.push(root)
  const source = join(root, 'source'), target = join(root, 'target'), state = join(root, 'state')
  mkdirSync(source); mkdirSync(state)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: source, encoding: 'utf8', stdio: 'pipe' }).trim()
  git('init', '-q'); git('config', 'user.email', 'test@localhost'); git('config', 'user.name', 'fixture')
  writeFileSync(join(source, 'package.json'), '{"name":"fixture","workspaces":["pkg"]}')
  mkdirSync(join(source, 'pkg')); writeFileSync(join(source, 'pkg/package.json'), '{"name":"workspace"}'); writeFileSync(join(source, 'pkg/cli.js'), 'workspace CLI from checkout')
  writeFileSync(join(source, 'bun.lock'), 'lock A'); writeFileSync(join(source, '.gitignore'), 'node_modules/\n')
  git('add', '.'); git('commit', '-qm', 'initial'); git('worktree', 'add', '-qb', 'target', target)
  mkdirSync(join(source, 'node_modules/tool'), { recursive: true }); writeFileSync(join(source, 'node_modules/tool/index.js'), 'installed')
  symlinkSync('tool', join(source, 'node_modules/alias'), 'dir')
  symlinkSync('../pkg', join(source, 'node_modules/workspace'), 'dir')
  const entries = () => readdirSync(join(state, 'dependency-cache/v1')).filter(name => !name.startsWith('.')).map(name => join(state, 'dependency-cache/v1', name))
  return { root, source, target, state, git, entries }
}
it('publishes independent relocated links and restores after the publishing checkout disappears', async () => {
  const f = fixture(); await cacheWorkspaceDependencies(f.source, f.state)
  expect(f.entries()).toHaveLength(1)
  rmSync(join(f.source, 'node_modules'), { recursive: true })
  await restoreWorkspaceDependencies(f.source, f.target, f.state)
  expect(readFileSync(join(f.target, 'node_modules/alias/index.js'), 'utf8')).toBe('installed')
  expect(realpathSync(join(f.target, 'node_modules/workspace'))).toBe(join(f.target, 'pkg'))
  writeFileSync(join(f.target, 'node_modules/tool/index.js'), 'task changes')
  expect(readFileSync(join(f.entries()[0]!, 'node_modules/tool/index.js'), 'utf8')).toBe('installed')
})
it.each(['manifest', 'nested lock', 'shrinkwrap'])('rejects a cache hit after changing %s with the root lock unchanged', async kind => {
  const f = fixture(); await cacheWorkspaceDependencies(f.source, f.state); rmSync(join(f.source, 'node_modules'), { recursive: true })
  const path = kind === 'manifest' ? 'pkg/package.json' : kind === 'nested lock' ? 'pkg/yarn.lock' : 'npm-shrinkwrap.json'
  writeFileSync(join(f.target, path), 'changed')
  const result = await restoreWorkspaceDependencies(f.source, f.target, f.state)
  expect(result).toContain(DEPENDENCY_NOTICE); expect(existsSync(join(f.target, 'node_modules'))).toBe(false)
})
it('rejects relocated workspace endpoints that escape the destination', async () => {
  const f = fixture(); await cacheWorkspaceDependencies(f.source, f.state); rmSync(join(f.source, 'node_modules'), { recursive: true })
  const outside = join(f.root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'package.json'), '{"name":"workspace"}')
  rmSync(join(f.target, 'pkg'), { recursive: true }); symlinkSync(outside, join(f.target, 'pkg'), 'dir')
  expect(await restoreWorkspaceDependencies(f.source, f.target, f.state)).toContain(DEPENDENCY_NOTICE)
  expect(existsSync(join(f.target, 'node_modules'))).toBe(false)
})
it('enforces total logical size, evicts least recently used snapshots, and refuses oversized entries', async () => {
  const f = fixture(); await cacheWorkspaceDependencies(f.source, f.state, { maxCacheBytes: 2000 })
  const first = f.entries()[0]!; utimesSync(first, new Date(1000), new Date(1000))
  writeFileSync(join(f.source, 'bun.lock'), 'lock B'); await cacheWorkspaceDependencies(f.source, f.state, { maxCacheBytes: 2000 })
  const second = f.entries().find(p => p !== first)!; expect(second).toBeTruthy()
  await cacheWorkspaceDependencies(f.source, f.state, { maxCacheBytes: 100 })
  expect(f.entries()).toEqual([second])
  writeFileSync(join(f.source, 'bun.lock'), 'oversized'); writeFileSync(join(f.source, 'node_modules/tool/index.js'), 'x'.repeat(1000))
  await cacheWorkspaceDependencies(f.source, f.state, { maxCacheBytes: 100 })
  expect(f.entries()).toEqual([second])
})
it('discards snapshots when a quiet writer resumes and cancellation leaves no stages', async () => {
  const f = fixture(); let checks = 0
  await cacheWorkspaceDependencies(f.source, f.state, { canPublish: () => ++checks === 1 })
  expect(f.entries()).toEqual([])
  const abort = new AbortController(); abort.abort()
  await expect(cacheWorkspaceDependencies(f.source, f.state, { signal: abort.signal })).rejects.toThrow('worktree_preparation_cancelled')
  expect(readdirSync(join(f.state, 'dependency-cache/v1'))).toEqual([])
})

it('reclaims a dead publisher stage and includes it in the global cache budget', async () => {
  const f = fixture(), stale = join(f.state, 'dependency-cache/v1/.stage-dead00')
  mkdirSync(stale, { recursive: true })
  writeFileSync(join(stale, '.owner.json'), JSON.stringify({ pid: 2147483647 }))
  writeFileSync(join(stale, 'partial-dependencies'), 'x'.repeat(1000))
  await cacheWorkspaceDependencies(f.source, f.state, { maxCacheBytes: 100 })
  expect(existsSync(stale)).toBe(false)
  expect(f.entries()).toHaveLength(1)
})


it.skipIf(process.platform === 'win32')('cancels and times out queued publications without waiting for the active copy', async () => {
  const f = fixture(), original = fsPromises.copyFile
  let release!:()=>void, started!:()=>void
  const gate = new Promise<void>(resolve=>{release=resolve}), copying = new Promise<void>(resolve=>{started=resolve})
  vi.spyOn(fsPromises,'copyFile').mockImplementation(async (from,to,flags)=>{
    if(String(from).endsWith('tool/index.js')) { started(); await gate }
    return original(from,to,flags)
  })
  const first = cacheWorkspaceDependencies(f.source,f.state)
  try {
    await copying
    const abort = new AbortController(), queued = cacheWorkspaceDependencies(f.source,f.state,{signal:abort.signal})
    abort.abort()
    await expect(queued).rejects.toThrow('worktree_preparation_cancelled')
    await expect(cacheWorkspaceDependencies(f.source,f.state,{timeoutMs:1})).rejects.toThrow('worktree_preparation_timeout')
  } finally { release(); await first }
  expect(f.entries()).toHaveLength(1)
  expect(readdirSync(join(f.state,'dependency-cache/v1')).some(name=>name.startsWith('.stage-'))).toBe(false)
})

it('uses a matching worktree when cache storage is unavailable without publishing an unproven snapshot', async () => {
  const f = fixture(), sibling = join(f.root,'sibling')
  f.git('worktree','add','-qb','sibling',sibling)
  mkdirSync(join(sibling,'node_modules/tool'),{recursive:true});writeFileSync(join(sibling,'node_modules/tool/index.js'),'sibling installation')
  writeFileSync(join(f.source,'bun.lock'),'owner is old')
  writeFileSync(join(f.state,'dependency-cache'),'unavailable cache')
  const notices = await restoreWorkspaceDependencies(f.source,f.target,f.state)
  expect(notices).not.toContain(DEPENDENCY_NOTICE)
  expect(readFileSync(join(f.target,'node_modules/tool/index.js'),'utf8')).toBe('sibling installation')
  expect(readFileSync(join(f.state,'dependency-cache'),'utf8')).toBe('unavailable cache')
})


it('restores workspace bin file links against the new checkout rather than retaining the publisher', async () => {
  const f=fixture()
  mkdirSync(join(f.source,'node_modules/.bin'))
  symlinkSync('../../pkg/cli.js',join(f.source,'node_modules/.bin/workspace-cli'),'file')
  await cacheWorkspaceDependencies(f.source,f.state)
  expect(f.entries()).toHaveLength(1)
  rmSync(join(f.source,'node_modules'),{recursive:true})
  const notices=await restoreWorkspaceDependencies(f.source,f.target,f.state)
  expect(notices).not.toContain(DEPENDENCY_NOTICE)
  expect(realpathSync(join(f.target,'node_modules/.bin/workspace-cli'))).toBe(join(f.target,'pkg/cli.js'))
  expect(readFileSync(join(f.target,'node_modules/.bin/workspace-cli'),'utf8')).toBe('workspace CLI from checkout')
})
