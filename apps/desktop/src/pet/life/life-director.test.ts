import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createPet } from '../pet.js'

function node() {
  const attrs: Record<string,string> = {}, values: Record<string,string> = {}, classes = new Set<string>(), children: any[] = []
  return { attrs, children, src: '', hidden: false, textContent: '',
    style: { setProperty(k:string,v:string) { values[k]=v }, values },
    classList: { add(c:string) { classes.add(c) }, remove(c:string) { classes.delete(c) }, contains(c:string) { return classes.has(c) } },
    setAttribute(k:string,v:string) { attrs[k]=v }, getAttribute(k:string) { return attrs[k]??null },
    appendChild(n:any) { children.push(n) }, insertBefore(n:any) { children.unshift(n) },
    replaceChildren(...n:any[]) { children.splice(0,children.length,...n) }, removeChild(n:any) { children.splice(children.indexOf(n),1) },
  }
}
function clock() {
  let time=0, id=0
  const pending=new Map<number,{at:number,fn:()=>void}>()
  return { now:()=>time, schedule(fn:()=>void,ms:number) { const key=++id;pending.set(key,{at:time+ms,fn});return key },
    cancel(key:unknown) { pending.delete(Number(key)) }, count:()=>pending.size,
    tick(ms:number) { const end=time+ms;for(;;) { const next=[...pending].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>end)break;pending.delete(next[0]);time=next[1].at;next[1].fn() }time=end },
  }
}
async function boot() {
  const c=clock(),root={stage:node(),img:node(),props:node(),body:node()}
  const manifest=readFileSync(new URL('../../assets/pet/cc-v1/manifest.json',import.meta.url),'utf8')
  const pet:any=await createPet(root,{manifestUrl:'./assets/pet/cc-v1/manifest.json',fetchImpl:async()=>new Response(manifest),makeEl:node,schedule:c.schedule,cancel:c.cancel,now:c.now,random:()=>0,preload:()=>{},life:true} as any)
  expect(typeof pet.setLifeAvailable).toBe('function')
  pet.setForm('lit');pet.machine.notifyAnimationEnded();pet.setLifeAvailable(true)
  return {c,root,pet,action:()=>root.stage.attrs['data-pet-action']}
}

describe('CC local life over real pet runtime',()=>{
  it('has spaced, non-repeating idle ideas without changing factual state',async()=>{
    const {c,pet,action}=await boot()
    c.tick(19_999);expect(action()).toBe('still')
    c.tick(1);expect(action()).toBe('peek')
    c.tick(1200);expect(action()).toBe('still')
    c.tick(20_000);expect(action()).toBe('stretch')
    expect(pet.machine.snapshot()).toMatchObject({form:'lit',resting:'idle'})
    pet.destroy();expect(c.count()).toBe(0)
  })
  it('dozes after calm time and wakes for local attention without inventing offline sleep',async()=>{
    const {c,pet,action}=await boot()
    c.tick(180_000);expect(action()).toBe('doze')
    expect(pet.machine.snapshot()).toMatchObject({form:'lit',resting:'idle'})
    pet.setLifeAvailable(false);expect(action()).toBe('wake')
    c.tick(800);expect(action()).toBe('still')
    c.tick(180_000);expect(action()).toBe('still')
    pet.destroy()
  })
  it('prepares work, puts the computer away, and celebrates only a real done event',async()=>{
    const {c,root,pet,action}=await boot()
    pet.setState('working');expect(action()).toBe('work-enter')
    c.tick(350);expect(action()).toBe('work')
    expect(root.props.children.some((n:any)=>n.attrs['data-prop']==='laptop')).toBe(true)
    pet.setState('idle');expect(action()).toBe('work-exit')
    expect(pet.machine.snapshot().resting).toBe('idle')
    c.tick(300);expect(action()).toBe('still')
    pet.setState('working');c.tick(350);pet.setState('done')
    expect(action()).toBe('work-exit');c.tick(300);expect(action()).toBe('celebrate')
    pet.setState('permission');expect(action()).toBe('still')
    c.tick(1500);expect(action()).toBe('still')
    expect(pet.machine.snapshot().behavior).toBe('permission')
    pet.destroy()
  })
  it.each(['quiet','reduced','hidden'] as const)('%s cancels life immediately and never replays an old celebration',async flag=>{
    const {c,pet,action}=await boot()
    pet.setState('working');c.tick(350);pet.setState('done');c.tick(300)
    expect(action()).toBe('celebrate')
    const set=flag==='quiet'?pet.setQuiet:flag==='reduced'?pet.setReducedMotion:pet.setPaused
    set(true);expect(action()).toBe('still')
    c.tick(60_000);expect(action()).toBe('still')
    set(false);expect(action()).not.toBe('celebrate')
    pet.destroy();expect(c.count()).toBe(0)
  })
  it('new factual work interrupts a doze immediately; dark never has idle life',async()=>{
    const {c,pet,action}=await boot()
    c.tick(180_000);expect(action()).toBe('doze')
    pet.setState('working');expect(action()).toBe('work-enter')
    pet.applyIntent({form:'unlit',behavior:'sleep',props:[],badge:0,hint:'offline',oneShots:[]})
    expect(action()).toBe('still');c.tick(180_000);expect(action()).toBe('still')
    pet.destroy()
  })
})
