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
function clock(minimumDelay=0) {
  let time=0, id=0
  const pending=new Map<number,{at:number,fn:()=>void}>()
  return { now:()=>time, schedule(fn:()=>void,ms:number) { const key=++id;pending.set(key,{at:time+Math.max(minimumDelay,ms),fn});return key },
    cancel(key:unknown) { pending.delete(Number(key)) }, count:()=>pending.size,
    tick(ms:number) { const end=time+ms;for(;;) { const next=[...pending].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>end)break;pending.delete(next[0]);time=next[1].at;next[1].fn() }time=end },
  }
}
async function boot(authored=false,minimumDelay=0,life=true) {
  const c=clock(minimumDelay),root={stage:node(),img:node(),props:node(),body:node()}
  const raw=JSON.parse(readFileSync(new URL('../../assets/pet/cc-v1/manifest.json',import.meta.url),'utf8'))
  if(authored) for(const form of ['lit','unlit']) for(const action of ['peek','stretch','walk','lift','land','celebrate','work']) {
    raw.forms[form].states[`life-${action}`]={frames:Array.from({length:12},(_,i)=>`performance/${form}/${action}/${i}.png`),fps:16,loop:['walk','lift','work'].includes(action),next:'idle',artStatus:'production-candidate'}
  }
  const manifest=JSON.stringify(raw)
  const pet:any=await createPet(root,{manifestUrl:'./assets/pet/cc-v1/manifest.json',fetchImpl:async()=>new Response(manifest),makeEl:node,schedule:c.schedule,cancel:c.cancel,now:c.now,random:()=>0,preload:()=>{},life} as any)
  expect(typeof pet.setLifeAvailable).toBe('function')
  pet.setForm('lit');pet.machine.notifyAnimationEnded();pet.setLifeAvailable(true)
  return {c,root,pet,action:()=>root.stage.attrs['data-pet-action']}
}

describe('CC local life over real pet runtime',()=>{
  it('keeps non-companion embeds on their original behavior art when life is not enabled',async()=>{
    const {root,pet}=await boot(true,0,false)
    pet.setState('done')
    expect(root.img.src).toContain('/motion/lit/done/')
    pet.destroy()
  })
  it('finishes the authored completion when frame timers are throttled without restarting old done art',async()=>{
    const {c,root,pet}=await boot(true,1000)
    pet.setState('working');c.tick(1000)
    pet.applyIntent({form:'lit',behavior:'idle',props:[],badge:0,hint:null,oneShots:['done']})
    c.tick(1000)
    expect(root.img.src).toContain('performance/lit/celebrate/')
    c.tick(1000)
    expect(root.img.src).toContain('performance/lit/celebrate/')
    expect(pet.machine.snapshot().behavior).toBe('done')
    c.tick(11_000)
    expect(pet.machine.snapshot().behavior).toBe('idle')
    expect(root.img.src).not.toContain('/done/')
    pet.destroy()
  })
  it('plays authored lift and landing without changing drag facts or duplicating CSS body motion',async()=>{
    const {c,root,pet}=await boot(true)
    pet.beginDrag()
    expect(root.img.src).toContain('performance/lit/lift/')
    expect(root.body.attrs['data-pet-performance']).toBe('true')
    expect(pet.machine.snapshot().behavior).toBe('drag')
    pet.endDrag();pet.land()
    expect(root.img.src).toContain('performance/lit/land/')
    c.tick(550)
    expect(root.body.attrs['data-pet-performance']).toBe('false')
    pet.destroy()
  })
  it('uses one authored completion after put-away, without replaying the old done clip',async()=>{
    const {c,root,pet,action}=await boot(true)
    pet.setState('working');c.tick(350)
    expect(root.img.src).toContain('performance/lit/work/')
    pet.applyIntent({form:'lit',behavior:'idle',props:[],badge:0,hint:null,oneShots:['done']})
    expect(action()).toBe('work-exit')
    expect(root.img.src).not.toContain('/done/')
    c.tick(300)
    expect(root.img.src).toContain('performance/lit/celebrate/')
    c.tick(749);expect(pet.machine.snapshot().behavior).toBe('done')
    c.tick(7) // Existing renderer rounds each 16fps step to 63ms: 12×63ms.
    expect(pet.machine.snapshot().behavior).toBe('idle')
    expect(root.img.src).not.toContain('/done/')
    c.tick(1000);expect(root.img.src).not.toContain('/done/')
    pet.destroy()
  })
  it('falls back after every optional carried frame fails, retaining the factual drag',async()=>{
    const {root,pet}=await boot(true)
    pet.beginDrag()
    for(let i=0;i<12;i++) pet.reportFrameError(`https://local.test/assets/pet/cc-v1/performance/lit/lift/${i}.png`)
    expect(root.img.src).not.toContain('performance/lit/lift/')
    expect(root.body.attrs['data-pet-performance']).toBe('false')
    expect(pet.machine.snapshot().behavior).toBe('drag')
    pet.destroy()
  })
  it.each(['permission','error','thinking'] as const)('a factual %s interrupts an authored completion permanently',async state=>{
    const {c,root,pet}=await boot(true)
    pet.setState('done');expect(root.img.src).toContain('performance/lit/celebrate/')
    pet.applyIntent({form:'lit',behavior:state,props:[],badge:0,hint:null,oneShots:[]})
    expect(root.img.src).not.toContain('performance/lit/celebrate/')
    c.tick(2000)
    expect(pet.machine.snapshot().behavior).toBe(state==='error'?'idle':state)
    expect(root.img.src).not.toContain('performance/lit/celebrate/')
    pet.destroy()
  })
  it.each([{oneShots:['done']},{oneShots:['receive','done']}])('real intent $oneShots puts work away before celebrating',async({oneShots})=>{
    const {c,root,pet,action}=await boot()
    pet.applyIntent({form:'lit',behavior:'working',props:[],badge:0,hint:null,oneShots:[]});c.tick(350)
    pet.applyIntent({form:'lit',behavior:'idle',props:[],badge:0,hint:null,oneShots})
    expect(action()).toBe('work-exit')
    expect(root.props.children.some((n:any)=>n.attrs['data-prop']==='laptop'&&n.attrs['data-prop-leaving']==='false')).toBe(true)
    c.tick(299);expect(action()).toBe('work-exit')
    c.tick(1);expect(action()).toBe('celebrate')
    pet.setState('permission');expect(action()).toBe('still');c.tick(1000);expect(action()).toBe('still')
    pet.destroy()
  })
  it('new actual work consumes an old completion, including one held while lifted',async()=>{
    const {c,pet,action}=await boot()
    const work={form:'lit',behavior:'working',props:[],badge:0,hint:null,oneShots:[]}
    pet.setState('working');c.tick(350);pet.setState('done');c.tick(300)
    expect(action()).toBe('celebrate')
    pet.applyIntent(work)
    expect(pet.machine.snapshot().behavior).toBe('working')
    expect(action()).toBe('work-enter');c.tick(3000);expect(action()).toBe('work')
    pet.beginDrag();pet.applyIntent({...work,behavior:'idle',oneShots:['done']})
    pet.applyIntent(work);pet.endDrag();c.tick(3000)
    expect(pet.machine.snapshot().behavior).toBe('working');expect(action()).toBe('work')
    pet.destroy()
  })
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
  it.each((['quiet','reduced','hidden'] as const).flatMap(flag=>[false,true].map(authored=>({flag,authored}))))('$flag cancels life immediately and never replays an old celebration (authored:$authored)',async({flag,authored})=>{
    const {c,root,pet,action}=await boot(authored)
    pet.setState('working');c.tick(350);pet.setState('done');c.tick(300)
    expect(action()).toBe('celebrate')
    const set=flag==='quiet'?pet.setQuiet:flag==='reduced'?pet.setReducedMotion:pet.setPaused
    set(true);expect(action()).toBe('still')
    expect(root.body.attrs['data-pet-performance']).toBe('false')
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
