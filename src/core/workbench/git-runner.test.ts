import {afterEach,expect,it} from 'vitest'
import {execFileSync} from 'node:child_process'
import {chmodSync,linkSync,mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync,existsSync,unlinkSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createGitRunner} from './git-runner'
const dirs:string[]=[]
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true})})
it.skipIf(process.platform==='win32')('bounds an actual hung Git process and its child without blocking the event loop',async()=>{
  const base=realpathSync(mkdtempSync(join(tmpdir(),'cc-git-runner-')));dirs.push(base);mkdirSync(join(base,'bin'));const executable=join(base,'bin','git')
  writeFileSync(executable,'#!/bin/sh\n/bin/sleep 10\n');chmodSync(executable,0o755)
  const original=process.env.PATH;process.env.PATH=join(base,'bin');let timerRan=false;const timer=setTimeout(()=>{timerRan=true},5)
  try{await expect(createGitRunner({timeoutMs:50}).run(base,['status'])).rejects.toThrow('git_timeout');expect(timerRan).toBe(true)}finally{process.env.PATH=original;clearTimeout(timer)}
})
it('rejects a private index outside its pinned private root before spawning Git',async()=>{
  const base=realpathSync(mkdtempSync(join(tmpdir(),'cc-git-runner-')));dirs.push(base)
  await expect(createGitRunner({privateIndexRoot:base}).run(base,['status'],{privateIndexPath:join(tmpdir(),'foreign-index')})).rejects.toThrow('git_invalid_private_index')
})

it('rejects a hard-linked private index rather than modifying another index through an alias',async()=>{
  const base=realpathSync(mkdtempSync(join(tmpdir(),'cc-git-runner-')));dirs.push(base);const privateRoot=join(base,'private');mkdirSync(privateRoot)
  const original=join(base,'real-index');writeFileSync(original,'preserve real index');linkSync(original,join(privateRoot,'index'))
  await expect(createGitRunner({privateIndexRoot:privateRoot}).run(base,['status'],{privateIndexPath:join(privateRoot,'index')})).rejects.toThrow('git_invalid_private_index')
})

it.skipIf(process.platform==='win32')('refuses missing promisor objects without implicitly executing the configured uploadpack',async()=>{
  const base=realpathSync(mkdtempSync(join(tmpdir(),'cc-git-runner-')));dirs.push(base);const source=join(base,'source');mkdirSync(source)
  const git=(cwd:string,...args:string[])=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.test',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.test'}}).trim()
  git(source,'init','-b','main');writeFileSync(join(source,'file.txt'),'base');git(source,'add','.');git(source,'commit','-m','base')
  const remote=join(base,'remote.git');git(base,'clone','--bare',source,remote);git(source,'remote','add','origin',remote);git(source,'config','remote.origin.promisor','true');git(source,'config','remote.origin.partialclonefilter','blob:none');git(remote,'config','uploadpack.allowFilter','true')
  const sentinel=join(base,'unexpected-fetch'),script=join(base,'upload-pack');writeFileSync(script,'#!/bin/sh\nprintf fetched > "'+sentinel+'"\nexec git-upload-pack "$@"\n');chmodSync(script,0o755);git(source,'config','remote.origin.uploadpack',script)
  const blob=git(source,'rev-parse','HEAD:file.txt'),object=join(source,'.git','objects',blob.slice(0,2),blob.slice(2));unlinkSync(object)
  let outcome=''
  try{outcome=(await createGitRunner().run(source,['cat-file','blob',blob])).toString()}catch(error){outcome=(error as Error).message}
  expect({outcome,externalProgramExecuted:existsSync(sentinel)}).toEqual({outcome:'git_failed',externalProgramExecuted:false});expect(existsSync(object)).toBe(false)
})

it.skipIf(process.platform==='win32')('fails closed when Git does not recognize the required no-lazy-fetch option',async()=>{
  const base=realpathSync(mkdtempSync(join(tmpdir(),'cc-git-runner-')));dirs.push(base);const bin=join(base,'bin');mkdirSync(bin)
  const sentinel=join(base,'command-ran'),executable=join(bin,'git')
  writeFileSync(executable,'#!/bin/sh\ncase "$1" in --no-lazy-fetch) exit 129;; esac\nprintf ran > "'+sentinel+'"\n');chmodSync(executable,0o755)
  const original=process.env.PATH;process.env.PATH=bin
  try{await expect(createGitRunner().run(base,['status'])).rejects.toThrow('git_failed');expect(existsSync(sentinel)).toBe(false)}finally{process.env.PATH=original}
})
