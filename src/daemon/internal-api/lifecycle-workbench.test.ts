import { expect, it } from 'vitest'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerInternalApi } from './lifecycle'

it('preserves an empty workbench token allowlist through the production lifecycle wrapper', async () => {
  const stateDir=mkdtempSync(join(tmpdir(),'workbench-token-'))
  const api=await registerInternalApi({stateDir,daemonPid:1} as never)
  try {
    const token=api.mintSessionToken('trusted','workbench/deadbeef',{routeAllow:new Set()})
    const response=await fetch(`${api.baseUrl}/v1/health`,{headers:{authorization:`Bearer ${token}`}})
    expect(response.status).toBe(403)
    api.invalidateSession('workbench/deadbeef')
    const revoked=await fetch(`${api.baseUrl}/v1/health`,{headers:{authorization:`Bearer ${token}`}})
    expect(revoked.status).toBe(401)
  } finally { await api.stop(); rmSync(stateDir,{recursive:true,force:true}) }
})
