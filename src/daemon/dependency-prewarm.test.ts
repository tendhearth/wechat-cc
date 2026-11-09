import { afterEach, expect, it, vi } from 'vitest'
import { createServer, request as httpRequest, type ServerResponse } from 'node:http'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openTestDb } from '../lib/db'
import { removeTempDir } from '../lib/test-temp'
import { makeWorkbenchStore, recentDependencyProjects } from '../adapters/store/workbench/store'
import { restoreWorkspaceDependencies } from '../adapters/git/worktree-dependency-cache'
import { DEPENDENCY_NOTICE } from '../adapters/git/worktree-dependencies'
import { DEPENDENCY_BACKGROUND_BUDGET, dependencyBackground, startDependencyBackground } from '../adapters/git/worktree-dependency-background'
import { makeMatterLog } from '../adapters/store/matter-log'
import { makeDependencyPrewarm } from './dependency-prewarm'
import { preparationJobspawnFixture } from '../test-support/preparation-jobspawn'
const network = vi.hoisted(() => ({ request: vi.fn(), lookup: vi.fn() }))
vi.mock('node:https', () => ({ request: network.request }))
vi.mock('node:dns/promises', () => ({ lookup: network.lookup }))
preparationJobspawnFixture()
const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.unstubAllEnvs(); vi.restoreAllMocks() })
function tarball() {
  const blocks: Buffer[] = []
  for (const [name, text] of [['package.json', JSON.stringify({name:'tool',version:'1.0.0',scripts:{postinstall:'touch scripts-ran'}})], ['index.js','trusted offline bytes']]) {
    const data = Buffer.from(text!), h = Buffer.alloc(512)
    h.write('package/' + name); h.write('0000644\0',100); h.write('0000000\0',108); h.write('0000000\0',116)
    h.write(data.length.toString(8).padStart(11,'0')+'\0',124); h.write('00000000000\0',136); h.fill(32,148,156); h.write('0',156); h.write('ustar\0',257)
    h.write(h.reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ',148)
    blocks.push(h,data,Buffer.alloc((512-data.length%512)%512))
  }
  return gzipSync(Buffer.concat([...blocks,Buffer.alloc(1024)]))
}
async function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(),'cc-background-registry-')))
  cleanup.push(() => removeTempDir(root))
  const repo = join(root,'repo'), target = join(root,'target'), state = join(root,'state')
  mkdirSync(repo); mkdirSync(state)
  const archive = tarball(), integrity = 'sha512-' + createHash('sha512').update(archive).digest('base64')
  writeFileSync(join(repo,'package.json'),'{"dependencies":{"tool":"1.0.0"}}')
  writeFileSync(join(repo,'bun.lock'),JSON.stringify({lockfileVersion:1,workspaces:{'':{dependencies:{tool:'1.0.0'}}},packages:{tool:['tool@1.0.0','',{},integrity]}}))
  writeFileSync(join(repo,'.gitignore'),'node_modules/\n')
  const git = (...args: string[]) => execFileSync('git',args,{cwd:repo,encoding:'utf8',stdio:'pipe'}).trim()
  git('init','-q'); git('config','user.email','test@localhost'); git('config','user.name','Fixture'); git('add','.'); git('commit','-qm','fixture')
  const baseSha = git('rev-parse','HEAD'); git('worktree','add','-qb','target',target)
  let requests = 0, hold = false, status = 200
  const replies: ServerResponse[] = []
  const server = createServer((req,res) => {
    requests++; expect(req.url).toBe('/tool/-/tool-1.0.0.tgz')
    if (hold) replies.push(res); else { res.writeHead(status); res.end(archive) }
  })
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve))
  const address = server.address() as {port:number}
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  for (const key of Object.keys(process.env)) if (/^(https?_proxy|all_proxy)$/i.test(key)) vi.stubEnv(key,'')
  network.lookup.mockReset().mockResolvedValue([{address:'93.184.216.34',family:4}])
  network.request.mockReset().mockImplementation((url: URL, _options: unknown, callback: any) => {
    expect(url.origin).toBe('https://registry.npmjs.org')
    return httpRequest({hostname:'127.0.0.1',port:address.port,path:url.pathname,method:'GET'},callback)
  })
  const lines: string[] = [], worker = startDependencyBackground(state,line => lines.push(line))
  cleanup.push(() => worker.stop())
  const entries = () => existsSync(join(state,'dependency-cache/v2')) ? readdirSync(join(state,'dependency-cache/v2')).filter(n=>!n.startsWith('.')) : []
  return {root,repo,target,state,git,baseSha,worker,lines,entries,get requests(){return requests},set hold(value:boolean){hold=value},set status(value:number){status=value},release(){hold=false;for(const res of replies.splice(0)){res.writeHead(status);res.end(archive)}}}
}
it('returns misses immediately while one offline registry install runs; next task restores verified cache', async () => {
  const f = await fixture(); f.hold = true
  const taskAbort = new AbortController()
  const restore = restoreWorkspaceDependencies(f.repo,f.target,f.state,{baseSha:f.baseSha,signal:taskAbort.signal})
  let timer: ReturnType<typeof setTimeout>
  const first = await Promise.race([restore,new Promise<string>(resolve => { timer=setTimeout(()=>resolve('foreground blocked by install'),3000) })])
  clearTimeout(timer!)
  if (typeof first === 'string') { taskAbort.abort(); await restore.catch(()=>{}) }
  expect(first).toContain(DEPENDENCY_NOTICE)
  await vi.waitFor(() => expect(f.requests).toBe(1))
  taskAbort.abort() // The daemon owns installation, not the dispatched task.
  expect(await restoreWorkspaceDependencies(f.repo,f.target,f.state,{baseSha:f.baseSha,timeoutMs:2000})).toContain(DEPENDENCY_NOTICE)
  expect(f.requests).toBe(1); expect(f.entries()).toEqual([])
  f.release(); await f.worker.drain()
  expect(f.entries()).toHaveLength(1)
  expect(await restoreWorkspaceDependencies(f.repo,f.target,f.state,{baseSha:f.baseSha})).not.toContain(DEPENDENCY_NOTICE)
  expect(readFileSync(join(f.target,'node_modules/tool/index.js'),'utf8')).toBe('trusted offline bytes')
  expect(existsSync(join(f.target,'scripts-ran'))).toBe(false)
  expect(f.requests).toBe(1)
  expect(f.lines.filter(l=>l.startsWith('start '))).toHaveLength(1)
  expect(f.lines.filter(l=>l.startsWith('complete '))).toHaveLength(1)
},15_000)
it.each(['shutdown','bytes','entries','registry','deadline'])('cleans private background stages after %s failure and logs its reason', async reason => {
  const f = await fixture(); f.hold = reason==='shutdown' || reason==='deadline'; if(reason==='registry')f.status=503
  const options = {baseSha:f.baseSha,...(reason==='bytes'?{maxBytes:300}:{}),...(reason==='entries'?{maxEntries:10}:{})}
  expect(await restoreWorkspaceDependencies(f.repo,f.target,f.state,options)).toContain(DEPENDENCY_NOTICE)
  if(reason==='shutdown' || reason==='deadline') {
    await vi.waitFor(() => expect(f.requests).toBe(1))
    if(reason==='shutdown') await f.worker.stop()
    else { const now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now+DEPENDENCY_BACKGROUND_BUDGET.timeoutMs+1);f.release() }
  }
  await f.worker.drain()
  expect(f.entries()).toEqual([])
  expect(readdirSync(join(f.state,'dependency-cache/v2'))).toEqual([])
  expect(f.lines.join('\n')).toMatch(/failed .*: .*budget|failed .*: .*cancelled|failed .*: .*response|failed .*: .*timeout/)
  expect(existsSync(join(f.target,'node_modules'))).toBe(false)
},15_000)
it('uses a bounded 15-minute background budget with room for the real 75k-entry repository', () => {
  expect(DEPENDENCY_BACKGROUND_BUDGET.timeoutMs).toBe(900_000)
  expect(DEPENDENCY_BACKGROUND_BUDGET.maxBytes).toBe(4*1024**3)
  expect(DEPENDENCY_BACKGROUND_BUDGET.maxEntries/2).toBeGreaterThan(75_000)
})
it('prewarms recent dispatch projects once, defers busy/high load, and selects origin/dev Git blobs over dirty HEAD', async () => {
  const f = await fixture(), db = openTestDb();cleanup.push(() => db.close())
  const store = makeWorkbenchStore(db)
  store.create({title:'recent',path:f.repo,providerId:'codex',ownerChatId:'owner'})
  store.create({title:'duplicate',path:f.repo,providerId:'codex',ownerChatId:'owner'})
  f.git('update-ref','refs/remotes/origin/dev',f.baseSha)
  writeFileSync(join(f.repo,'bun.lock'),'unsafe HEAD must not be installation input')
  f.git('add','bun.lock'); f.git('commit','-qm','different HEAD')
  let idle=false, load=0
  const warm = makeDependencyPrewarm({stateDir:f.state,db,idle:()=>idle,log:()=>{},sampleLoad:()=>({load,cores:2})});cleanup.push(()=>warm.stop())
  await warm.tick();expect(f.requests).toBe(0)
  idle=true;load=3;await warm.tick();expect(f.requests).toBe(0)
  load=2.99;await warm.tick();expect(f.entries()).toHaveLength(1)
  await warm.tick();expect(f.requests).toBe(1)
  expect(await restoreWorkspaceDependencies(f.repo,f.target,f.state,{baseSha:f.baseSha})).not.toContain(DEPENDENCY_NOTICE)
},15_000)
it('selects all projects dispatched within 14 days, resolves removed worktrees, excludes managed and stale tasks', () => {
  const db=openTestDb();cleanup.push(()=>db.close()); const store=makeWorkbenchStore(db),now=Date.now(),since=now-14*24*60*60_000
  for(let i=0;i<205;i++)store.create({title:'recent',path:'/project/'+i,providerId:'codex',ownerChatId:'owner'})
  const old=store.create({title:'old',path:'/stale',providerId:'codex',ownerChatId:'owner'})
  db.query('UPDATE workbench_tasks SET created_at=? WHERE id=?').run(since-1,old.id)
  store.create({title:'managed',path:'/managed',providerId:'codex',ownerChatId:'owner',workspaceKind:'managed'})
  const task=store.create({title:'worktree',path:'/state/worktrees/task',providerId:'codex',ownerChatId:'owner'})
  store.worktrees.record({taskId:task.id,projectPath:'/original/subproject',repoRoot:'/original',root:'/state/worktrees/task',branch:'cc/task'})
  const paths=recentDependencyProjects(db,since)
  expect(paths).toHaveLength(206);expect(paths).toContain('/original')
  expect(paths).not.toContain('/state/worktrees/task');expect(paths).not.toContain('/managed');expect(paths).not.toContain('/stale')
})
it('falls back to HEAD without origin/dev and stops a pending warmup at daemon shutdown', async () => {
  const f=await fixture(),db=openTestDb();cleanup.push(()=>db.close());makeWorkbenchStore(db).create({title:'recent',path:f.repo,providerId:'codex',ownerChatId:'owner'})
  f.hold=true
  const warm=makeDependencyPrewarm({stateDir:f.state,db,idle:()=>true,log:()=>{},sampleLoad:()=>({load:0,cores:2})});cleanup.push(()=>warm.stop())
  const pending=warm.tick();await vi.waitFor(()=>expect(f.requests).toBe(1));await warm.stop();await pending
  expect(f.entries()).toEqual([]);expect(dependencyBackground(f.state).stopped).toBe(true)
  await warm.tick();expect(f.requests).toBe(1)
},15_000)

it('rechecks load when queued warmup starts and retries the deferred project on the next idle tick', async () => {
  const f=await fixture(),db=openTestDb();cleanup.push(()=>db.close())
  makeWorkbenchStore(db).create({title:'recent',path:f.repo,providerId:'codex',ownerChatId:'owner'})
  let probes=0,spike=true
  const warm=makeDependencyPrewarm({stateDir:f.state,db,idle:()=>true,log:()=>{},sampleLoad:()=>({load:spike && ++probes>=4?3:0,cores:2})});cleanup.push(()=>warm.stop())
  await warm.tick();expect(f.requests).toBe(0);expect(f.entries()).toEqual([])
  spike=false;await warm.tick();expect(f.requests).toBe(1);expect(f.entries()).toHaveLength(1)
},15_000)

it('includes resumed old dispatches but excludes imported sessions until actually dispatched', () => {
  const db=openTestDb();cleanup.push(()=>db.close());const store=makeWorkbenchStore(db),since=Date.now()-14*24*60*60_000
  const resumed=store.create({title:'resumed',path:'/resumed',providerId:'codex',ownerChatId:'owner'})
  db.query('UPDATE workbench_tasks SET created_at=? WHERE id=?').run(since-1,resumed.id)
  makeMatterLog(db).startTurn({matterId:resumed.id,executor:'codex'})
  const imported=store.importSource({title:'imported',path:'/imported',providerId:'codex',ownerChatId:'owner',nativeId:'native',cwd:'/imported',snapshotSha256:'a'.repeat(64),observedFingerprint:'fixture',snapshotJson:'{}',pagesJson:'[]',truncated:false,messages:[]})
  expect(recentDependencyProjects(db,since)).toContain('/resumed')
  expect(recentDependencyProjects(db,since)).not.toContain('/imported')
  store.markSourceDispatched(imported.task.id)
  expect(recentDependencyProjects(db,since)).toContain('/imported')
})
