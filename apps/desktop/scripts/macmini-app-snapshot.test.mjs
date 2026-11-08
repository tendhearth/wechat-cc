import {test,expect} from 'vitest'
import {EventEmitter} from 'node:events'
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
