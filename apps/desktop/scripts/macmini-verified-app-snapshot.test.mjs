import {test,expect} from 'vitest'
import {EventEmitter} from 'node:events'
import {Readable} from 'node:stream'
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,readdir,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {receiveBrowserSnapshot} from './macmini-browser-snapshot.mjs'
import {PUBLIC_CACHE_COMMIT,gitObject,manifestTree,sha256} from './macmini-source-manifest.mjs'

async function fixture() {
 const lab=await realpath(await mkdtemp(join(tmpdir(),'cc-verified-app-'))),cache=join(lab,'cache'),base=join(lab,'base')
 const contents={'README.md':'public','package.json':'{}','bun.lock':'fixture lock','apps/app/package.json':'{}'}
 for(const name of ['protocol','design-tokens','markdown']) {
  contents[`packages/${name}/package.json`]=JSON.stringify({name:`@wechat-cc/${name}`,main:'index.js'})
  contents[`packages/${name}/index.js`]='export {}'
 }
 for(const [path,bytes] of Object.entries(contents)){await mkdir(dirname(join(cache,'project',path)),{recursive:true});await writeFile(join(cache,'project',path),bytes)}
 await mkdir(base);await writeFile(join(base,'offline-tests.sb'),'offline fixture profile')
 await writeFile(join(cache,'snapshot.json'),JSON.stringify({commit:PUBLIC_CACHE_COMMIT}))
 const config={root:base,appRoot:join(lab,'previous-app'),browserRoot:join(lab,'previous-browser'),browserSourceRoot:cache,browserRuntimeRoot:base}
 const active=join(lab,'active.json');await writeFile(active,JSON.stringify(config))
 const files=Object.entries(contents).map(([path,bytes])=>({path,mode:'100644',blob:gitObject('blob',Buffer.from(bytes))}))
 const tree=manifestTree(files),commit=Buffer.from(`tree ${tree}\n\nfixture`),sha=gitObject('commit',commit),delta=Buffer.from('archive')
 const meta={commit:sha,tree,phase:'after',cacheCommit:PUBLIC_CACHE_COMMIT,files,deltaPaths:[],deltaSha256:sha256(delta),commitObjectBase64:commit.toString('base64')}
 const payload=()=>{const bytes=Buffer.from(JSON.stringify(meta)),length=Buffer.alloc(4);length.writeUInt32BE(bytes.length);return Readable.from([Buffer.concat([length,bytes,delta])])}
 const events=[]
 const run=(extra={})=>receiveBrowserSnapshot({mini:{labHome:lab,homeDir:join(lab,'home'),bun:'/fixture/bun'},sha,target:'app',selectActiveRoot:(config,root)=>({...config,appRoot:root}),input:payload(),log:()=>{},
  acquire:async options=>{events.push(`lock:${options.path}`);options.onAcquired(async()=>events.push('release'))},
  exec:(_file,args)=>args[0]==='-tvzf'?'-':'',
  spawnProcess:(_file,args,options)=>{
   const child=new EventEmitter();child.pid=123
   queueMicrotask(async()=>{try {
    if(args.includes('install')) {
     events.push('offline-install')
     await mkdir(join(options.cwd,'node_modules','@wechat-cc'),{recursive:true})
     for(const name of ['protocol','design-tokens','markdown'])await symlink(join(options.cwd,'packages',name),join(options.cwd,'node_modules','@wechat-cc',name),process.platform==='win32'?'junction':'dir')
    }
    child.emit('close',0)
   }catch(error){child.emit('error',error);child.emit('close',1)}})
   return child
  },...extra})
 return {lab,cache,config,active,meta,sha,tree,events,run}
}

test('verified App delta activates only appRoot, preserves Git source and never overlays browser harness',async()=>{
 const f=await fixture()
 try {
  await f.run()
  const next=JSON.parse(await readFile(f.active,'utf8')),root=next.appRoot
  expect(root.replaceAll('\\','/')).toContain(`/app-${f.sha}-`)
  expect({...next,appRoot:f.config.appRoot}).toEqual(f.config)
  const snapshot=JSON.parse(await readFile(join(root,'snapshot.json'),'utf8'))
  expect(snapshot).toMatchObject({commit:f.sha,sourceTree:f.tree,cacheCommit:PUBLIC_CACHE_COMMIT,harnessFiles:[],phase:'after'})
  for(const key of ['archiveSha256','manifestSha256','lockfileSha256','profileSha256'])expect(snapshot[key]).toMatch(/^[a-f0-9]{64}$/)
  expect(await readFile(join(root,'project','README.md'),'utf8')).toBe('public')
  expect(f.events).toEqual([`lock:${join(f.lab,'home','ci/lock')}`,'offline-install','release'])
 }finally{await rm(f.lab,{recursive:true,force:true})}
})

for(const damage of ['before','digest','commit','cache-commit','cache-blob'])test(`verified App rejects ${damage} and cleans its partial snapshot without activation`,async()=>{
 const f=await fixture()
 try {
  if(damage==='before')f.meta.phase='before'
  if(damage==='digest')f.meta.deltaSha256='0'.repeat(64)
  if(damage==='commit')f.meta.commit='0'.repeat(40)
  if(damage==='cache-commit')await writeFile(join(f.cache,'snapshot.json'),JSON.stringify({commit:'0'.repeat(40)}))
  if(damage==='cache-blob')await writeFile(join(f.cache,'project','README.md'),'changed')
  await expect(f.run()).rejects.toThrow()
  expect(JSON.parse(await readFile(f.active,'utf8'))).toEqual(f.config)
  expect((await readdir(f.lab)).filter(name=>name.startsWith('app-'))).toEqual([])
  expect(f.events.at(-1)).toBe('release')
  expect(f.events).not.toContain('offline-install')
 }finally{await rm(f.lab,{recursive:true,force:true})}
})
