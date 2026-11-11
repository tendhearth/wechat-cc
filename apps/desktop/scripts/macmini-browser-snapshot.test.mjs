import {test,expect} from 'vitest'
import {EventEmitter} from 'node:events'
import {Readable} from 'node:stream'
import {receiveBrowserSnapshot} from './macmini-browser-snapshot.mjs'
import {jobLifecycle} from './macmini-job-lifecycle.mjs'
import {PUBLIC_CACHE_COMMIT,gitObject,manifestTree,sha256} from './macmini-source-manifest.mjs'
// 夹具按 POSIX 路径比对;Windows 上 path.join 给反斜杠,先统一再比(接收器本身只在 mini 上跑)。
const n=path=>String(path).replaceAll('\\','/')
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}}
for(const target of ['browser','app'])for(const stage of ['materialize','home']) test(`${target==='app'?'App ':''}cancel during ${stage} await stops receiver before later spawn and lock release`,async()=>{
 const processRef=new EventEmitter(),events=[],entered=deferred(),gate=deferred()
 processRef.kill=()=>{};processRef.exit=code=>events.push(`exit:${code}`)
 const lifecycle=jobLifecycle({processRef})
 const file={path:'README.md',mode:'100644',blob:gitObject('blob',Buffer.from('public'))}
 const tree=manifestTree([file]),commitBytes=Buffer.from(`tree ${tree}\n\nsynthetic`),sha=gitObject('commit',commitBytes),delta=Buffer.from('archive')
 const meta={commit:sha,tree,phase:'after',cacheCommit:PUBLIC_CACHE_COMMIT,files:[file],deltaPaths:[],deltaSha256:sha256(delta),commitObjectBase64:commitBytes.toString('base64')}
 const bytes=Buffer.from(JSON.stringify(meta)),length=Buffer.alloc(4);length.writeUInt32BE(bytes.length)
 const config={root:'/lab/base',appRoot:'/lab/cache'}
 const pause=async()=>{entered.resolve();await gate.promise;events.push('fs-done')}
 const fs={
  realpath:async path=>path,lstat:async()=>({isFile:()=>true,mode:0o644}),chmod:async()=>{},copyFile:async()=>{},rm:async()=>{},rename:async()=>events.push('activate'),
  mkdir:async path=>{if(stage==='home'&&n(path).endsWith('/home'))await pause()},
  writeFile:async path=>{if(stage==='materialize'&&n(path).endsWith('/README.md'))await pause()},
  readFile:async path=>n(path).endsWith('/lab/active.json')?JSON.stringify(config):n(path).endsWith('/lab/cache/snapshot.json')?JSON.stringify({commit:PUBLIC_CACHE_COMMIT}):n(path).endsWith('README.md')?Buffer.from('public'):Buffer.from('fixture'),
 }
 const run=receiveBrowserSnapshot({mini:{labHome:'/lab',homeDir:'/home/test',bun:'/bun'},sha,target,...(target==='app'?{selectActiveRoot:(config,root)=>({...config,appRoot:root})}:{}),lifecycle,input:Readable.from([Buffer.concat([length,bytes,delta])]),fs,
  acquire:async options=>options.onAcquired(async()=>events.push('release')),
  exec:(_file,args)=>args[0]==='-tvzf'?'-':'',log:()=>{},removeSnapshot:async()=>events.push('cleanup'),
  spawnProcess:(_file,args)=>{events.push(args.includes('install')?'install':'tar');const child=new EventEmitter();child.pid=123;setImmediate(()=>child.emit('close',0));return child},
 }).catch(error=>error)
 await entered.promise
 processRef.emit('SIGTERM');await new Promise(r=>setImmediate(r))
 // Even an in-flight filesystem write must finish before cleanup and ownership release.
 const releasedEarly=events.includes('release')
 gate.resolve();const result=await run
 expect(releasedEarly).toBe(false)
 expect(events).not.toContain('install')
 expect(events).not.toContain('activate')
 if(stage==='materialize')expect(events).not.toContain('tar')
 expect(result.message).toContain('stopping')
 expect(events.indexOf('fs-done')).toBeLessThan(events.indexOf('cleanup'))
 expect(events.indexOf('cleanup')).toBeLessThan(events.indexOf('release'))
})

for(const target of ['browser','app'])for(const stage of ['lock-wait','stdin'])test(`${target==='app'?'App ':''}cancels ${stage} without an unhandled stdin error or premature release`,async()=>{
 const processRef=new EventEmitter(),events=[],entered=deferred(),gate=deferred()
 processRef.kill=()=>{};processRef.exit=code=>events.push(`exit:${code}`)
 const lifecycle=jobLifecycle({processRef})
 const input=new Readable({read(){entered.resolve()}})
 input.on('error',()=>events.push('stdin-error'))
 const run=receiveBrowserSnapshot({mini:{labHome:'/lab',homeDir:'/home/test'},sha:'a'.repeat(40),target,...(target==='app'?{selectActiveRoot:(config,root)=>({...config,appRoot:root})}:{}),input,lifecycle,
  acquire:async options=>{options.onAcquired(async()=>events.push('release'));if(stage==='lock-wait'){entered.resolve();await gate.promise}},
  removeSnapshot:async()=>{},spawnProcess:()=>{throw Error('Unexpected spawn')},
 }).catch(e=>e)
 await entered.promise;processRef.emit('SIGTERM');await new Promise(r=>setImmediate(r))
 if(stage==='lock-wait')expect(events).not.toContain('release')
 gate.resolve();await run
 expect(events).not.toContain('stdin-error')
 expect(events).toContain('release');expect(events).toContain('exit:143')
})
