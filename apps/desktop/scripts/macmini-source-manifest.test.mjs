import { test, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { gitObject, manifestTree, verifySourceManifest, sourcePath, PUBLIC_CACHE_COMMIT, sha256 } from './macmini-source-manifest.mjs'
test('manifest reconstructs the actual Git tree and ties it to the target commit',()=>{
 const root=mkdtempSync(join(tmpdir(),'cc-browser-manifest-'))
 const git=(...args)=>execFileSync('git',['-C',root,...args])
 try {
  git('init','-q');writeFileSync(join(root,'request.txt'),'hello\n');writeFileSync(join(root,'reply.txt'),'answer\n');git('add','.')
  git('-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','synthetic source')
  const commit=git('rev-parse','HEAD').toString().trim(),tree=git('rev-parse','HEAD^{tree}').toString().trim()
  const files=git('ls-tree','-rz','HEAD').toString().split('\0').filter(Boolean).map(row=>{const [entry,path]=row.split('\t');const [mode,,blob]=entry.split(' ');return{path,mode,blob}})
  expect(gitObject('blob',Buffer.from('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
  expect(manifestTree(files)).toBe(tree)
  const meta={commit,tree,phase:'before',cacheCommit:PUBLIC_CACHE_COMMIT,files,deltaPaths:['request.txt'],deltaSha256:sha256(Buffer.from('archive')),commitObjectBase64:git('cat-file','commit','HEAD').toString('base64')}
  expect(verifySourceManifest(meta)).toBe(meta)
  expect(()=>verifySourceManifest({...meta,files:[{...files[0],blob:'0'.repeat(40)},files[1]]})).toThrow('match target commit')
  expect(()=>verifySourceManifest({...meta,deltaPaths:['outside.txt']})).toThrow('outside target tree')
 }finally{rmSync(root,{recursive:true,force:true})}
})
test('source paths reject escapes, account/workspace dependencies, aliases and collisions',()=>{
 for(const path of ['/tmp/private','../private','a/../private','.git/config','node_modules/a','a\nprivate'])expect(()=>sourcePath(path)).toThrow('Unsafe source path')
 const file={path:'safe',mode:'100644',blob:'0'.repeat(40)}
 expect(()=>manifestTree([file,file])).toThrow('Duplicate')
 expect(()=>manifestTree([file,{...file,path:'safe/child'}])).toThrow('collision')
 expect(()=>manifestTree([{...file,mode:'120000'}])).toThrow('Unsupported')
})

test('signal cleanup waits for activation and preserves an atomically selected source root',async()=>{
 const {removeInactiveSnapshot}=await import('./macmini-source-manifest.mjs')
 const {mkdir,writeFile,access}=await import('node:fs/promises')
 const root=mkdtempSync(join(tmpdir(),'cc-browser-activation-')),source=join(root,'source'),active=join(root,'active.json')
 let resolve;const activation=new Promise(r=>resolve=r)
 try {
  await mkdir(source);await writeFile(active,JSON.stringify({browserRoot:'previous'}))
  const cleanup=removeInactiveSnapshot(source,active,activation)
  await writeFile(active,JSON.stringify({browserRoot:source}));resolve();expect(await cleanup).toBe(false);await access(source)
  await writeFile(active,JSON.stringify({browserRoot:'previous'}));expect(await removeInactiveSnapshot(source,active,Promise.resolve())).toBe(true)
  await expect(access(source)).rejects.toThrow()
 }finally{rmSync(root,{recursive:true,force:true})}
})
