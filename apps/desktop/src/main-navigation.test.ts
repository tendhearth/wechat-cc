import { expect, it, vi } from 'vitest'
import { mainDestination } from './main-navigation.js'
import * as navigation from './main-navigation.js'
it('only accepts the explicit main-window destinations from untrusted events', () => {
  expect(mainDestination('overview')).toBe('overview')
  expect(mainDestination('a2a-agents')).toBe('a2a-agents')
  expect(mainDestination('converse')).toBe('converse')
  for (const value of [null, {}, '', 'settings', '../overview', 'https://example.com', '<script>']) expect(mainDestination(value)).toBeNull()
})

it('keeps fast pending conversation navigation until the dashboard is visible', async () => {
  const seen: unknown[] = []
  const nav = navigation.createMainNavigation(page => seen.push(page))
  await nav.restore(Promise.resolve('converse'))
  expect(seen).toEqual([])
  nav.setReady(true); nav.setReady(true)
  expect(seen).toEqual(['converse'])
})

it('applies a slow pending conversation immediately after dashboard readiness', async () => {
  const seen: unknown[] = []
  const nav = navigation.createMainNavigation(page => seen.push(page))
  let resolve!: (page: string) => void
  const pending = nav.restore(new Promise<string>(done => { resolve = done }))
  nav.setReady(true); resolve('converse'); await pending
  expect(seen).toEqual(['converse'])
})

it('a newer live destination wins over an older asynchronous pending result', async () => {
  const seen: unknown[] = []
  const nav = navigation.createMainNavigation(page => seen.push(page))
  let resolve!: (page: string) => void
  const pending = nav.restore(new Promise<string>(done => { resolve = done }))
  nav.request('a2a-agents'); resolve('converse'); await pending
  nav.setReady(true)
  expect(seen).toEqual(['a2a-agents'])
  expect(nav.request('https://example.com')).toBe(false)
  expect(nav.request('converse')).toBe(true)
  expect(seen).toEqual(['a2a-agents', 'converse'])
})

it.each([false, true])('live navigation accepted before the pending query wins, ready=%s', async ready => {
  const seen: unknown[] = []
  const nav = navigation.createMainNavigation(page => seen.push(page))
  nav.setReady(ready)
  nav.request('converse')
  await nav.restore(Promise.resolve('a2a-agents'))
  nav.setReady(true)
  expect(seen).toEqual(['converse'])
})

it('accepts only complete task destinations and legacy page objects, never combines partial targets', () => {
  expect(mainDestination({page:'workbench',taskId:'deadbeef'})).toEqual({page:'workbench',taskId:'deadbeef'})
  expect(mainDestination({page:'converse'})).toBe('converse')
  for(const value of [{page:'workbench'},{page:'workbench',taskId:'../deadbeef'},{page:'workbench',taskId:'DEADBEEF'},{page:'converse',taskId:'deadbeef'},{page:'workbench',taskId:'deadbeef',url:'https://example.com'},'workbench'])expect(mainDestination(value)).toBeNull()
})
it.each([false,true])('newer complete task wins over an older cold target, ready=%s',async ready=>{
 const seen:unknown[]=[];const nav=navigation.createMainNavigation((target:any)=>seen.push(target))
 let done!:(value:unknown)=>void;const pending=nav.restore(new Promise(resolve=>{done=resolve}))
 nav.setReady(ready)
 nav.request({page:'workbench',taskId:'bbbb2222'})
 done({page:'workbench',taskId:'aaaa1111'});await pending;nav.setReady(true)
 expect(seen).toEqual([{page:'workbench',taskId:'bbbb2222'}])
})
it('copies a valid target so later caller mutation cannot retarget a queued request',()=>{
 const seen:unknown[]=[];const nav=navigation.createMainNavigation((target:any)=>seen.push(target))
 const target={page:'workbench',taskId:'deadbeef'};nav.request(target);target.taskId='aaaa1111';nav.setReady(true)
 expect(seen).toEqual([{page:'workbench',taskId:'deadbeef'}])
})

it('does not acknowledge native readiness until listening succeeds, and retries once without duplicate listeners',async()=>{
 const seen:unknown[]=[];const nav=navigation.createMainNavigation(target=>seen.push(target));nav.setReady(true)
 let failures=1,listens=0,takes=0;let listener!:(ev:{payload:unknown})=>void
 const connect=navigation.createNativeNavigation({navigation:nav,listen:async(_name:string,cb:any)=>{listens++;if(failures-->0)throw Error('listen failed');listener=cb},takePending:async()=>{takes++;return {page:'workbench',taskId:'bbbb2222'}},onError:()=>{}})
 expect(await connect()).toBe(false);expect(takes).toBe(0)
 expect(await connect()).toBe(true);await vi.waitFor(()=>expect(seen).toEqual([{page:'workbench',taskId:'bbbb2222'}]));expect(takes).toBe(1)
 await Promise.all([connect(),connect()]);expect(listens).toBe(2);expect(takes).toBe(1)
 listener({payload:{page:'workbench',taskId:'deadbeef'}});expect(seen.at(-1)).toEqual({page:'workbench',taskId:'deadbeef'})
})
it('a slow native handshake never delays readiness or overrides a newer live task',async()=>{
 const seen:unknown[]=[];const nav=navigation.createMainNavigation(target=>seen.push(target));nav.setReady(true)
 let listener!:(ev:{payload:unknown})=>void,done!:(value:unknown)=>void
 const connect=navigation.createNativeNavigation({navigation:nav,listen:async(_name:string,cb:any)=>{listener=cb},takePending:()=>new Promise(resolve=>{done=resolve})})
 expect(await connect()).toBe(true);listener({payload:{page:'workbench',taskId:'bbbb2222'}})
 done({page:'workbench',taskId:'aaaa1111'});await Promise.resolve();await Promise.resolve()
 expect(seen).toEqual([{page:'workbench',taskId:'bbbb2222'}])
})

it('keeps old chat and all/together targets until the single conversation is ready',()=>{
  const seen:unknown[]=[]
  const nav=navigation.createMainNavigation(target=>seen.push(target))
  expect(nav.request('all')).toBe(true)
  expect(seen).toEqual([])
  nav.setReady(true)
  expect(seen).toEqual(['all'])
  expect(nav.request({page:'together'})).toBe(true)
  expect(nav.request('chat')).toBe(true)
  expect(seen).toEqual(['all','together','chat'])
  expect(nav.request({page:'all',taskId:'deadbeef'})).toBe(false)
})
