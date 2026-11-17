import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInternalApi } from '../../daemon/internal-api'
import { makeSettingsPanel } from '../phone/settings-panel'
import { makeRosterReader } from './reader'
const cleanups: Array<()=>void|Promise<void>> = []
afterEach(async()=>{for(const fn of cleanups.splice(0).reverse())await fn()})
it('真实 HTTP 传递 ETag，device 可读、link 被拒',async()=>{
 const stateDir=mkdtempSync(join(tmpdir(),'roster-http-')); cleanups.push(()=>rmSync(stateDir,{recursive:true,force:true}))
 const roster=makeRosterReader({matters:{list:()=>[]},terminals:()=>[],seen:()=>null})
 const api=createInternalApi({stateDir,daemonPid:1});api.provide({roster});cleanups.push(()=>api.stop())
 const started=await api.start(),token=readFileSync(started.operatorTokenFilePath,'utf8').trim()
 const url=`http://127.0.0.1:${started.port}/v1/roster`
 const first=await fetch(url,{headers:{authorization:`Bearer ${token}`}})
 expect(first.status).toBe(200);const body=await first.json();expect(body.items).toEqual([]);expect(first.headers.get('etag')).toBe(body.version)
 const cached=await fetch(url,{headers:{authorization:`Bearer ${token}`,'if-none-match':body.version}})
 expect(cached.status).toBe(304);expect(await cached.text()).toBe('')
 const panel=makeSettingsPanel({stateDir,ownerChatId:()=>null,chatPrefs:{get:()=>({}),set:()=>({})},getUserName:()=>null,setUserName:async()=>{},log:()=>{},tokens:api.panelTokens,v1:api.panelDispatch});cleanups.push(()=>panel.stop())
 const request=(path:string)=>panel.handleRequest(new Request(`http://panel.local${path}`))
 const paired=await panel.handleRequest(new Request(`http://panel.local/set/api/pair?t=${panel.issueToken()}`,{method:'POST'}))
 const device=(await paired.json()).device_token
 for(const path of ['/v1/roster']){
  const result=await request(`${path}?d=${device}`);expect(result.status).toBe(200);expect(await result.json()).toEqual(body)
  const hit=await panel.handleRequest(new Request(`http://panel.local${path}?d=${device}`,{headers:{'if-none-match':body.version}}));expect(hit.status).toBe(304)
  expect((await request(`${path}?t=${panel.issueToken()}`)).status).toBe(403)
 }
})
