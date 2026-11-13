import {it,expect} from 'vitest'
import {ContextRotation,type ContextRotationDeps} from './context-rotation'

const key={chatId:'owner',alias:'p',providerId:'openai'}
function rig(extra:Partial<ContextRotationDeps>={}){
 let now=0,rotations=0
 const logs:string[]=[]
 const c=new ContextRotation({owner:()=> 'owner',load:()=>({sessions:{},chats:{}}),save:()=>{},now:()=>now,budgetFor:()=>({windowTokens:32000,reliableFillRatio:.6}),pending:()=>false,recent:async()=>[{dir:'in',text:'盒子在书房',ts:'2026-11-13T00:00:00Z'}],ongoing:async()=>[],latestTs:async()=> '2026-11-13T00:00:00Z',accounted:async()=>true,extract:async()=>true,defer:()=>{},log:(t,l)=>logs.push(t+':'+l),...extra})
 const sessions={isInFlight:()=>false,rotate:async()=>{rotations++;return true}}
 return {c,logs,sessions,before:()=>c.beforeTurn(key,'m',sessions),advance:()=>{now+=86400000},get rotations(){return rotations}}
}
it('32k window hard caps a 12k fixed baseline and reports a small window',async()=>{
 const r=rig();await r.before();r.c.observe(key,{tokens:12000,firstInputTokens:12000})
 expect(r.c.status()[0]).toMatchObject({budgetTokens:27200,windowTooSmall:true})
 expect(r.c.budgetTokens(key)).toBeLessThan(32000)
})
it('a resumed legacy session has unknown fixed overhead and uses only window ratio',async()=>{
 const r=rig();await r.before();r.c.opened(key,'m',0,true)
 r.c.observe(key,{tokens:28000,firstInputTokens:28000,turns:8})
 expect(r.c.status()[0]).toMatchObject({fixedOverheadTokens:null,budgetTokens:19200,source:'provider'})
 await r.before();expect(r.rotations).toBe(1)
})
it('budget failures are logged and remain visible without blocking conversation',async()=>{
 const r=rig({budgetFor:()=>{throw Error('unreadable window')}});await r.before()
 expect(r.logs.some(l=>l.includes('budget_unavailable'))).toBe(true)
 expect(r.c.status()[0]).toMatchObject({budgetError:'budget_unavailable'})
})
it('nightly evaluation below half is consumed even if occupancy increases later',async()=>{
 const r=rig({budgetFor:()=>({windowTokens:200000,reliableFillRatio:.6})});await r.before()
 r.c.observe(key,{tokens:10000,turns:8});r.c.nightly('owner',true);await r.c.rotateIdle('owner',r.sessions)
 r.c.observe(key,{tokens:80000,turns:1});await r.before();expect(r.rotations).toBe(0)
})
it('nightly does not replace a young segment and cannot survive into a daytime boundary',async()=>{
 const r=rig({budgetFor:()=>({windowTokens:200000,reliableFillRatio:.6})});await r.before()
 r.c.observe(key,{tokens:10000});r.c.observe(key,{tokens:80000,turns:1});r.c.nightly('owner',true)
 await r.c.rotateIdle('owner',r.sessions);expect(r.rotations).toBe(0)
 r.c.observe(key,{tokens:80000,turns:8});await r.before();expect(r.rotations).toBe(0)
})
it('overflow rotates immediately despite young history and accounting lag',async()=>{
 const r=rig({accounted:async()=>false});await r.before();r.c.observe(key,{tokens:31000,turns:1})
 const carry=await r.c.recoverOverflow(key,r.sessions)
 expect(r.rotations).toBe(1);expect(carry?.block).toContain('盒子在书房')
 expect(r.c.status()[0]).toMatchObject({reason:'overflow',turns:0})
})
it('retired aliases and providers disappear without 24h accounting alerts or forgetting active parallel sessions',async()=>{
 let active=true,alerts=0
 const r=rig({active:()=>active,accounted:async()=>false,alert:()=>{alerts++}});await r.before()
 r.c.observe(key,{tokens:1000});r.c.observe(key,{tokens:31000,turns:8});await r.before()
 active=false;r.advance();expect(r.c.status()).toEqual([]);expect(alerts).toBe(0)
 r.c.nightly('owner',true);await r.c.rotateIdle('owner',r.sessions);expect(r.rotations).toBe(0)
})

it('a failed native resume starts a new measurable baseline after a legacy unknown baseline',async()=>{
 const r=rig();await r.before();r.c.opened(key,'m',0,true);r.c.observe(key,{tokens:28000,firstInputTokens:28000})
 r.c.opened(key,'m',0,false);r.c.observe(key,{tokens:12000,firstInputTokens:12000})
 expect(r.c.status()[0]).toMatchObject({fixedOverheadTokens:12000,budgetTokens:27200})
})
it('uncounted overflow still recovers without inventing a permanent tiny window from local prompt bytes',async()=>{
 const bounds:number[]=[],r=rig({recordOverflow:(_k,_m,n)=>bounds.push(n)});await r.before()
 r.c.opened(key,'m',0,true);r.c.observe(key,{bytes:20,unknown:true,turns:1})
 await r.c.recoverOverflow(key,r.sessions);expect(r.rotations).toBe(1);expect(bounds).toEqual([])
})
it('overflow window persistence failures stay visible after subsequent budget reads',async()=>{
 const r=rig({recordOverflow:()=>{throw Error('offline write')}});await r.before()
 await r.c.recoverOverflow(key,r.sessions,undefined,33000)
 expect(r.c.status()[0]).toMatchObject({budgetError:'window_write_failed'})
 expect(r.logs).toContain('CONTEXT_BUDGET:window_write_failed')
})
