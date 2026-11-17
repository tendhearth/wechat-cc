// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeDemoBackend } from '../backend/demo'
import { BackendError } from '../backend/types'
import { cleanup, mount } from '../ui/native-motion.test-support'
import { withProviders } from './providers.test-support'
import { clearDrafts, getDraft } from './drafts'
import { matterInputState, matterInputs } from './matter-inputs'
import { useMatterSay } from './matter-say'
import { IDS } from '../backend/demo-data'
vi.mock('react-native', async () => (await import('../ui/native-motion.test-support')).nativeBoundary())
vi.mock('expo-router', async () => (await import('../ui/native-motion.test-support')).routerBoundary())
vi.mock('expo-localization', () => ({ getLocales: () => [] }))
vi.mock('./session', () => ({ useSession: () => ({ pairing:null,inputScope:null }) }))
afterEach(async()=>{await cleanup();await matterInputState.clear();clearDrafts()})
const flush=()=>act(async()=>{await new Promise(r=>setTimeout(r,0))})
it('uncertain task send retains draft; reconnect checks receipt without resending',async()=>{
 const demo=makeDemoBackend(), id=IDS.notes
 let receipt: any=null
 const say=vi.fn(async()=>{throw new BackendError('timeout')})
 const backend={...demo,say,matterInputReceipt:async()=>receipt}
 let hook!:ReturnType<typeof useMatterSay>
 function Probe(){hook=useMatterSay({kind:'matter',id});return null}
 await mount(withProviders(createElement(Probe),{backend}));await flush()
 await act(()=>hook.setText('keep this draft'))
 await act(()=>hook.send());await flush()
 expect(say).toHaveBeenCalledOnce();expect(getDraft(id)).toBe('keep this draft')
 const row=matterInputs(id)[0]!
 expect(row.status).toBe('uncertain')
 receipt={id:row.requestId,taskId:id,runId:row.runId,text:row.text,status:'consumed'}
 await act(()=>matterInputState.reconcile(backend,id));await flush()
 expect(say).toHaveBeenCalledOnce();expect(matterInputs(id)[0]?.status).toBe('consumed')
})
it('agent identity updates do not reset the matter draft',async()=>{
 const backend=makeDemoBackend(), id=IDS.notes
 let hook!:ReturnType<typeof useMatterSay>
 function Probe(){hook=useMatterSay({kind:'matter',id});return null}
 const ui=await mount(withProviders(createElement(Probe),{backend}));await flush()
 await act(()=>hook.setText('unfinished'))
 await act(()=>hook.detail.refresh());await flush()
 expect(hook.text).toBe('unfinished')
})
