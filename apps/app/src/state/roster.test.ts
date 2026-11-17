// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { RosterResponse } from '@wechat-cc/protocol'
import { makeDemoBackend } from '../backend/demo'
import { cleanup, mount } from '../ui/native-motion.test-support'
import { withProviders } from './providers.test-support'
import { useRoster } from './roster'
vi.mock('react-native', async () => (await import('../ui/native-motion.test-support')).nativeBoundary())
vi.mock('expo-localization', () => ({ getLocales: () => [] }))
afterEach(cleanup)
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
it('demo roster validates and contains waiting, working relay, and back', async () => {
  const result = RosterResponse.parse(await makeDemoBackend().roster!())
  expect(result.items.map(i => i.group)).toEqual(['waiting', 'working', 'working', 'back'])
  expect(result.items.some(i => i.relay && i.agents.length > 1)).toBe(true)
})
it('roster events reload; failure retains the previous items and marks stale', async () => {
  const demo = makeDemoBackend()
  let changed: (() => void) | undefined, fail = false
  const roster = vi.fn(async () => { if (fail) throw Error('offline'); return demo.roster!() })
  const backend = { ...demo, roster, subscribe: ((name: string, cb: () => void) => {
    if (name === 'roster') { changed = cb; return () => { changed = undefined } }
    return demo.subscribe(name as 'home', cb)
  }) as typeof demo.subscribe }
  let value!: ReturnType<typeof useRoster>
  function Probe() { value = useRoster(); return null }
  await mount(withProviders(createElement(Probe), { backend })); await flush()
  const previous = value.items
  expect(previous).toHaveLength(4); expect(value.stale).toBe(false)
  fail = true
  await act(() => changed?.()); await flush()
  expect(roster.mock.calls.length).toBeGreaterThan(1)
  expect(value.items).toBe(previous); expect(value.stale).toBe(true); expect(value.error).toBeDefined()
})

it('reconnect keeps old waiting stale until a new connection read finishes', async()=>{
 const demo=makeDemoBackend();let conn=demo.connection()
 const listeners=new Set<(c:typeof conn)=>void>()
 let hold=false,resolve!: (r:Awaited<ReturnType<NonNullable<typeof demo.roster>>>)=>void
 const backend={...demo,connection:()=>conn,onConnection:(cb:(c:typeof conn)=>void)=>{listeners.add(cb);return()=>{listeners.delete(cb)}},roster:async()=>hold?new Promise<Awaited<ReturnType<NonNullable<typeof demo.roster>>>>(r=>{resolve=r}):demo.roster!()}
 let value!:ReturnType<typeof useRoster>
 function Probe(){value=useRoster();return null}
 await mount(withProviders(createElement(Probe),{backend}));await flush()
 expect(value.stale).toBe(false)
 conn={...conn,state:'offline'};await act(()=>{listeners.forEach(cb=>cb(conn))})
 hold=true;conn={...conn,state:'online',epoch:conn.epoch+1};await act(()=>{listeners.forEach(cb=>cb(conn))});await flush()
 expect(value.items).toHaveLength(4);expect(value.stale).toBe(true)
 hold=false;await act(async()=>resolve(await demo.roster!()));await flush();await flush()
 expect(value.stale).toBe(false)
})
