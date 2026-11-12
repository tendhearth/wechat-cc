import {expect,it} from 'vitest'
import {ledgerRoutes} from './ledger-routes'
import {scopeMatterLedger} from '../../lib/matter-ledger-access'
import type {WorkbenchService} from './service'

const secret={agentRuns:[{brief:'LEDGER_PLAN_CANARY'}],notes:[{text:'LEDGER_NOTE_CANARY'}]}
const owner={tier:'admin',origin:'session',chatId:'owner'} as const
const operator={tier:'admin',origin:'operator'} as const
it('notebook sources are owner/operator/device only; other admins, visitors and A2A get neither records nor metadata',async()=>{
  const service={ledgerOwned:()=>true,ledgerRead:()=>secret,matterNotes:(key:string,id?:string)=>{if(key!=='workbench/12345678'||id&&id!=='12345678')throw Error('matter_scope_mismatch');return secret.notes},matterNote:()=>({ok:true}),matterHandoff:async()=>({id:'12345678'})} as unknown as WorkbenchService
  const routes=ledgerRoutes({workbench:service,resolveAdminChatId:()=>'owner'})
  for(const caller of [undefined,{tier:'admin',origin:'session',chatId:'other'}, {tier:'guest',origin:'session',chatId:'owner'}, {tier:'admin',origin:'federation'}, {tier:'admin',origin:'file'}, {tier:'admin',origin:'session',sharedTurn:'ambiguous',turnChatId:'owner'}]){
    expect(await routes['GET /v1/matter/notes']!(new URLSearchParams('matter=12345678'),null,caller as never)).toMatchObject({status:403})
    expect(JSON.stringify(scopeMatterLedger(secret,false))).not.toContain('CANARY')
    expect(await routes['POST /v1/matter/relay']!(new URLSearchParams(),{matter:'12345678',executor:'claude',brief:'接着做'},caller as never)).toMatchObject({status:403})
  }
  for(const caller of [owner,{tier:'admin',origin:'session',sharedTurn:'bound',turnChatId:'owner'},operator,{tier:'admin',origin:'device'}] as const){
    expect(await routes['GET /v1/matter/notes']!(new URLSearchParams('matter=12345678'),null,caller as never)).toMatchObject({status:200,body:secret})
  }
  expect((await routes['POST /v1/matter/relay']!(new URLSearchParams(),{matter:'12345678',executor:'claude',brief:'接着做'},{tier:'admin',origin:'session',sharedTurn:'bound',turnChatId:'owner'})).status).toBe(202)
  expect(scopeMatterLedger(secret,true)).toEqual(secret)
  expect(await routes['POST /v1/matter/relay']!(new URLSearchParams(),{matter:'12345678',executor:'claude',brief:'接着做'},owner)).toMatchObject({status:202})
  expect(await routes['POST /v1/matter/relay']!(new URLSearchParams(),{matter:'12345678',executor:'claude',brief:'接着做'},operator)).toMatchObject({status:403})
})
it('executor reads only its token-bound matter and cannot forge a target or author',async()=>{
  const calls:unknown[]=[]
  const routes=ledgerRoutes({workbench:{matterNotes:(key:string,id?:string)=>{calls.push([key,id]);if(id&&id!=='12345678')throw Error('matter_scope_mismatch');return secret.notes},matterNote:(key:string,text:string)=>{calls.push([key,text]);return {ok:true}}} as unknown as WorkbenchService,resolveAdminChatId:()=>'owner'})
  const caller={tier:'trusted',origin:'session',sessionKey:'workbench/12345678'} as const
  expect((await routes['GET /v1/matter/notes']!(new URLSearchParams(),null,caller)).status).toBe(200)
  expect((await routes['GET /v1/matter/notes']!(new URLSearchParams('matter=87654321'),null,caller)).status).toBe(403)
  expect((await routes['POST /v1/matter/note']!(new URLSearchParams(),{text:'handoff'},caller)).status).toBe(200)
  expect((await routes['POST /v1/matter/note']!(new URLSearchParams(),{text:'fake',author:'owner'},caller)).status).toBe(400)
  expect((await routes['POST /v1/matter/note']!(new URLSearchParams(),{text:'fake',matter:'87654321'},caller)).status).toBe(400)
  expect(calls).toEqual([['workbench/12345678',undefined],['workbench/12345678','87654321'],['workbench/12345678','handoff']])
})
