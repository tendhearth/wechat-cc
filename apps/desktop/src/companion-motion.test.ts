import {expect,test} from 'vitest'

async function fixture(context?:()=>Promise<any>,step?:(p:any)=>Promise<void>){
  const module=await import('./companion-motion.js').catch(()=>({createCompanionMotion:undefined}))
  expect(typeof module.createCompanionMotion).toBe('function')
  let time=0,id=0
  const jobs=new Map<number,()=>void>(),moves:any[]=[],stops:string[]=[]
  const control=module.createCompanionMotion!({context:context??(async()=>({token:7,minOffset:-48,maxOffset:48})),step:async(p:any)=>{moves.push(p);await step?.(p)},stop:async()=>{stops.push('stop')},now:()=>time,schedule:(fn:()=>void)=>{jobs.set(++id,fn);return id},cancel:(h:unknown)=>jobs.delete(Number(h)),onError:()=>{}})
  return {control,moves,stops,async tick(ms:number){time+=ms;const pending=[...jobs];jobs.clear();for(const [,fn]of pending)fn();for(let i=0;i<12;i++)await Promise.resolve()},jobs}
}
test('a bounded short walk returns to zero and leaves no scheduled moves',async()=>{
  const f=await fixture();await f.control.play(1)
  for(let i=0;i<49;i++)await f.tick(50)
  expect(f.moves.length).toBeGreaterThan(20)
  expect(f.moves.every(p=>p.token===7&&p.offset>=0&&p.offset<=48)).toBe(true)
  expect(f.moves.at(-1).offset).toBe(0);expect(f.jobs.size).toBe(0)
})
test('stopping a late context response never allows a stale step',async()=>{
  let resolve!:(v:any)=>void
  const f=await fixture(()=>new Promise(yes=>{resolve=yes}))
  const playing=f.control.play(1);for(let i=0;i<12;i++)await Promise.resolve()
  const stopped=f.control.stop();resolve({token:7,minOffset:-48,maxOffset:48})
  await playing;await stopped;await f.tick(5000)
  expect(f.moves).toEqual([]);expect(f.jobs.size).toBe(0)
})
test('native moves serialize and stopping waits for an in-flight move without queuing another',async()=>{
  let release!:(v?:any)=>void
  const f=await fixture(undefined,()=>new Promise(yes=>{release=yes}))
  await f.control.play(-1);await f.tick(50);await f.tick(500)
  expect(f.moves).toHaveLength(1)
  const stopped=f.control.stop();release();await stopped;await f.tick(5000)
  expect(f.moves).toHaveLength(1);expect(f.jobs.size).toBe(0)
})
