import {test,expect} from 'vitest'
import {EventEmitter} from 'node:events'
import {Readable, Writable} from 'node:stream'
import * as fs from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {jobLifecycle} from './macmini-job-lifecycle.mjs'
import {receiveAppSnapshot} from './macmini-app-snapshot.mjs'
for(const stage of ['mkdir','realpath'])test(`App snapshot cancellation in ${stage} never starts tar after releasing ownership`,async()=>{
 const processRef=new EventEmitter(),events=[]
 processRef.exit=code=>events.push(`exit:${code}`);processRef.kill=()=>{}
 const lifecycle=jobLifecycle({processRef})
 let resume,entered
 const paused=new Promise(r=>entered=r),gate=new Promise(r=>resume=r)
 const wait=async()=>{entered();await gate}
 const run=receiveAppSnapshot({mini:{labHome:'/lab',homeDir:'/home/test'},sha:'a'.repeat(40),lifecycle,input:{pipe(){},destroy(){}},
  removeSnapshot:async()=>{},
  acquireMachineLock:async options=>options.onAcquired(async()=>events.push('release')),
  fs:{mkdir:async()=>{if(stage==='mkdir')await wait()},realpath:async path=>{if(stage==='realpath')await wait();return path},readFile:async()=>JSON.stringify({root:'/lab/base'}),writeFile:async()=>{},rename:async()=>events.push('activate')},
  spawnProcess:()=>{events.push('tar');const child=new EventEmitter();child.pid=1;setImmediate(()=>child.emit('close',0));return child},
 }).catch(e=>e)
 await paused;processRef.emit('SIGTERM');await new Promise(r=>setImmediate(r))
 const earlyRelease=events.includes('release');resume();const error=await run
 expect(earlyRelease).toBe(false);expect(events).not.toContain('tar');expect(events).not.toContain('activate')
 expect(error.message).toContain('stopping');expect(events).toContain('release')
})

test('App snapshots check the commit is pushed and default new refs to the verified transport',async()=>{
 const {supportsAppSnapshot}=await import('./macmini-app-snapshot.mjs')
 expect(supportsAppSnapshot('matter-ledger-step1')).toBe(true)
 const source=await import('node:fs/promises').then(fs=>fs.readFile(new URL('./macmini-app-snapshot.mjs',import.meta.url),'utf8'))
 expect(source).toContain('assertPushedSource(')
 expect(source).toContain('const verified = !FULL_ARCHIVE_REFS.has(ref)')
})

test('archive App activates through the lab symlink before pruning under the lock', async () => {
 const temp = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'cc-archive-app-')))
 const lab = join(temp, 'disk'), labHome = join(temp, 'legacy'), activePath = join(lab, 'active.json')
 const stale = join(lab, `app-${'a'.repeat(40)}-1`)
 const events = []
 try {
  await fs.mkdir(lab)
  await fs.symlink(lab, labHome, process.platform === 'win32' ? 'junction' : 'dir')
  for (const timestamp of [1, 2, 3]) await fs.mkdir(join(lab, `app-${'a'.repeat(40)}-${timestamp}`))
  await fs.writeFile(activePath, '{}')
  const sha = 'b'.repeat(40)
  await receiveAppSnapshot({
   mini: { labHome, homeDir: temp }, sha, input: Readable.from([Buffer.from('archive')]),
   acquireMachineLock: async options => options.onAcquired(async () => events.push('release')),
   fs: { rm: async (path, options) => {
    expect(path).toBe(stale)
    expect(JSON.parse(await fs.readFile(activePath, 'utf8')).appRoot).toContain(join(labHome, `app-${sha}-`))
    expect(events).not.toContain('release')
    events.push('pruned')
    await fs.rm(path, options)
   } },
   spawnProcess: () => {
    const child = new EventEmitter()
    child.pid = 123
    child.stdin = new Writable({ write(_chunk, _encoding, done) { done() } })
    child.stdin.once('finish', () => child.emit('close', 0))
    return child
   },
  })
  expect(events).toEqual(['pruned', 'release'])
  await expect(fs.access(stale)).rejects.toThrow()
 } finally {
  await fs.rm(temp, { recursive: true, force: true })
 }
})
