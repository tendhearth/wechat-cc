import { preparationJobspawnFixture } from '../../test-support/preparation-jobspawn'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { copyWorkspaceDependencies, DEPENDENCY_COPY_NOTICE, DEPENDENCY_NOTICE } from './worktree-dependencies'
import { copyIncludedFiles, ensureWorktree, planWorktree, prepareWorktreeStart, removeWorktree, reopenWorktree } from './worktree-workspaces'
import { Preparation } from './worktree-preparation'
import { refreshWorktreeRemotes } from './worktree-fetch'
import { removeTempDir, writeWarmExecFixture } from '../../lib/test-temp'

vi.mock('node:fs/promises', async importOriginal => { const actual = await importOriginal<typeof import('node:fs/promises')>(); return { ...actual, copyFile: vi.fn(actual.copyFile) } })

preparationJobspawnFixture()

const areas: string[] = [], cleanups: Array<() => void | Promise<void>> = []
// Match fs.promises.realpath used by preparation, including Windows 8.3 names.
const area = () => { const path = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-prep-security-'))); areas.push(path); return path }
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null',...args], { cwd, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim()
const worktreeRoots = (root: string) => git(root,'worktree','list','--porcelain','-z').split('\0').filter(field=>field.startsWith('worktree ')).map(field=>resolve(field.slice('worktree '.length)))
function expectCloneAttempt(...args: unknown[]) {
  if (process.platform === 'win32') expect(fs.copyFile).not.toHaveBeenCalled()
  else expect(fs.copyFile).toHaveBeenCalledExactlyOnceWith(...args)
}
function repo() {
  const root = area()
  git(root,'init','-q','-b','main'); git(root,'config','user.name','Fixture'); git(root,'config','user.email','fixture@localhost')
  writeFileSync(join(root,'package.json'),'{}'); writeFileSync(join(root,'bun.lock'),'lock')
  git(root,'add','-A'); git(root,'commit','-qm','initial')
  return root
}
function pair() {
  const source = repo(), target = repo()
  mkdirSync(join(source,'node_modules','library'),{recursive:true}); writeFileSync(join(source,'node_modules/library/index.js'),'source')
  return { source, target }
}
function marker(root: string, name = 'ran') {
  const script = join(area(),'marker.sh'), mark = join(root,name)
  writeFileSync(script,`#!/bin/sh\nprintf executed > '${mark.replaceAll("'", "'\\''")}'\n`); chmodSync(script,0o755)
  return { script, mark }
}
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  vi.mocked(fs.copyFile).mockReset().mockImplementation((await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).copyFile)
  for (const cleanup of cleanups.splice(0)) await cleanup()
  for (const root of areas.splice(0)) removeTempDir(root)
})

describe('pre-approval preparation security', () => {
  it('[P1-1] never runs fsmonitor, hooks, filters or external diff during scanning and worktree creation', async () => {
    const { source, target } = pair(), { script, mark } = marker(source)
    for (const root of [source,target]) git(root,'config','core.fsmonitor',script)
    git(source,'config','core.hooksPath',join(source,'hooks')); mkdirSync(join(source,'hooks')); writeFileSync(join(source,'hooks/post-checkout'),readFileSync(script)); chmodSync(join(source,'hooks/post-checkout'),0o755)
    git(source,'config','diff.external',script)
    writeFileSync(join(source,'.gitattributes'),'package.json filter=evil\n')
    git(source,'add','.gitattributes'); git(source,'commit','-qm','attributes')
    git(source,'config','filter.evil.smudge',script); git(source,'config','filter.evil.process',script)
    const notices = await copyWorkspaceDependencies(source,target)
    expect(notices.filter(notice=>notice!==DEPENDENCY_COPY_NOTICE)).toEqual([])
    expect(readFileSync(join(target,'node_modules/library/index.js'),'utf8')).toBe('source')
    expect(existsSync(mark)).toBe(false)
    const plan = planWorktree({stateDir:area(),projectId:'p-0123456789abcdef0123',projectPath:source,repoRoot:source,id:'abcd1234'})
    await ensureWorktree(plan)
    expect(existsSync(mark)).toBe(false)
    expect(readFileSync(join(plan.root,'package.json'),'utf8')).toBe('{}')
  })

  it('[P1-2] rejects FIFO lock symlinks without reading or blocking the event loop', async () => {
    if (process.platform === 'win32') return // FIFO does not exist on Windows; ordinary/symlink cases below still run.
    const {source,target} = pair(), fifo = join(area(),'fifo')
    execFileSync('mkfifo',[fifo])
    for (const root of [source,target]) { rmSync(join(root,'bun.lock')); symlinkSync(fifo,join(root,'bun.lock')) }
    const started = Date.now()
    expect(await copyWorkspaceDependencies(source,target)).toHaveLength(1)
    expect(Date.now()-started).toBeLessThan(2000)
    expect(existsSync(join(target,'node_modules'))).toBe(false)
  })

  it('[P1-2] rejects oversized metadata, byte/entry/time budgets and cancellation with no published tree', async () => {
    const {source,target} = pair()
    for (const root of [source,target]) truncateSync(join(root,'bun.lock'),1024)
    expect(await copyWorkspaceDependencies(source,target,{maxMetadataBytes:32})).toHaveLength(1)
    for (const root of [source,target]) writeFileSync(join(root,'bun.lock'),'lock')
    for (const options of [{maxBytes:1},{maxEntries:1},{timeoutMs:0},{minFreeBytes:Number.MAX_SAFE_INTEGER}]) {
      // Byte limits apply to actual copying; force that path rather than COW.
      if ('maxBytes' in options) vi.mocked(fs.copyFile).mockRejectedValue(Object.assign(Error('no clone'),{code:'ENOTSUP'}))
      expect(await copyWorkspaceDependencies(source,target,options)).toHaveLength(1)
      if ('maxBytes' in options) expectCloneAttempt(join(source,'node_modules/library/index.js'),expect.stringContaining(join(target,'.cc-dependencies-')),constants.COPYFILE_FICLONE_FORCE)
      vi.mocked(fs.copyFile).mockReset().mockImplementation((await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).copyFile)
      expect(existsSync(join(target,'node_modules'))).toBe(false)
      expect(readdirSync(target).filter(n=>n.startsWith('.cc-dependencies-'))).toEqual([])
    }
    const cancel = new AbortController(); cancel.abort()
    await expect(copyWorkspaceDependencies(source,target,{signal:cancel.signal})).rejects.toThrow('cancelled')
  })

  it('[P1-2] rolls back its stages on ENOSPC and allows other requests while copying', async () => {
    const {source,target} = pair()
    vi.mocked(fs.copyFile).mockRejectedValueOnce(Object.assign(Error('disk full'),{code:'ENOSPC'}))
    const open = fs.open
    const writes = vi.spyOn(fs,'open').mockImplementation((...args) => {
      if (args[1] === 'wx') return Promise.reject(Object.assign(Error('disk full'),{code:'ENOSPC'}))
      return Reflect.apply(open,fs,args)
    })
    let ticks=0; const timer=setInterval(()=>ticks++,1)
    try { expect(await copyWorkspaceDependencies(source,target)).toHaveLength(1) } finally { clearInterval(timer) }
    expectCloneAttempt(join(source,'node_modules/library/index.js'),expect.stringContaining(join(target,'.cc-dependencies-')),constants.COPYFILE_FICLONE_FORCE)
    if (process.platform === 'win32') expect(writes).toHaveBeenCalledWith(expect.stringContaining(join(target,'.cc-dependencies-')),'wx',expect.any(Number))
    expect(ticks).toBeGreaterThan(0)
    expect(existsSync(join(target,'node_modules'))).toBe(false)
    expect(readdirSync(target).filter(n=>n.startsWith('.cc-dependencies-'))).toEqual([])
  })

  it('[P1-3] slow fetch has a hard deadline, remains responsive, and falls back to an existing SHA', async () => {
    const source=repo(), server=createServer((_request,_response)=>{})
    await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
    cleanups.push(()=>{server.closeAllConnections();return new Promise<void>(r=>server.close(()=>r()))})
    git(source,'remote','add','origin',`http://127.0.0.1:${(server.address() as {port:number}).port}/repo`)
    let ticks=0; const timer=setInterval(()=>ticks++,10), started=Date.now()
    try {
      const result=await prepareWorktreeStart(source,'main',{fetchTimeoutMs:200,timeoutMs:4000})
      expect(result.sha).toBe(git(source,'rev-parse','HEAD')); expect(result.notices).toHaveLength(1)
      expect(ticks).toBeGreaterThan(2); expect(Date.now()-started).toBeLessThan(3000)
    } finally {clearInterval(timer)}
    expect(readdirSync(join(source,'.git/objects')).filter(n=>n.startsWith('cc-fetch-'))).toEqual([])
    expect(git(source,'for-each-ref','--format=%(refname)').split('\n').filter(ref=>ref.startsWith('refs/remotes/cc-preparation-'))).toEqual([])
  })

  it('[P1-3] rejects repository credential/askpass/SSH/helper commands before approval', async () => {
    const source=repo(), {script,mark}=marker(source), server=createServer((_req,res)=>{res.writeHead(401,{'WWW-Authenticate':'Basic realm="fixture"'});res.end()})
    await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));cleanups.push(()=>new Promise<void>(r=>server.close(()=>r())))
    git(source,'config','core.askPass',script); git(source,'config','credential.helper',`!${script}`)
    git(source,'config','core.sshCommand',script)
    git(source,'remote','add','origin',`http://127.0.0.1:${(server.address() as {port:number}).port}/repo`)
    await prepareWorktreeStart(source,'main',{fetchTimeoutMs:1000})
    expect(existsSync(mark)).toBe(false)
    git(source,'remote','set-url','origin',`ext::${script}`)
    await prepareWorktreeStart(source,'main',{fetchTimeoutMs:1000})
    expect(existsSync(mark)).toBe(false)
    git(source,'remote','set-url','origin','ssh://127.0.0.1:1/repo')
    await prepareWorktreeStart(source,'main',{fetchTimeoutMs:1000})
    expect(existsSync(mark)).toBe(false)
  })

  it('[P1-3] kills TERM-ignoring descendants holding pipes on timeout and cancellation', async () => {
    if(process.platform==='win32')return // POSIX process groups; Windows uses the jobspawn job.
    const root=area(), bin=join(root,'git'), pidfile=join(root,'pid')
    const quote=(value:string)=>`'${value.replaceAll("'","'\\''")}'`
    // Keep the original hard deadline for process-tree cleanup, without two
    // cold Bun startups consuming it before the descendant can write its PID.
    const child=join(root,'child.sh')
    writeFileSync(child,"#!/bin/sh\ntrap '' TERM\nwhile :; do sleep 1; done\n")
    // Pay macOS's first-exec assessment before starting the hard deadline.
    writeWarmExecFixture(bin,`#!/bin/sh\nif [ "$1" = --version ]; then exit 0; fi\nfor arg do if [ "$arg" = config ]; then exit 1; fi; done\ntrap '' TERM\n/bin/sh ${quote(child)} &\nchild=$!\nprintf '%s' "$child" > ${quote(pidfile)}\nwait "$child"\n`)
    vi.stubEnv('PATH',root+':'+process.env.PATH)
    expect(existsSync(pidfile)).toBe(false)
    for(const cancel of [false,true]){
      const controller=new AbortController(), prep=new Preparation({timeoutMs:2000,signal:controller.signal})
      let failure: (Error & {detail?:string}) | undefined
      const pending=prep.git(root,['fetch']).catch(error=>{failure=error;return null})
      await expect.poll(()=>existsSync(pidfile)?'started':failure?failure.message+':'+failure.detail:'waiting').toBe('started')
      const pid=Number(readFileSync(pidfile,'utf8'));if(cancel)controller.abort()
      await pending
      expect(failure?.message).toContain(cancel?'cancelled':'timeout')
      await expect.poll(()=>{try{return execFileSync('ps',['-o','stat=','-p',String(pid)],{encoding:'utf8'}).trim().startsWith('Z')}catch{return true}}).toBe(true)
      rmSync(pidfile)
    }
  })

  it('[P2-4] rejects source-internal dependency links whose relocated target escapes the target worktree', async () => {
    const {source,target}=pair()
    mkdirSync(join(source,'libdata'));writeFileSync(join(source,'libdata/index.js'),'source')
    symlinkSync('../libdata',join(source,'node_modules/local'),'dir')
    symlinkSync(join(source,'libdata'),join(target,'libdata'),'dir')
    expect(await copyWorkspaceDependencies(source,target)).toHaveLength(1)
    expect(existsSync(join(target,'node_modules'))).toBe(false)
    expect(readFileSync(join(source,'libdata/index.js'),'utf8')).toBe('source')
  })

  it('[P2-5] fetch ignores force-to-local-branch refspecs and preserves diverged local commits', async () => {
    const remote=repo(), source=repo()
    git(source,'remote','add','origin',remote)
    git(source,'fetch','origin','main:refs/remotes/origin/main')
    git(source,'branch','dev','origin/main')
    git(source,'config','branch.dev.remote','origin');git(source,'config','branch.dev.merge','refs/heads/main')
    git(source,'config','remote.origin.fetch','+refs/heads/main:refs/heads/dev')
    git(source,'checkout','-q','dev');writeFileSync(join(source,'local'),'local');git(source,'add','local');git(source,'commit','-qm','local')
    const local=git(source,'rev-parse','dev');git(source,'checkout','-q','main')
    writeFileSync(join(remote,'remote'),'remote');git(remote,'add','remote');git(remote,'commit','-qm','remote')
    const refreshed=await prepareWorktreeStart(source,'dev')
    expect(git(source,'rev-parse','dev')).toBe(local);expect(refreshed.sha).toBe(local)
    expect(git(source,'rev-parse','refs/remotes/origin/main')).toBe(git(remote,'rev-parse','HEAD'))
    expect(refreshed.notices).toEqual([])
  })

  it.each(['apps/x/package-lock.json','npm-shrinkwrap.json'])('[P2-6] refuses stale dependencies when %s differs', async lock => {
    const {source,target}=pair()
    if(lock.startsWith('apps/')) for(const root of [source,target]) {
      mkdirSync(join(root,'apps/x'),{recursive:true});writeFileSync(join(root,'apps/x/package.json'),'{}')
    }
    writeFileSync(join(source,lock),'old');writeFileSync(join(target,lock),'new')
    for(const root of [source,target]){git(root,'add',lock);if(lock.startsWith('apps/'))git(root,'add','apps/x/package.json')}
    expect(await copyWorkspaceDependencies(source,target)).toHaveLength(1)
    expect(existsSync(join(target,'node_modules'))).toBe(false)
  })
})

it('[P2-5] remote-tracking symrefs cannot redirect publication into a local branch', async () => {
  const remote=repo(), source=repo()
  git(source,'remote','add','origin',remote);git(source,'fetch','origin')
  git(remote,'branch','z-last')
  git(source,'branch','dev','origin/main')
  const original=git(source,'rev-parse','dev')
  git(source,'symbolic-ref','refs/remotes/origin/z-last','refs/heads/dev')
  writeFileSync(join(remote,'later'),'update');git(remote,'add','later');git(remote,'commit','-qm','later');git(remote,'branch','-f','z-last','HEAD')
  const result=await prepareWorktreeStart(source,'dev')
  expect(result.notices).toEqual([])
  expect(git(source,'rev-parse','dev')).toBe(original)
  expect(git(source,'rev-parse','refs/remotes/origin/z-last')).toBe(git(remote,'rev-parse','HEAD'))
})

it.each(['native','fallback'])('[P1-2] cancellation after checkout removes only its own checkout, branch and dependency stages (%s)', async mode => {
  const {source}=pair(), state=area(), controller=new AbortController()
  const plan=planWorktree({stateDir:state,projectId:'p-0123456789abcdef0123',projectPath:source,repoRoot:source,id:'deaf1234'})
  const other=planWorktree({stateDir:state,projectId:'p-0123456789abcdef0123',projectPath:source,repoRoot:source,id:'feed1234'})
  await ensureWorktree(other)
  vi.mocked(fs.copyFile).mockClear()
  if(mode==='fallback') vi.mocked(fs.copyFile).mockRejectedValue(Object.assign(Error('no clone'),{code:'ENOTSUP'}))
  const check=Preparation.prototype.check, cancelledStages:string[]=[]
  let atCancellation: { checkout:string; branch:string; dependenciesPublished:boolean; copied:string } | undefined
  // Cancel at the real budget checkpoint after a staged file has been written,
  // before publication. Both COW and chunked copies reach this same boundary.
  vi.spyOn(Preparation.prototype,'check').mockImplementation(function(this:Preparation) {
    if(this.options.signal===controller.signal && !controller.signal.aborted && existsSync(plan.root)) {
      for(const name of readdirSync(plan.root).filter(n=>n.startsWith('.cc-dependencies-'))) {
        const stage=join(plan.root,name), file=join(stage,'tree/library/index.js')
        if(!existsSync(file) || statSync(file).size!==6) continue
        cancelledStages.push(stage)
        atCancellation={checkout:readFileSync(join(plan.root,'package.json'),'utf8'),branch:git(plan.root,'branch','--show-current'),dependenciesPublished:existsSync(join(plan.root,'node_modules')),copied:readFileSync(file,'utf8')}
        controller.abort()
        break
      }
    }
    check.call(this)
  })
  await expect(ensureWorktree(plan,{signal:controller.signal})).rejects.toThrow('cancelled')
  expect(controller.signal.aborted).toBe(true)
  expect(atCancellation).toEqual({checkout:'{}',branch:plan.branch,dependenciesPublished:false,copied:'source'})
  if(mode==='fallback') expectCloneAttempt(join(source,'node_modules/library/index.js'),expect.stringContaining(join(plan.root,'.cc-dependencies-')),constants.COPYFILE_FICLONE_FORCE)
  expect(cancelledStages).toHaveLength(1)
  expect(existsSync(cancelledStages[0]!)).toBe(false)
  expect(existsSync(plan.root)).toBe(false)
  expect(git(source,'branch','--list',plan.branch)).toBe('')
  expect(worktreeRoots(source)).not.toContain(plan.root)
  expect(git(other.root,'branch','--show-current')).toBe(other.branch)
  expect(worktreeRoots(source)).toContain(other.root)
  expect(readFileSync(join(other.root,'node_modules/library/index.js'),'utf8')).toBe('source')
  expect(readFileSync(join(source,'node_modules/library/index.js'),'utf8')).toBe('source')
})

it('[P2-4] preexisting dependency installation links are not accepted as isolated copies', async () => {
  const {source,target}=pair()
  symlinkSync(join(source,'node_modules'),join(target,'node_modules'),'dir')
  expect(await copyWorkspaceDependencies(source,target)).toHaveLength(1)
  expect(readFileSync(join(source,'node_modules/library/index.js'),'utf8')).toBe('source')
})


it('[P1-2] included-file preparation never creates directories through target ancestor links', async () => {
  const {source,target}=pair(), outside=area()
  writeFileSync(join(source,'.gitignore'),'secret/\n');writeFileSync(join(source,'.worktreeinclude'),'secret/\n')
  mkdirSync(join(source,'secret/newdir'),{recursive:true});writeFileSync(join(source,'secret/newdir/local'),'local')
  symlinkSync(outside,join(target,'secret'),'dir')
  expect(await copyIncludedFiles(source,target)).toBe(0)
  expect(existsSync(join(outside,'newdir'))).toBe(false)
})

it('[P1-3] oversized fetch objects are discarded before remote refs are published', async () => {
  const remote=repo(), source=repo()
  git(source,'remote','add','origin',remote);git(source,'fetch','origin')
  const old=git(source,'rev-parse','refs/remotes/origin/main')
  writeFileSync(join(remote,'new-data'),'changed data');git(remote,'add','new-data');git(remote,'commit','-qm','new data')
  const result=await prepareWorktreeStart(source,'main',{maxFetchBytes:1})
  expect(result.notices).toHaveLength(1)
  expect(git(source,'rev-parse','refs/remotes/origin/main')).toBe(old)
  expect(readdirSync(join(source,'.git/objects')).filter(n=>n.startsWith('cc-fetch-'))).toEqual([])
})


it('concurrent reopens cannot remove the successful checkout', async () => {
  const source=repo(),plan=planWorktree({stateDir:area(),projectId:'p-0123456789abcdef0123',projectPath:source,repoRoot:source,id:'abcd9900'})
  await ensureWorktree(plan);removeWorktree(source,plan.root)
  const results=await Promise.allSettled([reopenWorktree(source,plan.root,plan.branch,plan.taskPath),reopenWorktree(source,plan.root,plan.branch,plan.taskPath)])
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
  expect(results.filter(r=>r.status==='rejected')).toHaveLength(1)
  expect(existsSync(join(plan.root,'package.json'))).toBe(true)
  expect(git(plan.root,'branch','--show-current')).toBe(plan.branch)
})

it.each([true,false])('[rereview-existing] selected branches with tracked dependencies cannot masquerade as reused installations (source installed=%s)', async installed => {
  const {source}=pair()
  const library=join(source,'library-data');mkdirSync(library);writeFileSync(join(library,'index.js'),'source')
  git(source,'checkout','-qb','selected')
  mkdirSync(join(source,'node_modules/local'),{recursive:true})
  writeFileSync(join(source,'node_modules/local/tracked'),'keep this tracked file')
  symlinkSync(library,join(source,'node_modules/local/source'),'dir')
  git(source,'add','-f','node_modules/local');git(source,'commit','-qm','tracked dependencies')
  git(source,'checkout','-q','main')
  if(!installed)rmSync(join(source,'node_modules'),{recursive:true})
  const plan=planWorktree({stateDir:area(),projectId:'p-0123456789abcdef0123',projectPath:source,repoRoot:source,base:'selected',id:'b8830001'})
  await ensureWorktree(plan)
  expect(plan.start?.notices).toHaveLength(1)
  expect(readFileSync(join(plan.root,'node_modules/local/tracked'),'utf8')).toBe('keep this tracked file')
  expect(readFileSync(join(library,'index.js'),'utf8')).toBe('source')
})

it.each([65*1024*1024,Number.MAX_SAFE_INTEGER])('[rereview-budget] COW accepts a dependency forest above 1 GiB (free=%s)', async available => {
  const {source,target}=pair(), nominal=768*1024*1024
  for (const name of ['a','b']) { writeFileSync(join(source,'node_modules',name),'');truncateSync(join(source,'node_modules',name),nominal) }
  // Sparse, independent files model successful clonefile without allocating GiBs on CI.
  vi.mocked(fs.copyFile).mockClear().mockImplementation(async (from,to)=>{await fs.writeFile(to,'');await fs.truncate(to,(await fs.stat(from)).size)})
  const disk=await fs.statfs(target)
  vi.spyOn(fs,'statfs').mockResolvedValue({...disk,bavail:available,bsize:1})
  if (process.platform === 'win32') {
    // Reject before reading either sparse file; Windows has no COW path here.
    expect(await copyWorkspaceDependencies(source,target,{maxBytes:1})).toEqual([DEPENDENCY_NOTICE])
    expect(fs.copyFile).not.toHaveBeenCalled()
    expect(existsSync(join(target,'node_modules'))).toBe(false)
    expect(readdirSync(target).filter(n=>n.startsWith('.cc-dependencies-'))).toEqual([])
    return
  }
  expect(await copyWorkspaceDependencies(source,target)).toEqual([])
  expect(statSync(join(target,'node_modules/a')).size+statSync(join(target,'node_modules/b')).size).toBe(2*nominal)
  expect(vi.mocked(fs.copyFile).mock.calls.length).toBe(3)
  for(const call of vi.mocked(fs.copyFile).mock.calls) expect(call[2]).toBe(constants.COPYFILE_FICLONE_FORCE)
  writeFileSync(join(target,'node_modules/a'),'task edit')
  expect(statSync(join(source,'node_modules/a')).size).toBe(nominal)
})

it('[rereview-budget] unsupported COW enforces actual byte and disk limits and removes partial trees', async () => {
  const {source,target}=pair()
  vi.mocked(fs.copyFile).mockRejectedValue(Object.assign(Error('no clone'),{code:'ENOTSUP'}))
  expect(await copyWorkspaceDependencies(source,target,{maxBytes:1})).toHaveLength(1)
  expectCloneAttempt(join(source,'node_modules/library/index.js'),expect.stringContaining(join(target,'.cc-dependencies-')),constants.COPYFILE_FICLONE_FORCE)
  expect(existsSync(join(target,'node_modules'))).toBe(false)
  expect(readdirSync(target).filter(n=>n.startsWith('.cc-dependencies-'))).toEqual([])
  vi.mocked(fs.copyFile).mockClear()
  const disk=await fs.statfs(target)
  vi.spyOn(fs,'statfs').mockResolvedValue({...disk,bavail:64*1024*1024+1,bsize:1})
  expect(await copyWorkspaceDependencies(source,target)).toHaveLength(1)
  expectCloneAttempt(join(source,'node_modules/library/index.js'),expect.stringContaining(join(target,'.cc-dependencies-')),constants.COPYFILE_FICLONE_FORCE)
  expect(existsSync(join(target,'node_modules'))).toBe(false)
  expect(readdirSync(target).filter(n=>n.startsWith('.cc-dependencies-'))).toEqual([])
})

it('[rereview-budget] successful fallback copies are independent and consume only actual copied bytes', async () => {
  const {source,target}=pair()
  vi.mocked(fs.copyFile).mockRejectedValue(Object.assign(Error('no clone'),{code:'ENOTSUP'}))
  expect(await copyWorkspaceDependencies(source,target,{maxBytes:6})).toEqual([DEPENDENCY_COPY_NOTICE])
  expectCloneAttempt(join(source,'node_modules/library/index.js'),expect.stringContaining(join(target,'.cc-dependencies-')),constants.COPYFILE_FICLONE_FORCE)
  expect(readFileSync(join(target,'node_modules/library/index.js'),'utf8')).toBe('source')
  writeFileSync(join(target,'node_modules/library/index.js'),'task')
  expect(readFileSync(join(source,'node_modules/library/index.js'),'utf8')).toBe('source')
})

it('[win32-copy] never trusts apparent COW success and budgets independent copies with a notice', async () => {
  const {source,target}=pair(), platform=Object.getOwnPropertyDescriptor(process,'platform')!
  const actual=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  // Model Bun's Windows CopyFileW: it succeeds but ignores FICLONE_FORCE.
  vi.mocked(fs.copyFile).mockImplementation((from,to)=>actual.copyFile(from,to))
  Object.defineProperty(process,'platform',{value:'win32',configurable:true})
  try {
    expect(await copyWorkspaceDependencies(source,target,{maxBytes:1})).toEqual([DEPENDENCY_NOTICE])
    expect(fs.copyFile).not.toHaveBeenCalled()
    expect(existsSync(join(target,'node_modules'))).toBe(false)
    expect(readdirSync(target).filter(n=>n.startsWith('.cc-dependencies-'))).toEqual([])
    const disk=await fs.statfs(target)
    const room=vi.spyOn(fs,'statfs').mockResolvedValue({...disk,bavail:64*1024*1024+1,bsize:1})
    expect(await copyWorkspaceDependencies(source,target,{maxBytes:6})).toEqual([DEPENDENCY_NOTICE])
    expect(existsSync(join(target,'node_modules'))).toBe(false)
    expect(readdirSync(target).filter(n=>n.startsWith('.cc-dependencies-'))).toEqual([])
    room.mockRestore()
    expect(await copyWorkspaceDependencies(source,target,{maxBytes:6})).toEqual([DEPENDENCY_COPY_NOTICE])
    expect(fs.copyFile).not.toHaveBeenCalled()
    expect(readFileSync(join(target,'node_modules/library/index.js'),'utf8')).toBe('source')
    writeFileSync(join(target,'node_modules/library/index.js'),'task edit')
    expect(readFileSync(join(source,'node_modules/library/index.js'),'utf8')).toBe('source')
  } finally { Object.defineProperty(process,'platform',platform) }
})

function partialClone() {
  const remote=repo(), source=join(area(),'clone')
  git(remote,'config','uploadpack.allowFilter','true')
  git(remote,'clone','--filter=blob:none',pathToFileURL(remote).href,source)
  return {remote,source}
}
const privateRefs = (root: string) => git(root,'for-each-ref','--format=%(refname)').split('\n').filter(ref=>ref.startsWith('refs/remotes/cc-preparation-'))
it('[rereview-promisor] standard partial clones refresh to the remote HEAD and retain promisor packs', async () => {
  const {remote,source}=partialClone()
  expect(readdirSync(join(source,'.git/objects/pack')).some(n=>n.endsWith('.promisor'))).toBe(true)
  writeFileSync(join(remote,'later'),'new commit');git(remote,'add','later');git(remote,'commit','-qm','later')
  await expect(refreshWorktreeRemotes(source)).resolves.toBeUndefined()
  expect(git(source,'rev-parse','origin/main')).toBe(git(remote,'rev-parse','HEAD'))
  const packs=readdirSync(join(source,'.git/objects/pack'))
  for(const name of packs.filter(n=>n.endsWith('.pack'))) expect(packs).toContain(name.replace(/\.pack$/,'.promisor'))
  expect(privateRefs(source)).toEqual([])
  expect(readdirSync(join(source,'.git/objects')).filter(n=>n.startsWith('cc-fetch-'))).toEqual([])
})

it.each([false,true])('[rereview-pack-cleanup] failed ref publication leaves the pack set unchanged (partial=%s)', async partial => {
  const {remote,source}=partial ? partialClone() : (()=>{const remote=repo(),source=repo();git(source,'remote','add','origin',pathToFileURL(remote).href);git(source,'fetch','origin');return {remote,source}})()
  const before=readdirSync(join(source,'.git/objects/pack')).sort(), old=git(source,'rev-parse','origin/main')
  writeFileSync(join(remote,'later'),'new commit');git(remote,'add','later');git(remote,'commit','-qm','later')
  writeFileSync(join(source,'.git/refs/remotes/origin/main.lock'),'owned fixture lock')
  const result=await prepareWorktreeStart(source,'main')
  expect(result.notices).toHaveLength(1)
  expect(git(source,'rev-parse','origin/main')).toBe(old)
  expect(readdirSync(join(source,'.git/objects/pack')).sort()).toEqual(before)
  expect(privateRefs(source)).toEqual([])
  expect(readdirSync(join(source,'.git/objects')).filter(n=>n.startsWith('cc-fetch-'))).toEqual([])
})

it('[rereview-pack-preflight] validates all pack entries before publishing any objects', async () => {
  const remote=repo(),source=repo()
  git(source,'remote','add','origin',pathToFileURL(remote).href);git(source,'fetch','origin')
  const before=readdirSync(join(source,'.git/objects/pack')).sort()
  writeFileSync(join(remote,'later'),'new commit');git(remote,'add','later');git(remote,'commit','-qm','later')
  const actual=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  // Return a bad final entry after all legitimate entries, reproducing the
  // old streaming validation's partial publication regardless of readdir order.
  vi.spyOn(fs,'readdir').mockImplementation((async (path: string,...args: unknown[])=>{
    const entries=await (actual.readdir as Function)(path,...args)
    return String(path).includes('cc-fetch-')&&String(path).endsWith(sep+'pack') ? [...entries,'zz-invalid-pack'] : entries
  }) as typeof fs.readdir)
  await expect(refreshWorktreeRemotes(source)).rejects.toThrow('unsafe_fetch_pack')
  expect(readdirSync(join(source,'.git/objects/pack')).sort()).toEqual(before)
  expect(privateRefs(source)).toEqual([])
})

it('[rereview-private-refs] cleanup assertions detect actual randomized private namespaces', () => {
  const root=repo(),ref='refs/remotes/cc-preparation-abc/origin/main'
  git(root,'update-ref',ref,'HEAD')
  expect(privateRefs(root)).toEqual([ref])
  git(root,'update-ref','-d',ref)
  expect(privateRefs(root)).toEqual([])
})

it('[rereview-fetch-queue] concurrent tasks wait for a failed fetch to finish object rollback', async () => {
  const remote=repo(),source=repo()
  git(source,'remote','add','origin',pathToFileURL(remote).href);git(source,'fetch','origin')
  writeFileSync(join(remote,'later'),'new commit');git(remote,'add','later');git(remote,'commit','-qm','later')
  const original=Preparation.prototype.git
  let reached!:()=>void,release!:()=>void,held=false,remoteLists=0
  const ready=new Promise<void>(resolve=>{reached=resolve}),gate=new Promise<void>(resolve=>{release=resolve})
  vi.spyOn(Preparation.prototype,'git').mockImplementation(async function(this: Preparation,cwd,args,input,env){
    if(args[0]==='remote')remoteLists++
    if(args[0]==='update-ref'&&input?.startsWith('start\n')&&!held){held=true;reached();await gate;throw Error('fixture_ref_failure')}
    return original.call(this,cwd,args,input,env)
  })
  const first=refreshWorktreeRemotes(source).catch(error=>error)
  await ready
  const second=refreshWorktreeRemotes(source)
  try {await new Promise(resolve=>setTimeout(resolve,100));expect(remoteLists).toBe(1)}
  finally {release();await Promise.allSettled([first,second])}
  expect((await first).message).toBe('fixture_ref_failure')
  await expect(second).resolves.toBeUndefined()
  expect(git(source,'show','origin/main:later')).toBe('new commit')
  expect(privateRefs(source)).toEqual([])
})

it('[rereview-fetch-queue] queued preparations can be cancelled without starting another fetch', async () => {
  const source=repo(),server=createServer(()=>reached())
  let reached!:()=>void
  const ready=new Promise<void>(resolve=>{reached=resolve})
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  cleanups.push(()=>{server.closeAllConnections();return new Promise<void>(resolve=>server.close(()=>resolve()))})
  git(source,'remote','add','origin',`http://127.0.0.1:${(server.address() as {port:number}).port}/repo`)
  const firstCancel=new AbortController(),secondCancel=new AbortController()
  const first=refreshWorktreeRemotes(source,{signal:firstCancel.signal}).catch(error=>error)
  await ready
  const second=refreshWorktreeRemotes(source,{signal:secondCancel.signal})
  secondCancel.abort()
  await expect(second).rejects.toThrow('cancelled')
  firstCancel.abort();await first
  expect(privateRefs(source)).toEqual([])
  expect(readdirSync(join(source,'.git/objects')).filter(n=>n.startsWith('cc-fetch-'))).toEqual([])
})

it('[rereview-interrupted-ref] interrupted ref publication preserves objects already used by tracking refs', async () => {
  const remote=repo(),source=repo()
  git(source,'remote','add','origin',pathToFileURL(remote).href);git(source,'fetch','origin')
  writeFileSync(join(remote,'later'),'new commit');git(remote,'add','later');git(remote,'commit','-qm','later')
  const sha=git(remote,'rev-parse','HEAD'),original=Preparation.prototype.git
  vi.spyOn(Preparation.prototype,'git').mockImplementation(async function(this: Preparation,cwd,args,input,env){
    if(args[0]==='update-ref'&&input?.startsWith('start\n')) {git(source,'update-ref','refs/remotes/origin/main',sha);throw Error('fixture_interrupted_commit')}
    return original.call(this,cwd,args,input,env)
  })
  expect((await prepareWorktreeStart(source,'main')).notices).toHaveLength(1)
  expect(git(source,'rev-parse','origin/main')).toBe(sha)
  expect(git(source,'show','origin/main:later')).toBe('new commit')
  expect(privateRefs(source)).toEqual([])
})
