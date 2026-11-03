import {describe,expect,it} from 'vitest'
import {createLifeDirector} from './life-director.js'

function clock(){
  let time=0,id=0
  const timers=new Map<number,{at:number,fn:()=>void}>()
  return {now:()=>time,schedule(fn:()=>void,ms:number){const key=++id;timers.set(key,{at:time+ms,fn});return key},cancel(key:unknown){timers.delete(Number(key))},
    tick(ms:number){const end=time+ms;for(;;){const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>end)break;timers.delete(next[0]);time=next[1].at;next[1].fn()}time=end}}
}
const idle=()=>({form:'lit',behavior:'idle',transition:null,targetForm:null,resting:'idle',props:[],badge:0})
function boot(art=true){
  const c=clock(),events:any[]=[]
  const director:any=createLifeDirector({schedule:c.schedule,cancel:c.cancel,now:c.now,random:()=>0,onAction:(pose:any)=>events.push({...pose,at:c.now()})} as any)
  expect(typeof director.setCuriosityAvailable,'optional curiosity art has an availability gate').toBe('function')
  expect(typeof director.finishCuriosity,'actual presentation can finish a scene').toBe('function')
  const facts=idle();director.observe(facts);director.setCuriosityAvailable(art);director.setAvailable(true)
  return {c,director,events,facts,action:()=>director.current().action}
}
function start(){
  const s=boot();s.c.tick(84_000)
  expect(s.action()).toBe('curiosity')
  expect(Number.isSafeInteger(s.director.current().token)).toBe(true)
  return {...s,token:s.director.current().token}
}

describe('CC optional private curiosity',()=>{
  it('waits for fresh calm time and never changes factual activity',()=>{
    const {c,director,events,facts,action}=boot()
    c.tick(74_999);expect(events.some(p=>p.action==='curiosity')).toBe(false)
    c.tick(9_001);expect(action()).toBe('curiosity')
    expect(facts).toEqual(idle())
    director.observe(idle());expect(action()).toBe('curiosity')
    expect(events.filter(p=>p.action==='curiosity')).toHaveLength(1)
  })
  it('finishes on its actual presentation callback and refuses stale generations',()=>{
    const {c,director,action,token}=start()
    c.tick(3_500);expect(action()).toBe('curiosity')
    expect(director.finishCuriosity(token-1)).toBe(false)
    expect(action()).toBe('curiosity')
    expect(director.finishCuriosity(token)).toBe(true)
    expect(action()).toBe('still')
    expect(director.finishCuriosity(token)).toBe(false)
  })
  it('keeps the original calm doze deadline after a complete scene',()=>{
    const {c,director,action,token}=start()
    c.tick(3_000);director.finishCuriosity(token)
    c.tick(180_000-c.now());expect(action()).toBe('doze')
  })
  it('does not start a story without optional artwork',()=>{
    const {c,events,action}=boot(false)
    c.tick(180_000)
    expect(events.some(p=>p.action==='curiosity')).toBe(false)
    expect(action()).toBe('doze')
  })
  it('consumes the episode and thirty-minute opportunity even when interrupted',()=>{
    const {c,director,events,token}=start(),first=events.find(p=>p.action==='curiosity').at
    director.setAvailable(false)
    expect(director.finishCuriosity(token)).toBe(false)
    c.tick(first+1_800_000-120_000-c.now())
    director.setAvailable(true);c.tick(84_000)
    expect(events.filter(p=>p.action==='curiosity')).toHaveLength(1)
    c.tick(42_000)
    expect(events.filter(p=>p.action==='curiosity')).toHaveLength(2)
  })
  it('requires another fresh calm episode after returning from a long absence',()=>{
    const {c,director,events}=start()
    director.setAvailable(false);c.tick(1_900_000)
    director.setAvailable(true);c.tick(74_999)
    expect(events.filter(p=>p.action==='curiosity')).toHaveLength(1)
    c.tick(9_001);expect(events.filter(p=>p.action==='curiosity')).toHaveLength(2)
  })
  it('settles safely when the last optional frame disappears without extending doze',()=>{
    const {c,director,events,action,token}=start()
    director.setCuriosityAvailable(false)
    expect(action()).toBe('still');expect(director.finishCuriosity(token)).toBe(false)
    c.tick(180_000-c.now());expect(action()).toBe('doze')
    expect(events.filter(p=>p.action==='curiosity')).toHaveLength(1)
  })

  for(const [behavior,expected] of [['working','work-enter'],['thinking','ponder'],['permission','still'],['error','still'],['receive','still'],['drag','lift'],['sleep','still']] as const)
    for(const phase of [0,1_300,2_600])it(`yields to ${behavior} at scene +${phase}ms without a late callback`,()=>{
      const {c,director,action,token}=start();c.tick(phase)
      director.observe({...idle(),behavior,resting:behavior==='working'?'working':'idle'})
      expect(action()).toBe(expected)
      expect(director.finishCuriosity(token)).toBe(false)
      expect(action()).toBe(expected)
    })
  for(const condition of ['nearby-controls','quiet-or-reduced','dark','transition','destroy'] as const)
    for(const phase of [0,1_300,2_600])it(`cancels for ${condition} at scene +${phase}ms and consumes its callback`,()=>{
      const {c,director,action,token}=start();c.tick(phase)
      if(condition==='nearby-controls')director.setAvailable(false)
      if(condition==='quiet-or-reduced')director.setSuppressed(true)
      if(condition==='dark')director.observe({...idle(),form:'unlit'})
      if(condition==='transition')director.observe({...idle(),transition:'lit-to-unlit',targetForm:'unlit'})
      if(condition==='destroy')director.destroy()
      expect(action()).toBe('still')
      expect(director.finishCuriosity(token)).toBe(false)
      c.tick(1_000);expect(action()).toBe('still')
    })
})
