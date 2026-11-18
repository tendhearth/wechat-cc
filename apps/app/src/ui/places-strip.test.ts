// @vitest-environment happy-dom
import { act, createElement, useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { color } from '@wechat-cc/design-tokens'
import type { PlaceT } from '@wechat-cc/protocol'
import { makeDemoBackend } from '../backend/demo'
import { IDS } from '../backend/demo-data'
import { withProviders } from '../state/providers.test-support'
import { usePlaces } from '../state/places'
import { cleanup, mount } from './native-motion.test-support'
import { PlacesStrip } from './PlacesStrip'
vi.mock('react-native',async()=>({...(await import('./native-motion.test-support')).nativeBoundary()}))
vi.mock('expo-localization',()=>({getLocales:()=>[{languageTag:'zh-Hans'}]}))
const flush=()=>act(async()=>{await new Promise(r=>setTimeout(r,0))})
afterEach(async()=>{await cleanup();vi.clearAllMocks()})

function Harness({onOpen,onSelect}:{onOpen:(h:string)=>void;onSelect:(p:PlaceT|null)=>void}){
 const places=usePlaces(),[sel,setSel]=useState<string|null>(null)
 return createElement(PlacesStrip,{places:places.places,stale:places.stale,selected:sel,onSelect:(p:PlaceT|null)=>{setSel(p?.key??null);onSelect(p)},onOpen})
}

it('一个地方一行;在等你的有点;点一行选中再点取消;「›」打开该看的那一件',async()=>{
 const demo=makeDemoBackend(),onOpen=vi.fn(),onSelect=vi.fn()
 const ui=await mount(withProviders(createElement(Harness,{onOpen,onSelect}),{backend:demo}));await flush()
 expect(ui.byId('places-strip')).not.toBeNull()
 expect(ui.container.textContent).toContain('portfolio')
 expect(ui.container.textContent).toContain('trip')
 const styles=()=>[...ui.container.querySelectorAll('[data-style]')].map(e=>JSON.parse(e.getAttribute('data-style')!))
 expect(styles().filter(s=>s.width===8&&s.backgroundColor===color.accent)).toHaveLength(1)
 await act(()=>ui.byId('place-row-1').click())
 expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({name:'trip'}))
 await act(()=>ui.byId('place-row-1').click())
 expect(onSelect).toHaveBeenLastCalledWith(null)
 await act(()=>ui.byId('place-open-0').click())
 expect(onOpen).toHaveBeenCalledWith(`/matter/${IDS.portfolio}`)
 await act(()=>ui.byId('place-open-1').click())
 expect(onOpen).toHaveBeenLastCalledWith(`/matter/${IDS.trip}`)
})

it('连不上:保留上一次的行,不亮「在等你」,说一句',async()=>{
 const demo=makeDemoBackend();let conn=demo.connection();const listeners=new Set<(c:typeof conn)=>void>()
 const backend={...demo,connection:()=>conn,onConnection:(cb:(c:typeof conn)=>void)=>{listeners.add(cb);return()=>{listeners.delete(cb)}}}
 const ui=await mount(withProviders(createElement(Harness,{onOpen:vi.fn(),onSelect:vi.fn()}),{backend}));await flush()
 conn={...conn,state:'offline'};await act(()=>{for(const cb of listeners)cb(conn)});await flush()
 expect(ui.container.textContent).toContain('portfolio')
 expect(ui.container.textContent).toContain('暂时连不上')
 const styles=[...ui.container.querySelectorAll('[data-style]')].map(e=>JSON.parse(e.getAttribute('data-style')!))
 expect(styles.some(s=>s.width===8&&s.backgroundColor===color.accent)).toBe(false)
})
