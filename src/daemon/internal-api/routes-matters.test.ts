import {describe,expect,it,vi} from 'vitest'
import {mattersRoutes} from './routes-matters'
import {minTierFor} from './route-tiers'
import type {InternalApiDeps} from './types'

const MATTER={id:'deadbeef',kind:'task',title:'整理周报',projectPath:'/work',status:'replied',ownerChatId:'owner',createdAt:1,updatedAt:2}
function deps(overrides:Partial<NonNullable<InternalApiDeps['matters']>>={}):InternalApiDeps {
  return {matters:{list:vi.fn(()=>[MATTER]),detail:vi.fn(()=>({matter:MATTER,bindings:[],sessions:[],task:null,events:[]})),say:vi.fn(async()=>({kind:'task' as const,task:{id:'deadbeef',title:'t',status:'running',providerId:'codex',path:'/work',error:null,updatedAt:3}})),...overrides}} as unknown as InternalApiDeps
}
const q=(s='')=>new URLSearchParams(s)

describe('matters routes',()=>{
  it('are admin-only by tier',()=>{
    for(const route of ['GET /v1/matters','GET /v1/matter','POST /v1/matter/say'])expect(minTierFor(route)).toBe('admin')
  })
  it('lists with validated filters',async()=>{
    const d=deps(),routes=mattersRoutes(d)
    expect(await routes['GET /v1/matters']!(q('kind=task&status=open,replied&since=5&limit=10&surface=desktop'),undefined)).toEqual({status:200,body:{matters:[MATTER]}})
    expect(d.matters!.list).toHaveBeenCalledWith({kind:'task',statuses:['open','replied'],since:5,limit:10,surface:'desktop'})
    for(const bad of ['kind=x','status=weird','since=-1','limit=0','limit=999','kind=task&kind=chat','surface=fax'])expect((await routes['GET /v1/matters']!(q(bad),undefined)).status).toBe(400)
    expect((await mattersRoutes({} as InternalApiDeps)['GET /v1/matters']!(q(),undefined)).status).toBe(503)
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
})
