import {beforeEach, afterEach, it, expect, vi} from 'vitest'
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createWorkbenchProxy} from './workbench-proxy'
let dir:string
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'cc-wb-proxy-'));writeFileSync(join(dir,'operator'),'server-only');writeFileSync(join(dir,'internal-api-info.json'),JSON.stringify({baseUrl:'http://127.0.0.1:9001',operatorTokenFilePath:join(dir,'operator')}))})
afterEach(()=>rmSync(dir,{recursive:true,force:true}))
const req=(path='/v1/workbench',method='GET',headers={})=>new Request('http://127.0.0.1:4187'+path,{method,headers,...(method==='POST'?{body:'{"text":"test"}'}:{})})
it('proxies exact reads with a host-only credential and preserves query/status',async()=>{
 const upstream=vi.fn(async(_url:string,_init?:RequestInit)=>Response.json({tasks:[]}, {status:200}))
 const proxy=createWorkbenchProxy({stateDir:dir,dryRun:false,allowWrites:false,fetch:upstream})
 const res=await proxy(req('/v1/workbench/task?id=deadbeef'))
 expect(upstream.mock.calls[0]?.[0]).toBe('http://127.0.0.1:9001/v1/workbench/task?id=deadbeef')
 expect((upstream.mock.calls[0] as any)[1].headers.authorization).toBe('Bearer server-only')
 expect(await res!.text()).toBe('{"tasks":[]}')
})
it('mock mode and default read-only mode never reach a real daemon for mutations',async()=>{
 const upstream=vi.fn()
 for(const flags of [{dryRun:true,allowWrites:true},{dryRun:false,allowWrites:false}]){
 const res=await createWorkbenchProxy({stateDir:dir,fetch:upstream,...flags})(req('/v1/workbench/create','POST'))
 expect(res!.status).toBe(flags.dryRun?503:403)
 }
 expect(upstream).not.toHaveBeenCalled()
})
it('only explicit task writes pass; cross-origin and unknown routes are refused',async()=>{
 const upstream=vi.fn(async()=>Response.json({task:{id:'deadbeef'}},{status:202}))
 const proxy=createWorkbenchProxy({stateDir:dir,dryRun:false,allowWrites:true,fetch:upstream})
 expect((await proxy(req('/v1/workbench/create','POST')))?.status).toBe(202)
 expect((await proxy(req('/v1/workbench/permission','POST')))?.status).toBe(202)
 expect((await proxy(req('/v1/workbench/create','POST',{origin:'http://localhost:9999'})))?.status).toBe(403)
 expect((await proxy(req('/v1/workbench/task/extra')))?.status).toBe(405)
 expect(await proxy(req('/v1/memory'))).toBeNull()
 expect(upstream).toHaveBeenCalledTimes(2)
})
it('distinguishes an old upstream from missing local routing',async()=>{
 const proxy=createWorkbenchProxy({stateDir:dir,dryRun:false,allowWrites:false,fetch:vi.fn(async()=>Response.json({error:'not_found'},{status:404}))})
 expect(await (await proxy(req()))!.json()).toEqual({error:'workbench_endpoint_missing'})
})
it('rejects non-loopback Host even with matching same-origin headers',async()=>{
 const upstream=vi.fn(async()=>Response.json({task:{id:'deadbeef'}},{status:202}))
 const proxy=createWorkbenchProxy({stateDir:dir,dryRun:false,allowWrites:true,fetch:upstream})
 const res=await proxy(new Request('http://attacker.example:4187/v1/workbench/create',{
  method:'POST',headers:{origin:'http://attacker.example:4187','sec-fetch-site':'same-origin'},body:'{}',
 }))
 expect(res?.status).toBe(403)
 expect(upstream).not.toHaveBeenCalled()
})
