// Browser-only source transport: Git archive delta + a fully verified public source cache.
import { spawn, execFileSync } from 'node:child_process'
import * as nativeFs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { jobLifecycle } from './macmini-job-lifecycle.mjs'
import { acquireMachineLock, machineGateOptions } from './macmini-machine-lock.mjs'
import { isInsideLab, miniConfiguration, sshInvocation } from './macmini-ui-protocol.mjs'
import { PUBLIC_CACHE_COMMIT, sha256, gitObject, verifySourceManifest, sourcePath, removeInactiveSnapshot } from './macmini-source-manifest.mjs'
const finished = child => new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error(`Snapshot process exited ${code}`)))})
export async function receiveBrowserSnapshot({mini,sha,target='browser',selectActiveRoot,lifecycle=jobLifecycle(),input=process.stdin,fs={},spawnProcess=spawn,acquire=acquireMachineLock,exec=execFileSync,log=console.log,removeSnapshot=removeInactiveSnapshot}) {
 // Every asynchronous filesystem boundary checks cancellation on both sides.
 const guardedFs=Object.fromEntries(Object.entries({...nativeFs,...fs}).map(([name,operation])=>[name,async(...args)=>{
  lifecycle.assertRunning();const value=await operation(...args);lifecycle.assertRunning();return value
 }]))
 const {mkdir,readFile,writeFile,rename,realpath,copyFile,rm,lstat,chmod}=guardedFs
 let root,activated=false,activation
 const activePath=join(mini.labHome,'active.json')
 let receivingDone
 const received=new Promise(resolve=>receivingDone=resolve)
 let cleanupPromise
 const cleanup=()=>cleanupPromise??=removeSnapshot(root,activePath,activation)
 lifecycle.onStop(async()=>{input.destroy?.();await received;await cleanup()})
 try {
  if(!['browser','app'].includes(target))throw Error('Invalid snapshot target')
  if(target==='app'&&typeof selectActiveRoot!=='function')throw Error('App entry must supply its own activation')
  await acquire({path:join(mini.homeDir,'ci/lock'),lane:`${target}-snapshot`,sha,...machineGateOptions(),onAcquired:lifecycle.acquired,assertRunning:lifecycle.assertRunning})
  lifecycle.assertRunning()
  // Bound the entire compressed request; never buffer a full repository archive.
  const chunks=[];let size=0
  log(JSON.stringify({step:'receive-delta',commit:sha}))
  for await(const chunk of input){lifecycle.assertRunning();size+=chunk.length;if(size>32*1024*1024)throw Error('Source request exceeds limit');chunks.push(chunk)}
  const payload=Buffer.concat(chunks),length=payload.readUInt32BE(0)
  if(length>2*1024*1024||length+4>payload.length)throw Error('Invalid source manifest framing')
  const manifestBytes=payload.subarray(4,4+length),meta=verifySourceManifest(JSON.parse(manifestBytes.toString())),delta=payload.subarray(4+length)
  if(target==='app'&&meta.phase!=='after')throw Error('App snapshot requires a verified candidate')
  if(meta.commit!==sha||sha256(delta)!==meta.deltaSha256)throw Error('Archive identity mismatch')
  const config=JSON.parse(await readFile(activePath,'utf8'))
  const base=await realpath(config.browserRuntimeRoot??config.root),cacheRoot=config.browserSourceRoot??config.appRoot,cache=await realpath(join(cacheRoot,'project'))
  if(!isInsideLab(mini.labHome,base)||!isInsideLab(mini.labHome,cache))throw Error('Source cache leaves lab')
  if(JSON.parse(await readFile(join(cacheRoot,'snapshot.json'),'utf8')).commit!==PUBLIC_CACHE_COMMIT)throw Error('Public source cache commit changed')
  root=join(mini.labHome,`${target}-${sha}-${Date.now()}`);const project=join(root,'project')
  await mkdir(join(root,'project'),{recursive:true,mode:0o700})
  const archive=join(root,'delta.tar.gz');await writeFile(archive,delta,{mode:0o600})
  const paths=exec('/usr/bin/tar',['-tzf',archive],{encoding:'utf8'}).trim().split('\n').filter(Boolean)
  const types=exec('/usr/bin/tar',['-tvzf',archive],{encoding:'utf8'}).trim().split('\n')
  if(types.some(row=>!/^[-d]/.test(row)))throw Error('Archive links are forbidden')
  const expected=new Set(meta.deltaPaths)
  for(const path of paths){const clean=sourcePath(path.endsWith('/')?path.slice(0,-1):path);if(!expected.has(clean)&&!meta.deltaPaths.some(p=>p.startsWith(clean+'/')))throw Error('Unexpected archive path')}
  log(JSON.stringify({step:'materialize-source',root,receivedBytes:size,cacheCommit:PUBLIC_CACHE_COMMIT}))
  for(const file of meta.files)if(!expected.has(file.path)) {
   const cachedPath=join(cache,file.path)
   if(!(await lstat(cachedPath)).isFile())throw Error('Source cache must be a regular file')
   const source=await realpath(cachedPath)
   if(!isInsideLab(cache,source))throw Error('Source cache path escapes')
   const bytes=await readFile(source)
   if(gitObject('blob',bytes)!==file.blob)throw Error(`Public source cache mismatch: ${file.path}`)
   const target=join(project,file.path);await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes);await chmod(target,file.mode==='100755'?0o755:0o644)
  }
  lifecycle.assertRunning()
  const tar=spawnProcess('/usr/bin/tar',['-xzf',archive,'-C',project],{detached:true,stdio:'inherit'});lifecycle.track(tar);await finished(tar);lifecycle.assertRunning()
  for(const file of meta.files){const target=join(project,file.path);await chmod(target,file.mode==='100755'?0o755:0o644);const stat=await lstat(target);if(!stat.isFile()||gitObject('blob',await readFile(target))!==file.blob||(stat.mode&0o111)!==(file.mode==='100755'?0o111:0))throw Error(`Target source mismatch: ${file.path}`)}
  const harnessFiles=[]
  for(const [name,path] of target==='browser'?[['design-unify-shots.spec.ts','apps/desktop/playwright/design-unify-shots.spec.ts'],['cc-alive-shots.spec.ts','apps/desktop/playwright/cc-alive-shots.spec.ts'],['playwright.config.ts','apps/desktop/playwright.config.ts']]:[]){const harness=join(mini.labHome,'browser-executor',name),bytes=await readFile(harness);await copyFile(harness,join(project,path));harnessFiles.push({path,sha256:sha256(bytes)})}
  const profile=await readFile(join(base,'offline-tests.sb'));await writeFile(join(root,'offline-tests.sb'),profile)
  const env={PATH:`${mini.homeDir}/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin`,HOME:join(root,'home'),BUN_INSTALL_CACHE_DIR:join(mini.homeDir,'.bun/install/cache')};await mkdir(env.HOME,{mode:0o700})
  lifecycle.assertRunning()
  const install=spawnProcess('/usr/bin/sandbox-exec',['-f',join(root,'offline-tests.sb'),mini.bun,'install','--frozen-lockfile','--ignore-scripts'],{cwd:project,env,detached:true,stdio:'inherit'});lifecycle.track(install);await finished(install);lifecycle.assertRunning()
  const resolveFromProject=createRequire(join(project,'package.json'))
  for(const name of ['protocol','design-tokens','markdown']){const from=name==='protocol'?project:join(project,'apps/app'),entry=await realpath(resolveFromProject.resolve(`@wechat-cc/${name}`,{paths:[from]}));if(!isInsideLab(join(project,'packages',name),entry))throw Error('Workspace dependency leaves snapshot')}
  const snapshot={commit:sha,sourceTree:meta.tree,archiveSha256:meta.deltaSha256,manifestSha256:sha256(manifestBytes),cacheCommit:PUBLIC_CACHE_COMMIT,receivedBytes:size,harnessFiles,lockfileSha256:sha256(await readFile(join(project,'bun.lock'))),profileSha256:sha256(profile),phase:meta.phase,created:new Date().toISOString()}
  await writeFile(join(root,'snapshot.json'),JSON.stringify(snapshot,null,2));await rm(archive)
  lifecycle.assertRunning()
  // App pointer ownership stays in the App entry; stdin cannot choose activation.
  const next=selectActiveRoot?selectActiveRoot(config,root):{...config,browserRoot:root}
  activation=(async()=>{await writeFile(activePath+`.${target}-next`,JSON.stringify(next,null,2),{mode:0o600});await rename(activePath+`.${target}-next`,activePath)})();await activation;activated=true
  log(JSON.stringify({[`${target}Root`]:root,...snapshot}))
 }finally{receivingDone();try{if(root&&!activated)await cleanup()}finally{await lifecycle.finish()}}
}

/** Tracked immutable Git source only; shared by the two strict lab transports. */
export function verifiedSourcePayload({repo,sha,phase='after'}) {
 const git=(...args)=>execFileSync('/usr/bin/git',['-C',repo,...args],{maxBuffer:128*1024*1024})
 const tree=git('rev-parse',`${sha}^{tree}`).toString().trim()
 const files=git('ls-tree','-rz',sha).toString().split('\0').filter(Boolean).map(row=>{const [entry,path]=row.split('\t');const [mode,kind,blob]=entry.split(' ');if(kind!=='blob')throw Error('Unsupported source kind');return{path,mode,blob}})
 const deltaPaths=[...new Set([...git('diff','--name-only','-z','--no-renames','--diff-filter=ACMRT',PUBLIC_CACHE_COMMIT,sha).toString().split('\0').filter(Boolean),'package.json','apps/app/package.json','apps/app/app.json',...files.filter(f=>f.path.startsWith('apps/app/.maestro/')||f.path==='apps/app/.gitignore').map(f=>f.path)])]
 const delta=git('archive','--format=tar.gz',sha,'--',...deltaPaths)
 const meta={commit:sha,tree,phase,cacheCommit:PUBLIC_CACHE_COMMIT,files,deltaPaths,deltaSha256:sha256(delta),commitObjectBase64:git('cat-file','commit',sha).toString('base64')};verifySourceManifest(meta)
 const header=Buffer.from(JSON.stringify(meta)),length=Buffer.alloc(4);length.writeUInt32BE(header.length)
 return Buffer.concat([length,header,delta])
}
export const supportsBrowserSnapshot = branch => ['phone-connect-relay','cc-alive-2','design-unify-b1','design-unify-b1-fixes','codex-hook-trust-ux','topics-are-projects','topics-waiting-honest','design-b3','mobile-budget'].includes(branch)

export async function main() {
 if(process.argv[2]==='--receive') {
 const mini=miniConfiguration({computerName:execFileSync('/usr/sbin/scutil',['--get','ComputerName'],{encoding:'utf8'}).trim(),homeDir:homedir(),platformName:process.platform})
 const sha=process.argv[3];if(!/^[a-f0-9]{40}$/.test(sha??''))throw Error('Expected immutable source commit')
 await receiveBrowserSnapshot({mini,sha})
 } else {
 const phase=process.argv[2]??'after';if(!['before','after'].includes(phase))throw Error('Use before or after')
 const repo=fileURLToPath(new URL('../../..',import.meta.url)),git=(...args)=>execFileSync('/usr/bin/git',['-C',repo,...args],{maxBuffer:128*1024*1024})
 if(!supportsBrowserSnapshot(git('branch','--show-current').toString().trim()))throw Error('This task transport requires an explicitly authorized UI branch')
 const sha=git(...(phase==='before'?['merge-base','HEAD','origin/dev']:['rev-parse','HEAD'])).toString().trim()
 const payload=verifiedSourcePayload({repo,sha,phase})
 const transport=sshInvocation('browser',process.argv[3]??'home',process.env.CC_UI_SSH_CONFIG,undefined,process.env),args=[...transport.args]
 args[args.length-1]=args.at(-1).replace(/browser-run\.mjs$/,`browser-snapshot.mjs --receive ${sha}`)
 const remote=spawn(transport.file,args,{stdio:['pipe','inherit','inherit']});remote.stdin.on('error',()=>{});const done=finished(remote);remote.stdin.end(payload);await done
}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main()
