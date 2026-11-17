import { describe, it, expect } from 'vitest'
import { ContextRotation, type ContextRotationDeps } from './context-rotation'

function rig(extra:Partial<ContextRotationDeps>={}) {
 const jobs:(()=>Promise<void>)[]=[],key={providerId:'claude',alias:'p',chatId:'owner'}
 let rotations=0,accounted=true,time=Date.parse('2026-11-13T00:00:00Z')
 const c=new ContextRotation({owner:()=> 'owner',load:()=>({sessions:{},chats:{}}),save:()=>{},now:()=>time,
 budgetFor:()=>({windowTokens:200000,reliableFillRatio:.6}),pending:()=>false,recent:async()=>[],ongoing:async()=>[],latestTs:async()=> '2026-11-12T23:59:00Z',accounted:async()=>accounted,extract:async()=>true,defer:j=>jobs.push(j),log:()=>{},...extra})
 const manager={isInFlight:()=>false,rotate:async()=>{rotations++;return true}}
 const before=()=>c.beforeTurn(key,'actual',manager)
 return {c,key,jobs,before,manager,get rotations(){return rotations},setAccounted:(v:boolean)=>{accounted=v},advance:(ms:number)=>{time+=ms}}
}
describe('owner continuity: safe budget semantics',()=>{
 it('unknown occupancy and a huge bootstrap prompt never rotate',async()=>{
  const r=rig();await r.before();r.c.opened(r.key,'actual',400000,false)
  for(let i=0;i<40;i++)await r.before()
  expect(r.rotations).toBe(0);expect(r.c.status()[0]!.source).toBe('unknown')
 })
 it('40 untested Claude turns retain a 200k session despite fixed overhead and tool work',async()=>{
  const r=rig();await r.before()
  for(let i=0;i<40;i++){r.c.observe(r.key,{tokens:60000+i*500,turns:1});await r.before()}
  expect(r.rotations).toBe(0);expect(r.c.status()[0]!.budgetTokens).toBe(120000)
  expect(r.c.status()[0]).toMatchObject({fixedOverheadTokens:60000,historyTokens:19500})
 })
 it('ratio zero is clamped, history floor survives a small assumed window, and rotations are >=8 turns apart',async()=>{
  const r=rig({budgetFor:()=>({windowTokens:32000,reliableFillRatio:0})});await r.before()
  r.c.observe(r.key,{tokens:40000,turns:1});expect(r.c.status()[0]!.budgetTokens).toBe(27200)
  const at:number[]=[]
  for(let i=1;i<=40;i++){r.c.observe(r.key,{tokens:100000,turns:1});await r.before();if(r.rotations>at.length)at.push(i)}
  expect(at.length).toBeGreaterThan(0)
  for(let i=1;i<at.length;i++)expect(at[i]!-at[i-1]!).toBeGreaterThanOrEqual(8)
 })
 it('nightly keeps a session below half budget and only rotates with useful history',async()=>{
  const r=rig();await r.before();r.c.observe(r.key,{tokens:40000,turns:1});r.c.nightly('owner',true);await r.c.rotateIdle('owner',r.manager);expect(r.rotations).toBe(0)
  r.c.observe(r.key,{tokens:80000,turns:8});await r.before();expect(r.rotations).toBe(0);r.c.nightly('owner',true);await r.c.rotateIdle('owner',r.manager);expect(r.rotations).toBe(1)
 })
 it('reply boundary never waits for extraction; delivery schedules catchup and later rotation succeeds',async()=>{
  let finish!:()=>void,started=false
  const r=rig({extract:async()=>{started=true;await new Promise<void>(resolve=>{finish=resolve});r.setAccounted(true);return true}})
  await r.before();r.c.observe(r.key,{tokens:10000,turns:1});r.c.observe(r.key,{tokens:180000,turns:8});r.setAccounted(false)
  await r.before();expect(started).toBe(false);expect(r.rotations).toBe(0)
  r.c.delivered(r.key,'你好',false);expect(started).toBe(false)
  const job=r.jobs.shift()!();await Promise.resolve();await Promise.resolve();expect(started).toBe(true)
  expect(r.c.status()[0]).toMatchObject({deferredRotations:1,lastDeferredReason:'accounting_behind'})
  finish();await job;await r.before();expect(r.rotations).toBe(1)
 })
})
it('owner continuity: deferred accounting alerts once at 20 completed rounds, including across restart-free rechecks',async()=>{
 const alerts:string[]=[]
 const r=rig({alert:(_provider,reason)=>alerts.push(reason)});await r.before();r.c.observe(r.key,{tokens:1000});r.c.observe(r.key,{tokens:180000,turns:8});r.setAccounted(false)
 for(let i=0;i<19;i++){await r.before();await r.before();r.c.observe(r.key,{tokens:180000,turns:1})}
 expect(alerts).toEqual([]);expect(r.c.status()[0]!.deferredRotations).toBe(19)
 await r.before();expect(alerts).toEqual(['accounting_behind'])
 await r.before();expect(alerts).toHaveLength(1);expect(r.c.status()[0]!.warning).toBe('context_accounting_delayed')
})
it('owner continuity: 24h accounting warning is visible through health reads while replies remain available',async()=>{
 let alerts=0
 const r=rig({alert:()=>{alerts++}});await r.before();r.c.observe(r.key,{tokens:1000});r.c.observe(r.key,{tokens:180000,turns:8});r.setAccounted(false)
 await r.before();r.advance(86400000);expect(r.c.status()[0]!.warning).toBe('context_accounting_delayed')
 expect(alerts).toBe(1);r.c.status();expect(alerts).toBe(1)
})
it('owner continuity: native actual model stays selected after resumed startup uses the requested alias',async()=>{
 let saved:any={sessions:{},chats:{}}
 const r=rig({save:s=>{saved=structuredClone(s)},budgetFor:(_p,m)=>({windowTokens:m==='native'?200000:32000,reliableFillRatio:.6})})
 await r.c.beforeTurn(r.key,'default',{isInFlight:()=>false,rotate:async()=>true})
 r.c.observe(r.key,{tokens:60000,firstInputTokens:40000,model:'native',turns:9})
 await r.c.beforeTurn(r.key,'native',{isInFlight:()=>false,rotate:async()=>true})
 const restarted=rig({load:()=>saved,budgetFor:(_p,m)=>({windowTokens:m==='native'?200000:32000,reliableFillRatio:.6})})
 await restarted.c.beforeTurn(restarted.key,'default',{isInFlight:()=>false,rotate:async()=>true})
 restarted.c.opened(restarted.key,'default',400000,true)
 expect(restarted.c.status()[0]).toMatchObject({model:'native',windowTokens:200000,budgetTokens:120000})
 expect(restarted.rotations).toBe(0)
})
it('owner continuity: growing byte estimates remain unknown until a provider input baseline exists',async()=>{
 const r=rig();await r.before()
 for(let i=0;i<40;i++){r.c.observe(r.key,{bytes:400000+i*20000,turns:1});await r.before()}
 expect(r.rotations).toBe(0);expect(r.c.status()[0]!.source).toBe('unknown')
})

// 2026-11-13 真模型验收 B.4:每轮都有新消息落库时,旧实现的追赶只追到开轮前的边界,账永远落后一轮,换段被无限推迟。
describe('accounting gate does not chase its own tail',()=>{
 function live(extra:Partial<ContextRotationDeps>={}){
  const msgs:{dir:'in'|'out';text:string;ts:string}[]=[];let clock=Date.parse('2026-11-13T00:00:00Z'),watermark=0
  const say=(dir:'in'|'out',text:string)=>{clock+=1000;msgs.push({dir,text,ts:new Date(clock).toISOString()})}
  const r=rig({recent:async()=>msgs.slice(-12),latestTs:async()=>msgs.at(-1)?.ts??null,accounted:async(_c,ts)=>Date.parse(ts)<=watermark,
   extract:async(_c,_m,through)=>{watermark=Math.max(watermark,Date.parse(through??msgs.at(-1)!.ts));return true},...extra})
  const turn=async(tokens:number)=>{say('in','q');const block=await r.before();say('out','a');r.c.observe(r.key,{tokens,turns:1});r.c.delivered(r.key,'a',false);for(const job of r.jobs.splice(0))await job();return block}
  return {r,turn,msgs,get watermark(){return watermark}}
 }
 it('rotates once over budget even though every turn adds a new unaccounted reply',async()=>{
  const l=live();await l.turn(10000)
  for(let i=0;i<14;i++)await l.turn(180000)
  expect(l.r.rotations).toBeGreaterThanOrEqual(1)
 })
 it('still refuses while content older than the carried round is unaccounted and extraction is unavailable',async()=>{
  const l=live({extract:async()=>false});await l.turn(10000)
  for(let i=0;i<14;i++)await l.turn(180000)
  expect(l.r.rotations).toBe(0);expect(l.r.c.status()[0]!.lastDeferredReason).toBe('accounting_behind')
 })
 it('catch-up extracts through the turn just delivered, not the boundary frozen before it',async()=>{
  const seen:string[]=[]
  const l=live({extract:async(_c,mode,through)=>{if(mode==='catchup')seen.push(through!);return false}});await l.turn(10000)
  for(let i=0;i<10;i++)await l.turn(180000)
  expect(seen.length).toBeGreaterThan(0)
  expect(seen.at(-1)).toBe(l.msgs.at(-1)!.ts)
 })
})
