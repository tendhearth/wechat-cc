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

it('keeps archive writes behind explicit host write access while passing literal search queries',async()=>{
 const upstream=vi.fn(async(_url:string,_init?:RequestInit)=>Response.json({task:{id:'deadbeef'}},{status:200}))
 const readonly=createWorkbenchProxy({stateDir:dir,dryRun:false,allowWrites:false,fetch:upstream})
 expect((await readonly(req('/v1/workbench/archive','POST')))?.status).toBe(403)
 expect(upstream).not.toHaveBeenCalled()
 const writable=createWorkbenchProxy({stateDir:dir,dryRun:false,allowWrites:true,fetch:upstream})
 expect((await writable(req('/v1/workbench/archive','POST')))?.status).toBe(200)
 for(const path of ['/v1/workbench/sessions?providerId=claude','/v1/workbench/session?key=opaque'])expect((await readonly(req(path)))?.status).toBe(200)
 expect((await readonly(req('/v1/workbench/session','POST')))?.status).toBe(405)
 expect((await readonly(req('/v1/workbench/session/extra')))?.status).toBe(405)
 expect((await readonly(req('/v1/workbench?q=..&archived=all&limit=10')))?.status).toBe(200)
 expect(upstream.mock.calls.at(-1)?.[0]).toBe('http://127.0.0.1:9001/v1/workbench?q=..&archived=all&limit=10')
 expect((await writable(req('/v1/workbench/archive/extra','POST')))?.status).toBe(405)
})

const liveRoutes = [
 ['GET', '/v1/workbench/attention'],
 ['POST', '/v1/workbench/input'],
 ['POST', '/v1/workbench/withdraw-input'],
 ['POST', '/v1/workbench/answer'],
] as const

it.each(liveRoutes)('forwards authorized %s %s with the exact method and host credential',async(method,path)=>{
 const upstream=vi.fn(async(_url:string,_init?:RequestInit)=>Response.json({ok:true},{status:202}))
 const proxy=createWorkbenchProxy({stateDir:dir,dryRun:false,allowWrites:method==='POST',fetch:upstream})
 const response=await proxy(req(path,method))
 expect(response?.status).toBe(202)
 expect(await response!.json()).toEqual({ok:true})
 expect(upstream).toHaveBeenCalledTimes(1)
 expect(upstream.mock.calls[0]?.[0]).toBe('http://127.0.0.1:9001'+path)
 expect(upstream.mock.calls[0]?.[1]).toMatchObject({method,headers:{authorization:'Bearer server-only','content-type':'application/json'}})
 expect(upstream.mock.calls[0]?.[1]?.body).toBe(method==='POST'?'{"text":"test"}':undefined)
})

it.each(liveRoutes)('refuses the wrong method and extended paths around %s %s',async(method,path)=>{
 const upstream=vi.fn()
 const proxy=createWorkbenchProxy({stateDir:dir,dryRun:false,allowWrites:true,fetch:upstream})
 for(const [candidateMethod,candidatePath] of [
  [method==='GET'?'POST':'GET',path],
  ['DELETE',path],
  [method,path+'/extra'],
  [method,path+'/'],
 ])expect((await proxy(req(candidatePath!,candidateMethod!)))?.status).toBe(405)
 expect(upstream).not.toHaveBeenCalled()
})

it.each(liveRoutes)('keeps %s %s isolated from mock previews and foreign pages',async(method,path)=>{
 const upstream=vi.fn()
 const dry=createWorkbenchProxy({stateDir:dir,dryRun:true,allowWrites:true,fetch:upstream})
 expect((await dry(req(path,method)))?.status).toBe(503)
 const proxy=createWorkbenchProxy({stateDir:dir,dryRun:false,allowWrites:true,fetch:upstream})
 expect((await proxy(req(path,method,{origin:'https://foreign.example'})))?.status).toBe(403)
 expect((await proxy(req(path,method,{'sec-fetch-site':'cross-site'})))?.status).toBe(403)
 if(method==='POST'){
  const readonly=createWorkbenchProxy({stateDir:dir,dryRun:false,allowWrites:false,fetch:upstream})
  expect((await readonly(req(path,method)))?.status).toBe(403)
 }
 expect(upstream).not.toHaveBeenCalled()
})
