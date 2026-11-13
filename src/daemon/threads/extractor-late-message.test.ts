import { expect, it } from 'vitest'
import { openTestDb } from '../../lib/db'
import { makeMessagesStore } from '../../lib/messages-store'
import { makeThreadsStore } from '../../lib/threads-store'
import { runThreadsExtraction } from './extractor'

for(const offset of [0,-500]) it(`reaccounts a newly inserted message at watermark ${offset}ms`,async()=>{
  const db=openTestDb(),messages=makeMessagesStore(db),threads=makeThreadsStore(db),t=Date.UTC(2026,10,13)
  const append=(id:string,at:number)=>messages.append({id,chatId:'c',ts:new Date(at).toISOString(),direction:'in',kind:'text',text:id,source:'live'})
  try {
    await append('seen',t);await threads.setExtractState('c',{entriesToTs:new Date(t).toISOString()})
    await append('late-original',t+offset)
    let input=''
    await runThreadsExtraction({chatId:'c',messages,threads,sdkEval:async p=>{input+=p;return '{"ops":[]}'},recordEvent:async()=>{},log:()=>{}})
    expect(input).toContain('late-original')
    expect((await threads.getExtractState('c')).entriesToTs).toBe(new Date(t).toISOString())
  }finally{db.close()}
})
it('does not let an in-flight extraction overwrite a rewind or miss an insertion inside its batch',async()=>{
  for(const offset of [-500,0,500]){
    const db=openTestDb(),messages=makeMessagesStore(db),threads=makeThreadsStore(db),t=Date.UTC(2026,10,13)
    const append=(id:string,at:number)=>messages.append({id,chatId:'c',ts:new Date(at).toISOString(),direction:'in',kind:'text',text:id,source:'live'})
    try{
      await append('seen',t);await threads.setExtractState('c',{entriesToTs:new Date(t).toISOString()});await append('next',t+1000)
      await runThreadsExtraction({chatId:'c',messages,threads,maxRounds:1,sdkEval:async()=>{await append('arrived-during-eval',t+offset);return '{"ops":[]}'},recordEvent:async()=>{},log:()=>{}})
      expect(Date.parse((await threads.getExtractState('c')).entriesToTs!)).toBeLessThan(t+offset)
      let input=''
      await runThreadsExtraction({chatId:'c',messages,threads,sdkEval:async p=>{input+=p;return '{"ops":[]}'},recordEvent:async()=>{},log:()=>{}})
      expect(input).toContain('arrived-during-eval')
    }finally{db.close()}
  }
})
it('finishes its frozen batch while later ordinary messages arrive during model latency',async()=>{
 const db=openTestDb(),messages=makeMessagesStore(db),threads=makeThreadsStore(db),t=Date.UTC(2026,10,13)
 try{
  await messages.append({id:'old',chatId:'c',ts:new Date(t).toISOString(),direction:'in',kind:'text',text:'old',source:'live'})
  await runThreadsExtraction({chatId:'c',messages,threads,maxRounds:1,sdkEval:async()=>{
   await messages.append({id:'newer',chatId:'c',ts:new Date(t+1000).toISOString(),direction:'in',kind:'text',text:'newer',source:'live'})
   return '{"ops":[]}'
  },recordEvent:async()=>{},log:()=>{}})
  expect((await threads.getExtractState('c')).entriesToTs).toBe(new Date(t).toISOString())
 }finally{db.close()}
})
it('actually presents a long original middle to extraction before advancing its timestamp',async()=>{
 const db=openTestDb(),messages=makeMessagesStore(db),threads=makeThreadsStore(db),ts='2026-11-13T00:00:00.000Z'
 try{
  await messages.append({id:'long',chatId:'c',ts,direction:'in',kind:'text',text:'头'.repeat(8000)+'中段决定周二发青松周报'+'尾'.repeat(8000),source:'live'})
  let presented=false
  await runThreadsExtraction({chatId:'c',messages,threads,sdkEval:async p=>{presented=p.includes('中段决定周二发青松周报');return '{"ops":[]}'},recordEvent:async()=>{},log:()=>{}})
  expect(presented).toBe(true)
  expect((await threads.getExtractState('c')).entriesToTs).toBe(ts)
 }finally{db.close()}
})
