import {it,expect} from 'vitest'
import {ContextRotation,type ContextState} from './context-rotation'

function rig(providerId='openai'){
  const key={providerId,chatId:'owner',alias:'p'}
  let state:ContextState={sessions:{},chats:{}},rotated=0
  const deps={owner:()=> 'owner',load:()=>structuredClone(state),save:(s:ContextState)=>{state=structuredClone(s)},budgetFor:()=>({windowTokens:1000000,reliableFillRatio:.6}),pending:()=>true,recent:async()=>[{dir:'in' as const,text:'接续原文',ts:'2026-11-13T00:00:00Z'}],ongoing:async()=>[],latestTs:async()=>null,accounted:async()=>false,extract:async()=>false,defer:()=>{},log:()=>{}}
  let rotation=new ContextRotation(deps)
  const sessions={isInFlight:()=>false,rotate:async()=>{rotated++;return true}}
  return {key,get rotation(){return rotation},get rotated(){return rotated},before:()=>rotation.beforeTurn(key,'Kimi-Code',sessions),restart:()=>{rotation=new ContextRotation(deps)}}
}

for(const reset of ['success','different error','smaller body','non-4xx','new segment'])it(`repeated request fuse resets after ${reset}`,async()=>{
  const r=rig();await r.before()
  r.rotation.observe(r.key,{requestBytes:10000,requestFailure:{status:400,signature:'same'},turns:1})
  if(reset==='new segment')r.rotation.opened(r.key,'Kimi-Code',0,false)
  else r.rotation.observe(r.key,{requestBytes:reset==='smaller body'?9000:10000,requestFailure:reset==='success'?null:{status:reset==='non-4xx'?500:400,signature:reset==='different error'?'other':'same'},turns:1})
  if(['success','new segment','non-4xx'].includes(reset))r.rotation.observe(r.key,{requestBytes:11000,requestFailure:{status:400,signature:'same'},turns:1})
  expect(await r.before()).toBeNull();expect(r.rotated).toBe(0)
})
it('the same nonshrinking 4xx pair survives restart and rotates before the next request',async()=>{
  const r=rig();await r.before()
  r.rotation.observe(r.key,{requestBytes:10000,requestFailure:{status:400,signature:'same'},turns:1})
  r.rotation.observe(r.key,{requestBytes:10000,requestFailure:{status:400,signature:'same'},turns:1})
  r.restart()
  expect((await r.before())?.block).toContain('接续原文');expect(r.rotated).toBe(1)
  expect(await r.before()).toBeNull();expect(r.rotated).toBe(1)
})
it('native missing usage remains unknown even if request byte evidence is supplied',async()=>{
  const r=rig('claude');await r.before()
  r.rotation.observe(r.key,{requestBytes:9000000,unknown:true,requestFailure:{status:400,signature:'same'},turns:8})
  r.rotation.observe(r.key,{requestBytes:9000000,unknown:true,requestFailure:{status:400,signature:'same'},turns:8})
  expect(r.rotation.status()[0]?.source).toBe('unknown');expect(await r.before()).toBeNull();expect(r.rotated).toBe(0)
})
for(const status of [401,402,403,429])it(`known authentication/quota/rate errors (${status}) preserve the existing conversation`,async()=>{
  const r=rig();await r.before()
  r.rotation.observe(r.key,{requestBytes:10000,requestFailure:{status,signature:'same'},turns:1})
  r.rotation.observe(r.key,{requestBytes:11000,requestFailure:{status,signature:'same'},turns:1})
  expect(await r.before()).toBeNull();expect(r.rotated).toBe(0)
})
