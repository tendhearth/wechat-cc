import { expect, it } from 'vitest'
import { ContextRotation } from './context-rotation'
import type { HandoffTurn } from '../domain/provider-handoff'

const stamp=(n:number)=>new Date(Date.UTC(2026,10,13,0,0,n)).toISOString()
function rig(recent:HandoffTurn[]) {
  let watermark=stamp(0),rotations=0,reads=0
  const jobs:Array<()=>Promise<void>>=[]
  const key={providerId:'openai',alias:'p',chatId:'owner'}
  const c=new ContextRotation({owner:()=> 'owner',load:()=>({sessions:{},chats:{}}),save:()=>{},
    budgetFor:()=>({windowTokens:8192,reliableFillRatio:.8}),pending:()=>false,
    recent:async()=>{reads++;return recent},ongoing:async()=>[],latestTs:async()=>recent.at(-1)?.ts??null,
    accounted:async(_c,t)=>Date.parse(t)<=Date.parse(watermark),extract:async(_c,_m,t)=>{watermark=t!;return true},defer:j=>jobs.push(j),log:()=>{}})
  const sessions={isInFlight:()=>false,rotate:async()=>{rotations++;return true}}
  const before=()=>c.beforeTurn(key,'m',sessions)
  return {c,key,jobs,before,get rotations(){return rotations},get reads(){return reads},setWatermark:(s:string)=>{watermark=s}}
}
for(const dir of ['in','out'] as const) it(`accounts the omitted middle of the latest long ${dir} before rotating`,async()=>{
  const recent:HandoffTurn[]=[{dir:'in',text:'旧问题',ts:stamp(0)},{dir:'out',text:'旧答案',ts:stamp(0)},
    {dir:'in',text:'最新问题',ts:stamp(1)},{dir:'out',text:'最新回答',ts:stamp(2)}]
  recent[dir==='in'?2:3]!.text='头'.repeat(8000)+'未记账中段'+'尾'.repeat(8000)
  const r=rig(recent);await r.before();r.c.observe(r.key,{tokens:1000});r.c.observe(r.key,{tokens:20000,turns:8})
  expect(await r.before()).toBeNull();expect(r.rotations).toBe(0)
  r.c.delivered(r.key,'好了',false);await r.jobs.shift()!()
  const reads=r.reads,carried=await r.before()
  expect(r.rotations).toBe(1);expect(carried?.block).toContain('中间省略')
  expect(r.reads-reads).toBe(1) // gate and actual carry use the same snapshot
})
it('fails closed when a clipped row has no usable timestamp',async()=>{
  const r=rig([{dir:'out',text:'旧答',ts:stamp(0)},{dir:'in',text:'头'.repeat(16000),ts:''},{dir:'out',text:'答',ts:stamp(2)}])
  await r.before();r.c.observe(r.key,{tokens:1000});r.c.observe(r.key,{tokens:20000,turns:8})
  expect(await r.before()).toBeNull();expect(r.rotations).toBe(0)
  expect(r.c.status()[0]?.lastDeferredReason).toBe('boundary_unknown')
})
it('carries consecutive owner inputs and intervening proactive text without waiting for a fully carried latest round',async()=>{
  const r=rig([{dir:'in',text:'旧问',ts:stamp(0)},{dir:'out',text:'旧答',ts:stamp(0)},
    {dir:'in',text:'补充一',ts:stamp(1)},{dir:'out',text:'主动消息',ts:stamp(1),source:'speech:agenda'},
    {dir:'in',text:'补充二',ts:stamp(2)},{dir:'out',text:'前轮晚答',ts:stamp(3)}])
  r.setWatermark(stamp(1));await r.before();r.c.observe(r.key,{tokens:1000});r.c.observe(r.key,{tokens:20000,turns:8})
  const carry=await r.before();expect(r.rotations).toBe(1)
  for(const text of ['补充一','主动消息','补充二','前轮晚答'])expect(carry?.block).toContain(text)
})
