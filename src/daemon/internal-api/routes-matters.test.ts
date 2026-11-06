import {describe,expect,it,vi} from 'vitest'
import {mattersRoutes} from './routes-matters'
import {minTierFor} from './route-tiers'
import type {InternalApiDeps} from './types'

const MATTER={id:'deadbeef',kind:'task',title:'整理周报',projectPath:'/work',status:'replied',ownerChatId:'owner',createdAt:1,updatedAt:2}
function deps(overrides:Partial<NonNullable<InternalApiDeps['matters']>>={}):InternalApiDeps {
  return {matters:{ownerChat:vi.fn(async()=>({matter:MATTER,bindings:[],sessions:[],task:null,events:[]})),list:vi.fn(()=>[MATTER]),detail:vi.fn(()=>({matter:MATTER,bindings:[],sessions:[],task:null,events:[]})),say:vi.fn(async()=>({kind:'task' as const,task:{id:'deadbeef',title:'t',status:'running',providerId:'codex',path:'/work',error:null,updatedAt:3}})),...overrides}} as unknown as InternalApiDeps
}
const q=(s='')=>new URLSearchParams(s)

describe('matters routes',()=>{
  it('are admin-only by tier',()=>{
    for(const route of ['GET /v1/matters','GET /v1/matter','GET /v1/matter/owner-chat','POST /v1/matter/say'])expect(minTierFor(route)).toBe('admin')
  })
  it('lists with validated filters',async()=>{
    const d=deps(),routes=mattersRoutes(d)
    expect(await routes['GET /v1/matters']!(q('kind=task&status=open,replied&since=5&limit=10&surface=desktop'),undefined)).toEqual({status:200,body:{matters:[MATTER]}})
    expect(d.matters!.list).toHaveBeenCalledWith({kind:'task',legacy:['open','replied'],since:5,limit:10,surface:'desktop'})
    for(const bad of ['kind=x','status=weird','since=-1','limit=0','limit=999','kind=task&kind=chat','surface=fax'])expect((await routes['GET /v1/matters']!(q(bad),undefined)).status).toBe(400)
    expect((await mattersRoutes({} as InternalApiDeps)['GET /v1/matters']!(q(),undefined)).status).toBe(503)
  })
  it('marks matters whose workbench run is frozen by the network guard (2026-10-03)',async()=>{
    const d={...deps(),workbenchSuspended:()=>[{taskId:'deadbeef',title:'整理周报',providerId:'codex',since:1}]} as unknown as InternalApiDeps
    expect(await mattersRoutes(d)['GET /v1/matters']!(q(),undefined)).toEqual({status:200,body:{matters:[{...MATTER,networkSuspended:true}]}})
  })
  it('returns the owner chat matter (binding the desktop surface) or 404 when no owner is configured',async()=>{
    const d=deps(),routes=mattersRoutes(d)
    expect((await routes['GET /v1/matter/owner-chat']!(q(),undefined)).status).toBe(200)
    expect(d.matters!.ownerChat).toHaveBeenCalledWith('desktop')
    expect((await mattersRoutes(deps({ownerChat:async()=>null}))['GET /v1/matter/owner-chat']!(q(),undefined)).status).toBe(404)
  })
  it('details one matter and maps not-found / invalid ids',async()=>{
    const routes=mattersRoutes(deps())
    expect((await routes['GET /v1/matter']!(q('id=deadbeef'),undefined)).status).toBe(200)
    expect((await routes['GET /v1/matter']!(q('id=nope'),undefined)).status).toBe(400)
    const missing=mattersRoutes(deps({detail:()=>{throw new Error('matter_not_found')}}))
    expect((await missing['GET /v1/matter']!(q('id=00000000'),undefined)).status).toBe(404)
  })
  it('says into a matter and maps busy / unsupported / unknown errors',async()=>{
    const d=deps(),routes=mattersRoutes(d)
    expect((await routes['POST /v1/matter/say']!(q(),{id:'deadbeef',text:'再改一版'})).status).toBe(200)
    expect(d.matters!.say).toHaveBeenCalledWith('deadbeef','再改一版')
    for(const body of [null,{},{id:'deadbeef'},{id:'bad',text:'x'},{id:'deadbeef',text:'  '}])expect((await routes['POST /v1/matter/say']!(q(),body)).status).toBe(400)
    const busy=mattersRoutes(deps({say:async()=>{throw new Error('workbench_busy')}}))
    expect((await busy['POST /v1/matter/say']!(q(),{id:'deadbeef',text:'x'})).status).toBe(409)
    const unsupported=mattersRoutes(deps({say:async()=>{throw new Error('matter_say_unsupported')}}))
    expect((await unsupported['POST /v1/matter/say']!(q(),{id:'deadbeef',text:'x'})).status).toBe(400)
    const boom=mattersRoutes(deps({say:async()=>{throw new Error('ENOENT: /secret/path')}}))
    expect(await boom['POST /v1/matter/say']!(q(),{id:'deadbeef',text:'x'})).toEqual({status:500,body:{error:'internal'}})
  })
  it.each(['input_conflict','input_stale','input_delivery_busy'])('say preserves %s as HTTP 409',async code=>{
    const routes=mattersRoutes(deps({say:async()=>{throw new Error(code)}}))
    expect(await routes['POST /v1/matter/say']!(q(),{id:'deadbeef',text:'x'})).toEqual({status:409,body:{error:code},cause:code})
  })

})

it('T5d contracts admit only owner operator/device surfaces and validate anchor/stop input',async()=>{
  const window=vi.fn(async()=>({messages:[],earlier:null,later:null,anchor:'m'})),stop=vi.fn(()=>true)
  const routes=mattersRoutes(deps({conversationWindow:window,conversationWork:async()=>({references:[],results:[]}),conversationEvents:()=>({running:null,events:[],cursor:0}),stopConversation:stop}))
  const keys=['GET /v1/protocol/capabilities','GET /v1/matter/owner-chat/window','GET /v1/matter/owner-chat/work','GET /v1/matter/owner-chat/events','POST /v1/matter/owner-chat/stop']
  for(const caller of [undefined,{tier:'admin',origin:'file'},{tier:'admin',origin:'session'},{tier:'admin',origin:'link'},{tier:'trusted',origin:'operator'}])for(const key of keys)expect((await routes[key]!(q('anchor=m'),{turnId:'t'},caller as never)).status).toBe(403)
  expect(window).not.toHaveBeenCalled();expect(stop).not.toHaveBeenCalled()
  for(const origin of ['operator','device']){
    const caller={tier:'admin',origin} as const
    expect((await routes[keys[0]!]!(q(),null,caller as never)).body).toEqual({routes:'v1',topics:'v1'})
    expect((await routes[keys[1]!]!(q('anchor=m&before=n'),null,caller as never)).status).toBe(400)
    expect((await routes[keys[1]!]!(q('anchor=m&limit=3'),null,caller as never)).status).toBe(200)
    expect((await routes[keys[4]!]!(q(),{turnId:'t'},caller as never)).status).toBe(200)
  }
  expect(window).toHaveBeenCalledWith({anchor:'m',limit:3})
  expect(stop).toHaveBeenCalledWith('t')
})
