import { afterEach, expect, it, vi } from 'vitest'
import * as fsPromises from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { cacheWorkspaceDependencies as cacheRaw, restoreWorkspaceDependencies as restoreRaw, recoverDependencyStages, type DependencyCacheOptions } from './worktree-dependency-cache'
import { DEPENDENCY_NOTICE } from './worktree-dependencies'
import { removeTempDir } from '../../lib/test-temp'
import { installDependencies } from './worktree-dependency-installer'
import { preparationJobspawnFixture } from '../../test-support/preparation-jobspawn'
vi.mock('./worktree-dependency-installer', () => ({ installDependencies: vi.fn() }))
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
preparationJobspawnFixture()
const dirs: string[] = []
const origins = new Map<string, string>()
const cacheWorkspaceDependencies = (source: string, state: string, options: DependencyCacheOptions = {}) => cacheRaw(source, state, { baseSha: origins.get(source), ...options })
const restoreWorkspaceDependencies = (source: string, target: string, state: string, options: DependencyCacheOptions = {}) => restoreRaw(source, target, state, { baseSha: origins.get(target), ...options })
afterEach(() => { vi.restoreAllMocks(); dirs.splice(0).forEach(removeTempDir) })
function fixture() {
  vi.mocked(installDependencies).mockReset().mockImplementation(async stage => {
    mkdirSync(join(stage,'node_modules/tool'),{recursive:true});writeFileSync(join(stage,'node_modules/tool/index.js'),'installed')
    symlinkSync('tool',join(stage,'node_modules/alias'),'dir');symlinkSync('../pkg',join(stage,'node_modules/workspace'),'dir')
    writeFileSync(join(stage,'pkg/cli.js'),'installer endpoint');mkdirSync(join(stage,'node_modules/.bin'));symlinkSync('../../pkg/cli.js',join(stage,'node_modules/.bin/workspace-cli'),'file')
  })
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-dep-cache-'))); dirs.push(root)
  const source = join(root, 'source'), target = join(root, 'target'), state = join(root, 'state')
  mkdirSync(source); mkdirSync(state)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: source, encoding: 'utf8', stdio: 'pipe' }).trim()
  git('init', '-q'); git('config', 'user.email', 'test@localhost'); git('config', 'user.name', 'fixture')
  writeFileSync(join(source, 'package.json'), '{"name":"fixture","workspaces":["pkg"]}')
  mkdirSync(join(source, 'pkg')); writeFileSync(join(source, 'pkg/package.json'), '{"name":"workspace"}'); writeFileSync(join(source, 'pkg/cli.js'), 'workspace CLI from checkout')
  writeFileSync(join(source, 'bun.lock'), '{"lockfileVersion":1,"packages":{},"marker":"lock A"}'); writeFileSync(join(source, '.gitignore'), 'node_modules/\n')
  git('add', '.'); git('commit', '-qm', 'initial'); git('worktree', 'add', '-qb', 'target', target)
  origins.set(source, git('rev-parse','HEAD')); origins.set(target, git('rev-parse','HEAD'))
  mkdirSync(join(source, 'node_modules/tool'), { recursive: true }); writeFileSync(join(source, 'node_modules/tool/index.js'), 'installed')
  symlinkSync('tool', join(source, 'node_modules/alias'), 'dir')
  symlinkSync('../pkg', join(source, 'node_modules/workspace'), 'dir')
  const entries = () => readdirSync(join(state, 'dependency-cache/v2')).filter(name => !name.startsWith('.')).map(name => join(state, 'dependency-cache/v2', name))
  const commitOrigin = () => { git('add','.'); git('commit','-qm','new origin'); origins.set(source,git('rev-parse','HEAD')) }
  return { root, source, target, state, git, entries, commitOrigin }
}
it('installs in clean staging and publishes independent relocated links and restores after the publishing checkout disappears', async () => {
  const f = fixture(); await cacheWorkspaceDependencies(f.source, f.state)
  expect(f.entries()).toHaveLength(1)
  const stage=vi.mocked(installDependencies).mock.calls[0]![0]
  expect(stage.startsWith(f.source)).toBe(false);expect(stage.startsWith(f.target)).toBe(false)
  expect(existsSync(stage)).toBe(false)
  rmSync(join(f.source, 'node_modules'), { recursive: true })
  await restoreWorkspaceDependencies(f.source, f.target, f.state)
  expect(readFileSync(join(f.target, 'node_modules/alias/index.js'), 'utf8')).toBe('installed')
  expect(realpathSync(join(f.target, 'node_modules/workspace'))).toBe(join(f.target, 'pkg'))
  writeFileSync(join(f.target, 'node_modules/tool/index.js'), 'task changes')
  expect(readFileSync(join(f.entries()[0]!, 'node_modules/tool/index.js'), 'utf8')).toBe('installed')
})
it.each(['manifest', 'nested lock', 'shrinkwrap'])('rejects a cache hit after changing %s with the root lock unchanged', async kind => {
  const f = fixture(); await cacheWorkspaceDependencies(f.source, f.state); rmSync(join(f.source, 'node_modules'), { recursive: true })
  vi.mocked(installDependencies).mockRejectedValueOnce(Error('frozen lock mismatch'))
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
  const f=fixture(); await cacheWorkspaceDependencies(f.source,f.state,{maxCacheBytes:2000})
  const first=f.entries()[0]!;utimesSync(first,new Date(1000),new Date(1000))
  writeFileSync(join(f.source,'bun.lock'),'{"lockfileVersion":1,"packages":{},"marker":"lock B"}');f.commitOrigin();await cacheWorkspaceDependencies(f.source,f.state,{maxCacheBytes:2000})
  const second=f.entries().find(p=>p!==first)!;expect(second).toBeTruthy()
  const size=(path:string):number=>readdirSync(path,{withFileTypes:true}).reduce((n,e)=>n+(e.isDirectory()?size(join(path,e.name)):e.isFile()?readFileSync(join(path,e.name)).length:0),0)
  const limit=size(second)
  await cacheWorkspaceDependencies(f.source,f.state,{maxCacheBytes:limit})
  expect(f.entries()).toEqual([second])
  writeFileSync(join(f.source,'bun.lock'),'{"lockfileVersion":1,"packages":{},"marker":"oversized"}')
  f.commitOrigin()
  vi.mocked(installDependencies).mockImplementationOnce(async stage=>{mkdirSync(join(stage,'node_modules/tool'),{recursive:true});writeFileSync(join(stage,'node_modules/tool/index.js'),'x'.repeat(3000))})
  await cacheWorkspaceDependencies(f.source,f.state,{maxCacheBytes:limit})
  expect(f.entries()).toEqual([second])
})
it('discards snapshots when a quiet writer resumes and cancellation leaves no stages', async () => {
  const f = fixture(); let checks = 0
  await cacheWorkspaceDependencies(f.source, f.state, { canPublish: () => ++checks === 1 })
  expect(f.entries()).toEqual([])
  const abort = new AbortController(); abort.abort()
  await expect(cacheWorkspaceDependencies(f.source, f.state, { signal: abort.signal })).rejects.toThrow('worktree_preparation_cancelled')
  expect(readdirSync(join(f.state, 'dependency-cache/v2'))).toEqual([])
})

it('reclaims a dead publisher stage and includes it in the global cache budget', async () => {
  const f = fixture(), stale = join(f.state, 'dependency-cache/v2/.stage-dead00')
  mkdirSync(stale, { recursive: true })
  writeFileSync(join(stale, '.owner.json'), JSON.stringify({ pid: 2147483647 }))
  writeFileSync(join(stale, 'partial-dependencies'), 'x'.repeat(1000))
  await cacheWorkspaceDependencies(f.source, f.state, { maxCacheBytes: 2000 })
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
  expect(readdirSync(join(f.state,'dependency-cache/v2')).some(name=>name.startsWith('.stage-'))).toBe(false)
})

it('refuses sibling worktrees when cache storage is unavailable', async () => {
  const f=fixture(), sibling=join(f.root,'sibling')
  f.git('worktree','add','-qb','sibling',sibling)
  mkdirSync(join(sibling,'node_modules/tool'),{recursive:true});writeFileSync(join(sibling,'node_modules/tool/index.js'),'sibling installation')
  writeFileSync(join(f.source,'bun.lock'),'owner is old');writeFileSync(join(f.state,'dependency-cache'),'unavailable cache')
  expect(await restoreWorkspaceDependencies(f.source,f.target,f.state)).toContain(DEPENDENCY_NOTICE)
  expect(existsSync(join(f.target,'node_modules'))).toBe(false)
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

it('security: never promotes task-controlled node_modules or a forged completion record', async()=>{
  const f=fixture()
  writeFileSync(join(f.source,'node_modules/tool/index.js'),'untrusted-task-byte-marker')
  writeFileSync(join(f.source,'.complete.json'),JSON.stringify({complete:true}))
  await cacheWorkspaceDependencies(f.source,f.state)
  rmSync(join(f.source,'node_modules'),{recursive:true})
  await restoreWorkspaceDependencies(f.source,f.target,f.state)
  const file=join(f.target,'node_modules/tool/index.js')
  expect(existsSync(file) ? readFileSync(file,'utf8') : '').not.toBe('untrusted-task-byte-marker')
})
it('security: partial sibling installs never count as completed dependencies', async()=>{
  const f=fixture(), sibling=join(f.root,'sibling')
  f.git('worktree','add','-qb','sibling',sibling)
  rmSync(join(f.source,'node_modules'),{recursive:true})
  vi.mocked(installDependencies).mockRejectedValueOnce(Error('still installing'))
  mkdirSync(join(sibling,'node_modules/partial'),{recursive:true});writeFileSync(join(sibling,'node_modules/partial/index.js'),'partial')
  expect(await restoreWorkspaceDependencies(f.source,f.target,f.state)).toContain(DEPENDENCY_NOTICE)
  expect(existsSync(join(f.target,'node_modules'))).toBe(false)
})

it.each(['failed','interrupted','metadata changed'])('does not cache %s installations',async kind=>{
  const f=fixture()
  vi.mocked(installDependencies).mockImplementationOnce(async stage=>{
    mkdirSync(join(stage,'node_modules/partial'),{recursive:true})
    if(kind==='metadata changed')writeFileSync(join(stage,'bun.lock'),'changed')
    else throw Error(kind)
  })
  await cacheWorkspaceDependencies(f.source,f.state)
  expect(f.entries()).toEqual([])
  expect(readdirSync(join(f.state,'dependency-cache/v2'))).toEqual([])
})
it.each(['file:/task/pkg','link:../task','file:\\u002ftask/pkg','workspace:../../task'])('refuses mutable local source %s before installation',async spec=>{
  const f=fixture();writeFileSync(join(f.source,'package.json'),JSON.stringify({dependencies:{untrusted:spec}}))
  await cacheWorkspaceDependencies(f.source,f.state)
  expect(installDependencies).not.toHaveBeenCalled()
})
it('never restores old v1 snapshots or incomplete entries',async()=>{
  const f=fixture();await cacheWorkspaceDependencies(f.source,f.state)
  const entry=f.entries()[0]!
  rmSync(join(entry,'.complete.json'));rmSync(join(f.source,'node_modules'),{recursive:true})
  vi.mocked(installDependencies).mockRejectedValue(Error('offline'))
  mkdirSync(join(f.state,'dependency-cache/v1/poison/node_modules/tool'),{recursive:true})
  writeFileSync(join(f.state,'dependency-cache/v1/poison/node_modules/tool/index.js'),'poison')
  expect(await restoreWorkspaceDependencies(f.source,f.target,f.state)).toContain(DEPENDENCY_NOTICE)
  expect(existsSync(join(f.target,'node_modules'))).toBe(false)
})
it('reinstalls under a new namespace policy instead of restoring or colliding with a pre-fix cache', async () => {
  const f = fixture(); await cacheWorkspaceDependencies(f.source, f.state)
  const entry = f.entries()[0]!, common = realpathSync(resolve(f.source, f.git('rev-parse', '--git-common-dir')))
  const oldScope = createHash('sha256').update(`${common}\0${process.platform}\0${process.arch}\0${process.versions.modules}`).digest('hex')
  const legacyKey = oldScope + basename(entry).slice(64), legacy = join(f.state, 'dependency-cache/v2', legacyKey)
  if (entry !== legacy) renameSync(entry, legacy)
  const record = JSON.parse(readFileSync(join(legacy, '.complete.json'), 'utf8'))
  writeFileSync(join(legacy, '.complete.json'), JSON.stringify({ ...record, key: legacyKey, sourcePolicy: 'committed-public-registry-v1' }))
  writeFileSync(join(legacy, 'node_modules/tool/index.js'), 'legacy aliased payload')
  rmSync(join(f.source, 'node_modules'), { recursive: true })
  expect(await restoreWorkspaceDependencies(f.source, f.target, f.state)).not.toContain(DEPENDENCY_NOTICE)
  expect(readFileSync(join(f.target, 'node_modules/tool/index.js'), 'utf8')).toBe('installed')
  expect(readFileSync(join(legacy, 'node_modules/tool/index.js'), 'utf8')).toBe('legacy aliased payload')
})
it('accepts ordinary bin paths inside a valid JSONC Bun lock',async()=>{
  const f=fixture()
  writeFileSync(join(f.source,'bun.lock'),'{"lockfileVersion":1,"packages":{"tool":["tool@1.0.0","",{"bin":"./bin/tool.js"},"sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="],},}')
  f.commitOrigin()
  await cacheWorkspaceDependencies(f.source,f.state)
  expect(installDependencies).toHaveBeenCalledOnce()
  expect(f.entries()).toHaveLength(1)
})
it('refuses staging inside a task even when the child directory starts with two dots',async()=>{
  const f=fixture()
  await cacheWorkspaceDependencies(f.source,join(f.source,'..task-state'))
  expect(installDependencies).not.toHaveBeenCalled()
})
it('refuses workspace globs that import another task directory',async()=>{
  const f=fixture();writeFileSync(join(f.source,'package.json'),JSON.stringify({name:'fixture',workspaces:['../../task/*']}))
  await cacheWorkspaceDependencies(f.source,f.state)
  expect(installDependencies).not.toHaveBeenCalled()
})
it.each(['tool@file:/task/bytes','tool@workspace:../task','tool@workspace:./task'])('rejects local source in structured Bun lock: %s',async source=>{
  const f=fixture();writeFileSync(join(f.source,'bun.lock'),JSON.stringify({lockfileVersion:1,packages:{tool:[source]}}))
  await cacheWorkspaceDependencies(f.source,f.state)
  expect(installDependencies).not.toHaveBeenCalled()
})

it('requires the original task commit and never infers trust from current HEAD',async()=>{
  const f=fixture()
  await cacheRaw(f.source,f.state)
  expect(installDependencies).not.toHaveBeenCalled()
})
it.each(['bun.lock','package.json','pkg/package.json'])('refuses task mutations to %s even after the task commits them',async path=>{
  const f=fixture();writeFileSync(join(f.source,path),'{}');f.git('add','.');f.git('commit','-qm','task changed dependencies')
  await cacheWorkspaceDependencies(f.source,f.state)
  expect(installDependencies).not.toHaveBeenCalled()
})
it('installs only immutable git object bytes and ignores task config',async()=>{
  const f=fixture(),original=readFileSync(join(f.source,'bun.lock'))
  writeFileSync(join(f.source,'bunfig.toml'),'[install]\nregistry="http://127.0.0.1"')
  vi.mocked(installDependencies).mockImplementationOnce(async(stage,_budget,files)=>{
    expect(files.get('bun.lock')!.equals(original)).toBe(true)
    expect(files.has('bunfig.toml')).toBe(false)
    expect(existsSync(join(stage,'bunfig.toml'))).toBe(false)
    mkdirSync(join(stage,'node_modules/tool'),{recursive:true});writeFileSync(join(stage,'node_modules/tool/index.js'),'verified')
  })
  await cacheWorkspaceDependencies(f.source,f.state)
  expect(installDependencies).toHaveBeenCalledOnce();expect(f.entries()).toHaveLength(1)
})
it.each(['git+ssh://git@public.example/probe','github:owner/pkg','file:../secret','https://public.example/probe.tgz'])('rejects committed unsafe source %s before host install',async source=>{
  const f=fixture();writeFileSync(join(f.source,'bun.lock'),JSON.stringify({lockfileVersion:1,packages:{tool:[source,'',{},'sha512-'+'A'.repeat(86)+'==']}}));f.commitOrigin()
  await cacheWorkspaceDependencies(f.source,f.state)
  expect(installDependencies).not.toHaveBeenCalled()
})
it('retains the owner through the atomic publication rename',async()=>{
  const f=fixture(),rename=fsPromises.rename
  let checked=false
  vi.spyOn(fsPromises,'rename').mockImplementation(async(from,to)=>{
    if(String(from).includes('.stage-') && /^[a-f0-9]{64}-/.test(basename(String(to)))) {
      expect(JSON.parse(readFileSync(join(String(from),'.owner.json'),'utf8')).pid).toBe(process.pid)
      checked=true
    }
    return rename(from,to)
  })
  await cacheWorkspaceDependencies(f.source,f.state)
  expect(checked).toBe(true);expect(f.entries()).toHaveLength(1)
  expect(existsSync(join(f.entries()[0]!,'.owner.json'))).toBe(false)
})
it('falls back to executor installation without partial trees when symlink creation is denied',async()=>{
  const f=fixture();rmSync(join(f.source,'node_modules'),{recursive:true})
  vi.spyOn(fsPromises,'symlink').mockRejectedValue(Object.assign(Error('symlink privilege unavailable'),{code:'EPERM'}))
  const notices=await restoreWorkspaceDependencies(f.source,f.target,f.state)
  expect(notices).toContain(DEPENDENCY_NOTICE)
  expect(existsSync(join(f.target,'node_modules'))).toBe(false)
  expect(f.entries()).toEqual([])
  expect(readdirSync(join(f.state,'dependency-cache/v2')).filter(n=>n.startsWith('.stage-'))).toEqual([])
})
it.each(['EPERM','EACCES','EBUSY'])('falls back and cleans owned stages when publication rename is locked: %s',async code=>{
  const f=fixture(),rename=fsPromises.rename;rmSync(join(f.source,'node_modules'),{recursive:true})
  vi.spyOn(fsPromises,'rename').mockImplementation(async(from,to)=>{
    if(/^[a-f0-9]{64}-/.test(basename(String(to))))throw Object.assign(Error('publication locked'),{code})
    return rename(from,to)
  })
  expect(await restoreWorkspaceDependencies(f.source,f.target,f.state)).toContain(DEPENDENCY_NOTICE)
  expect(existsSync(join(f.target,'node_modules'))).toBe(false)
  expect(f.entries()).toEqual([])
  expect(readdirSync(join(f.state,'dependency-cache/v2')).filter(n=>n.startsWith('.stage-'))).toEqual([])
})
it('startup recovers a journaled ownerless crash stage and a journal written before mkdir, preserving a live stage',async()=>{
  const f=fixture(),root=join(f.state,'dependency-cache/v2');mkdirSync(root,{recursive:true})
  for(const [name,pid] of [['.stage-dead00',2147483647],['.stage-a11a11',process.pid],['.stage-abab00',2147483647]] as const){
    writeFileSync(join(root,name+'.owner.json'),JSON.stringify({pid}))
    if(name!=='.stage-abab00'){mkdirSync(join(root,name));writeFileSync(join(root,name,'bytes'),'x'.repeat(2048))}
  }
  await recoverDependencyStages(f.state)
  expect(existsSync(join(root,'.stage-dead00'))).toBe(false)
  expect(existsSync(join(root,'.stage-dead00.owner.json'))).toBe(false)
  expect(existsSync(join(root,'.stage-abab00.owner.json'))).toBe(false)
  expect(existsSync(join(root,'.stage-a11a11'))).toBe(true)
})
it('cleans the first stage and its journal when creating the second stage fails',async()=>{
  const f=fixture(),mkdir=fsPromises.mkdir
  let stages=0
  vi.spyOn(fsPromises,'mkdir').mockImplementation(async(path,...args:any[])=>{
    if(/\.stage-[a-f0-9]{6}$/.test(String(path)) && ++stages===2)throw Error('injected second-stage creation failure')
    return (mkdir as any)(path,...args)
  })
  await cacheWorkspaceDependencies(f.source,f.state)
  expect(readdirSync(join(f.state,'dependency-cache/v2'))).toEqual([])
})
