import { preparationJobspawnFixture } from '../../test-support/preparation-jobspawn'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyWorkspaceDependencies } from './worktree-dependencies'
import { copyIncludedFiles, ensureWorktree, planWorktree, prepareWorktreeStart, removeWorktree, reopenWorktree } from './worktree-workspaces'
import { Preparation } from './worktree-preparation'
import { removeTempDir } from '../../lib/test-temp'

vi.mock('node:fs/promises', async importOriginal => { const actual = await importOriginal<typeof import('node:fs/promises')>(); return { ...actual, copyFile: vi.fn(actual.copyFile) } })

preparationJobspawnFixture()

const areas: string[] = [], cleanups: Array<() => void | Promise<void>> = []
const area = () => { const path = realpathSync(mkdtempSync(join(tmpdir(), 'cc-prep-security-'))); areas.push(path); return path }
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null',...args], { cwd, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim()
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
    expect(await copyWorkspaceDependencies(source,target)).toEqual([])
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
      expect(await copyWorkspaceDependencies(source,target,options)).toHaveLength(1)
      expect(existsSync(join(target,'node_modules'))).toBe(false)
      expect(readdirSync(target).filter(n=>n.startsWith('.cc-dependencies-'))).toEqual([])
    }
    const cancel = new AbortController(); cancel.abort()
    await expect(copyWorkspaceDependencies(source,target,{signal:cancel.signal})).rejects.toThrow('cancelled')
  })

  it('[P1-2] rolls back its stages on ENOSPC and allows other requests while copying', async () => {
    const {source,target} = pair()
    vi.mocked(fs.copyFile).mockRejectedValueOnce(Object.assign(Error('disk full'),{code:'ENOSPC'}))
    let ticks=0; const timer=setInterval(()=>ticks++,1)
    try { expect(await copyWorkspaceDependencies(source,target)).toHaveLength(1) } finally { clearInterval(timer) }
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
    expect(git(source,'for-each-ref','refs/remotes/cc-preparation-')).toBe('')
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
    writeFileSync(join(root,'package.json'),'{"type":"commonjs"}')
    writeFileSync(bin,`#!${process.execPath}\nif(process.argv.includes('config'))process.exit(1);const c=require('node:child_process').spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'inherit'});require('node:fs').writeFileSync(${JSON.stringify(pidfile)},String(c.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`)
    chmodSync(bin,0o755);vi.stubEnv('PATH',root+':'+process.env.PATH)
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

it('[P1-2] cancellation after checkout removes only its own checkout, branch and dependency stages', async () => {
  const {source}=pair(), state=area(), controller=new AbortController()
  const plan=planWorktree({stateDir:state,projectId:'p-0123456789abcdef0123',projectPath:source,repoRoot:source,id:'deaf1234'})
  const actual=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(fs.copyFile).mockImplementationOnce(async (...args)=>{await actual.copyFile(...args);controller.abort()})
  await expect(ensureWorktree(plan,{signal:controller.signal})).rejects.toThrow('cancelled')
  expect(existsSync(plan.root)).toBe(false)
  expect(git(source,'branch','--list',plan.branch)).toBe('')
  expect(git(source,'worktree','list','--porcelain')).not.toContain(plan.root)
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
