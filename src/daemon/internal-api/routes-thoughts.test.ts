import { createInternalApi } from './index'
import { it, expect } from 'vitest'
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { thoughtRoutes } from './routes-thoughts'
import { minTierFor } from './route-tiers'
import type { InternalApiDeps } from './types'

it('reads retained thoughts without exposing chat ids, and does not claim they were executed', async () => {
  const stateDir=mkdtempSync(join(tmpdir(),'cc-thoughts-'))
  try {
    mkdirSync(join(stateDir,'companion'))
    writeFileSync(join(stateDir,'companion/plan-log.json'),JSON.stringify({days:{'2026-09-11':[{at:'2026-09-11T12:00:00Z',chatId:'private-id',decision:'visit',why:'想去看看朋友',source:'model',executed:false},{at:'2026-09-11T13:00:00Z',chatId:'private-id',decision:'visit',why:'fallback:timeout',source:'fallback'}]}}))
    const r=await thoughtRoutes({stateDir} as InternalApiDeps)['GET /v1/companion/thoughts']!(new URLSearchParams(),undefined)
    expect(r.status).toBe(200)
    expect(JSON.stringify(r.body)).toContain('想去看看朋友')
    expect(JSON.stringify(r.body)).not.toContain('private-id')
    expect(JSON.stringify(r.body)).not.toContain('executed')
    expect(JSON.stringify(r.body)).not.toContain('fallback:timeout')
    expect(minTierFor('GET /v1/companion/thoughts')).toBe('admin')
    writeFileSync(join(stateDir,'companion/plan-log.json'),'{broken')
    expect((await thoughtRoutes({stateDir} as InternalApiDeps)['GET /v1/companion/thoughts']!(new URLSearchParams(),undefined)).status).toBe(503)
  } finally {rmSync(stateDir,{recursive:true,force:true})}
})

it('native operator can read thoughts while a trusted chat token cannot', async () => {
  const stateDir=mkdtempSync(join(tmpdir(),'cc-thought-auth-'))
  const api=createInternalApi({stateDir,daemonPid:1} as InternalApiDeps)
  try {
    const {port,tokenFilePath,operatorTokenFilePath}=await api.start()
    const request=(token:string)=>fetch(`http://127.0.0.1:${port}/v1/companion/thoughts`,{headers:{authorization:`Bearer ${token}`}})
    const denied=await request(readFileSync(tokenFilePath,'utf8').trim())
    expect(denied.status).toBe(403)
    const allowed=await request(readFileSync(operatorTokenFilePath,'utf8').trim())
    expect(allowed.status).toBe(200)
    expect(await allowed.json()).toEqual({items:[]})
  } finally {await api.stop();rmSync(stateDir,{recursive:true,force:true})}
})
