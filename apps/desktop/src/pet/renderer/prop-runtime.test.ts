import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { composeProps, createPropRenderer, PROP_FADE_MS } from './prop-layer.js'
import { createPet } from '../pet.js'
import { presenceToPet } from '../bridge/presence-map.js'
import { initialBridgeState, mergeIntent } from '../bridge/runtime-events.js'
import type { PetManifest } from '../assets/manifest-loader.js'

function node(tag='div') {
  const children:any[]=[],classes=new Set<string>(),attrs:Record<string,string>={},values:Record<string,string>={}
  return {tag,children,attrs,src:'',textContent:'',hidden:false,parent:null as any,style:Object.assign(values,{setProperty(k:string,v:string){values[k]=v}}),
    classList:{add:(c:string)=>classes.add(c),remove:(c:string)=>classes.delete(c),contains:(c:string)=>classes.has(c)},
    setAttribute(k:string,v:string){attrs[k]=v},getAttribute(k:string){return attrs[k]??null},getBoundingClientRect(){return {width:100,height:100}},
    appendChild(c:any){c.parent?.removeChild(c);children.push(c);c.parent=this},removeChild(c:any){const i=children.indexOf(c);if(i>=0)children.splice(i,1);c.parent=null},
    replaceChildren(...next:any[]){for(const c of [...children])this.removeChild(c);for(const c of next)this.appendChild(c)},
    insertBefore(c:any,ref:any){c.parent?.removeChild(c);const i=children.indexOf(ref);children.splice(i<0?children.length:i,0,c);c.parent=this}}
}
function clock(){let now=0,id=0;const q=new Map<number,{at:number,fn:()=>void}>();return {
  schedule(fn:()=>void,ms:number){q.set(++id,{at:now+ms,fn});return id},cancel(key:unknown){q.delete(key as number)},pending:()=>q.size,
  tick(ms:number){const until=now+ms;while(true){const next=[...q].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>until)break;q.delete(next[0]);now=next[1].at;next[1].fn()}now=until}}}
const manifest={props:Object.fromEntries(['laptop','envelope','thought-bubble','mug','exclamation','micro-light'].map(n=>[n,`props/${n}.png`]))} as PetManifest
const active=(root:ReturnType<typeof node>)=>root.children.filter(n=>n.attrs['data-prop-leaving']!=='true').map(n=>n.attrs['data-prop'])

describe('actual behavior compositions',()=>{
  it('projects five recipes without inventing badge values or changing input facts',()=>{
    for(const [behavior,expected] of [['working',['laptop']],['thinking',['thought-bubble','mug']],['permission',['exclamation']],['receive',['envelope']],['look',['micro-light']]] as const)
      expect(composeProps(behavior,[],{decorative:true})).toEqual(expected)
    const facts=['envelope','exclamation'];expect(composeProps('thinking',facts,{decorative:true})).toEqual(facts);expect(facts).toEqual(['envelope','exclamation'])
    expect(composeProps('working',['laptop','laptop'],{decorative:true})).toEqual(['laptop'])
    expect(composeProps('look',['micro-light','envelope'],{decorative:false})).toEqual(['envelope'])
  })
})
describe('keyed prop renderer',()=>{
  const setup=()=>{const root=node(),c=clock(),r=createPropRenderer({container:root,manifest,makeEl:node,schedule:c.schedule,cancel:c.cancel});return {root,c,r}}
  it('keeps envelope/image/badge identity when unread count changes, and removes zero immediately',()=>{
    const {root,c,r}=setup();r.render(['envelope'],3);const envelope=root.children[0],image=envelope.children[0],badge=envelope.children[1]
    r.render(['envelope'],4);expect(root.children[0]).toBe(envelope);expect(envelope.children[0]).toBe(image);expect(envelope.children[1]).toBe(badge);expect(badge.textContent).toBe('4')
    r.render(['envelope'],0);expect(envelope.children).toHaveLength(1);expect(c.pending()).toBe(0)
  })
  it('holds outgoing node for160ms and cancels stale removal on rapid reentry',()=>{
    const {root,c,r}=setup();expect(PROP_FADE_MS).toBe(160);r.render(['laptop'],0);const laptop=root.children[0]
    r.render([],0);expect(laptop.style.opacity).toBe('0');expect(root.children).toHaveLength(1);c.tick(80)
    r.render(['laptop'],0);expect(root.children).toEqual([laptop]);expect(laptop.style.opacity).toBe('1');c.tick(200);expect(root.children).toEqual([laptop])
    r.render([],0);c.tick(159);expect(root.children).toHaveLength(1);c.tick(1);expect(root.children).toHaveLength(0)
  })
  it('settles suppression immediately, ignores missing/duplicate props and destroys all tasks',()=>{
    const {root,c,r}=setup();r.render(['unknown','laptop','laptop','sprout'],0);expect(active(root)).toEqual(['laptop'])
    r.render(['envelope'],2);expect(c.pending()).toBe(1);r.setMotionSuppressed(true);expect(active(root)).toEqual(['envelope']);expect(root.children).toHaveLength(1);expect(c.pending()).toBe(0)
    expect(root.children[0].classList.contains('pet-prop-motion')).toBe(false)
    r.render([],0);expect(root.children).toHaveLength(0);expect(c.pending()).toBe(0)
    r.setMotionSuppressed(false);r.render(['laptop'],0);r.render([],0);r.destroy();expect(c.pending()).toBe(0);c.tick(1000);expect(root.children).toHaveLength(0);r.render(['envelope'],3);expect(root.children).toHaveLength(0)
  })
})
async function boot(){
  const raw=readFileSync(new URL('../../assets/pet/cc-v1/manifest.json',import.meta.url),'utf8'),c=clock(),root={stage:node(),img:node('img'),props:node(),hint:node()}
  const fetchImpl=(async()=>new Response(raw)) as unknown as typeof fetch
  const pet=await createPet(root,{manifestUrl:'https://cc.test/pet/cc-v1/manifest.json',fetchImpl,makeEl:node,schedule:c.schedule,cancel:c.cancel,preload:()=>{},random:()=>0})
  return {root,c,pet}
}
it('real presence→bridge→pet automatically renders one laptop after form transition',async()=>{
  const {root,c,pet}=await boot()
  const presence=presenceToPet({presence:'ok',activity:{kind:'working'},news:{unread:0}} as any,null)
  const merged=mergeIntent({presence,turn:{turn:{phase:'working',since:'s'},pending_permissions:[],last_done_at:null,owner_last_contact_at:null},state:initialBridgeState(),nowMs:0})
  pet.applyIntent(merged.intent);expect(active(root.props)).not.toContain('laptop');c.tick(1100);expect(active(root.props)).toEqual(['laptop']);pet.destroy();expect(c.pending()).toBe(0)
})
it('queued working waits behind receive; facts win slots and badge stays through role changes',async()=>{
  const {root,c,pet}=await boot();pet.setForm('lit');c.tick(1100);pet.setState('receive');pet.setState('working')
  expect(pet.machine.snapshot().behavior).toBe('receive');expect(active(root.props)).toEqual(['envelope']);c.tick(2000);expect(active(root.props)).toEqual(['laptop'])
  pet.applyIntent({form:'lit',behavior:'thinking',props:['envelope','exclamation'],badge:4,hint:null,oneShots:[]})
  expect(active(root.props)).toEqual(['envelope','exclamation']);expect(root.props.children.find(n=>n.attrs['data-prop']==='envelope').children[1].textContent).toBe('4')
  pet.setQuiet(true);pet.setPaused(true);expect(c.pending()).toBe(0);pet.destroy();expect(c.pending()).toBe(0)
})
it.each(['setPaused','setReducedMotion'] as const)('%s consumes old and newly arriving decorative light without losing unread facts',async control=>{
  const {root,c,pet}=await boot();pet.setForm('lit');c.tick(1100)
  pet.setProps(['micro-light','envelope'],2);expect(active(root.props)).toContain('micro-light')
  pet[control](true);expect(pet.machine.snapshot().props).toEqual(['envelope']);expect(active(root.props)).toEqual(['envelope'])
  pet.setProps(['micro-light','envelope'],3);expect(pet.machine.snapshot().props).toEqual(['envelope'])
  pet[control](false);c.tick(200);expect(active(root.props)).toEqual(['envelope'])
  expect(root.props.children.find(n=>n.attrs['data-prop']==='envelope').children[1].textContent).toBe('3');pet.destroy();expect(c.pending()).toBe(0)
})
