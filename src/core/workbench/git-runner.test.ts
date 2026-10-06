import {afterEach,expect,it} from 'vitest'
import {chmodSync,linkSync,mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs'
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
