// @vitest-environment happy-dom
import { act, createElement, forwardRef } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { color } from '@wechat-cc/design-tokens'
import { makeDemoBackend } from '../backend/demo'
import { IDS } from '../backend/demo-data'
import { BackendError, type Backend } from '../backend/types'
import { withProviders } from '../state/providers.test-support'
import { cleanup, mount } from './native-motion.test-support'
import { useMatterSay } from '../state/matter-say'
import { directHeaderView } from '../view/direct-header'
import { DirectHeader } from './DirectHeader'
import { DirectComposer, MatterDirectComposer } from './DirectComposer'
import { RosterStrip } from './RosterStrip'
import { matterInputState } from '../state/matter-inputs'
const host=vi.hoisted(()=>({back:vi.fn(),replace:vi.fn(),push:vi.fn(),canGoBack:()=>false}))
vi.mock('react-native',async()=>{
 const native=(await import('./native-motion.test-support')).nativeBoundary()
 return {...native,TextInput:forwardRef<any,any>(({value,onChangeText,testID,placeholder}:any,ref)=>createElement('textarea',{ref,value,placeholder,'data-testid':testID,onInput:(e:any)=>onChangeText(e.currentTarget.value)}))}
})
vi.mock('expo-localization',()=>({getLocales:()=>[]}))
vi.mock('expo-router',async()=>({...await (await import('./native-motion.test-support')).routerBoundary(),useRouter:()=>host}))
const flush=()=>act(async()=>{await new Promise(r=>setTimeout(r,0))})
afterEach(async()=>{await cleanup();await matterInputState.clear();vi.clearAllMocks()})
it('header back from cold direct entry replaces with CC',async()=>{
 const demo=makeDemoBackend(),view=directHeaderView(await demo.matter(IDS.notes,'zh-Hans'),'zh-Hans')
 const ui=await mount(withProviders(createElement(DirectHeader,{view,onMore:()=>{}}),{backend:demo}))
 await act(()=>ui.byId('topbar-back').click())
 expect(host.replace).toHaveBeenCalledWith('/');expect(host.back).not.toHaveBeenCalled()
})
it('live relay updates header and composer while keeping the unsent draft',async()=>{
 const demo=makeDemoBackend(), original=await demo.matter(IDS.notes,'zh-Hans')
 let changed=false,hook!:ReturnType<typeof useMatterSay>
 const backend={...demo,matter:async()=>changed?{...original,runId:'demo-notes-2'}:original}
 function Screen(){hook=useMatterSay({kind:'matter',id:IDS.notes});if(!hook.detail.data)return null;const view=directHeaderView(hook.detail.data,'zh-Hans');return createElement('div',null,createElement(DirectHeader,{view,onMore:()=>{}}),createElement(DirectComposer,{view,text:hook.text,onChangeText:hook.setText,onSend:()=>{}}))}
 const ui=await mount(withProviders(createElement(Screen),{backend}));await flush()
 await act(()=>hook.setText('还没发出去'))
 changed=true;await act(()=>hook.detail.refresh());await flush()
 expect(ui.byId('direct-title').textContent).toContain('Codex')
 expect((ui.byId('direct-input') as HTMLTextAreaElement).placeholder).toBe('对 Codex 说…')
 expect((ui.byId('direct-input') as HTMLTextAreaElement).value).toBe('还没发出去')
 const styles=[...ui.container.querySelectorAll('[data-style]')].map(e=>JSON.parse(e.getAttribute('data-style')!))
 expect(styles.some(s=>s.width===36&&s.height===36&&s.borderColor===color.ink)).toBe(true)
 expect(ui.style('direct-send')).toMatchObject({width:44,height:44,backgroundColor:color.accent})
})
it('inline uncertain send shows result awaiting check and retains original text',async()=>{
 const demo=makeDemoBackend(),backend={...demo,say:async()=>{throw new BackendError('timeout')}}
 const view=directHeaderView(await demo.matter(IDS.notes,'zh-Hans'),'zh-Hans')
 const ui=await mount(withProviders(createElement(MatterDirectComposer,{id:IDS.notes,view}),{backend}));await flush()
 await act(()=>{const input=ui.byId('direct-input') as HTMLTextAreaElement;input.value='原文';input.dispatchEvent(new Event('input',{bubbles:true}))})
 await act(()=>ui.byId('direct-send').click());await flush()
 expect(ui.byId('direct-unconfirmed').textContent).toBe('结果待核对')
 expect((ui.byId('direct-input') as HTMLTextAreaElement).value).toBe('原文')
})
it('roster keeps cached avatars offline but removes waiting accent and opens the correct direct target',async()=>{
 const demo=makeDemoBackend();let conn=demo.connection();const listeners=new Set<(c:typeof conn)=>void>()
 const backend:Backend={...demo,connection:()=>conn,onConnection:cb=>{listeners.add(cb);return()=>{listeners.delete(cb)}}}
 const ui=await mount(withProviders(createElement(RosterStrip),{backend}));await flush()
 const styles=()=>[...ui.container.querySelectorAll('[data-style]')].map(e=>JSON.parse(e.getAttribute('data-style')!))
 expect(styles().some(s=>s.width===40&&s.borderColor===color.accent&&s.borderWidth===2)).toBe(true)
 await act(()=>ui.byId('roster-avatar-1').click());expect(host.push).toHaveBeenCalledWith(`/matter/${IDS.trip}`)
 conn={...conn,state:'offline'};await act(()=>{for(const cb of listeners)cb(conn)});await flush()
 expect(ui.byId('roster-strip')).not.toBeNull()
 expect(styles().some(s=>s.borderColor===color.accent)).toBe(false)
 expect(ui.container.textContent).toContain('在做 4')
})
