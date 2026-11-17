import {it,expect} from 'vitest'
import {mkdtempSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {openTestDb} from '../../lib/db'
import {removeTempDir} from '../../lib/test-temp'
import {makeThreadsStore} from '../../lib/threads-store'
import {ContextRotation} from '../../app/context-rotation'
import {consolidateAfterSleep} from './topic-sleep'

for(const failure of [false,true])it(`nightly consolidation ${failure?'failure does not request':'success requests exactly one'} rotation`,async()=>{
 const db=openTestDb(),dir=mkdtempSync(join(tmpdir(),'nightly-rotation-'))
 let rotations=0
 try{
  if(failure){const threads=makeThreadsStore(db),id=await threads.create({chatId:'owner',title:'相册',facets:['task'],tags:[],private:false,summary:'相册',episodes:[]});for(let i=0;i<5;i++)await threads.addEntry({threadId:id,kind:'progress',line:`相册整理进度 ${i}`})}
  const context=new ContextRotation({owner:()=> 'owner',load:()=>({sessions:{},chats:{}}),save:()=>{},budgetFor:()=>({windowTokens:8192,reliableFillRatio:.25}),pending:()=>false,recent:async()=>[],ongoing:async()=>[],latestTs:async()=>'2026-11-12T20:00:00Z',accounted:async()=>true,extract:async()=>true,defer:()=>{},log:()=>{}})
  const key={chatId:'owner',providerId:'claude',alias:'proj'},sessions={isInFlight:()=>false,rotate:async()=>{rotations++;return true}}
  await context.beforeTurn(key,'m',sessions)
  context.observe(key,{tokens:1000,turns:1});context.observe(key,{tokens:6000,turns:7})
  await consolidateAfterSleep({chatId:'owner',isOwner:()=>true,threads:makeThreadsStore(db,{filterSources:true}),sdkEval:async()=> 'bad consolidation response',rotation:context,sessions,runExclusive:async(_c,fn)=>fn(),log:()=>{}})
  expect(rotations).toBe(failure?0:1)
  await context.beforeTurn(key,'m',sessions);await context.beforeTurn(key,'m',sessions)
  expect(rotations).toBe(failure?0:1)
 }finally{db.close();removeTempDir(dir)}
})
