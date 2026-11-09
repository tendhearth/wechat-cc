import { expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { workbenchCodexConfig } from './codex-config'
import { codexChatThreadConfig } from './codex-chat-provider'
import { TIER_PROFILES } from '../../../domain/user-tier'

// SECURITY INVARIANT: current sandbox permits broad host reads. Loopback would
// turn readable owner credentials into callable approval authority. Any future
// network/local-binding design must first prove task credentials unreadable and
// trustworthy daemon/host isolation; a domain denylist is insufficient.
it('keeps workbench and every dialogue tier offline without a managed proxy',()=>{
  const configs=[workbenchCodexConfig([]),...Object.values(TIER_PROFILES).map(tierProfile=>codexChatThreadConfig(undefined,{tierProfile,permissionMode:'strict'},false))]
  for(const config of configs){expect(config).toMatchObject({sandbox_workspace_write:{network_access:false},features:{network_proxy:false}})}
})
it('has no local-binding or managed-proxy activation path',()=>{
  const root=fileURLToPath(new URL('.',import.meta.url))
  for(const name of readdirSync(root).filter(n=>n.endsWith('.ts')&&!n.endsWith('.test.ts'))){
    const source=readFileSync(join(root,name),'utf8')
    expect(source,name).not.toMatch(/allow_local_binding|TASK_LOOPBACK_PROXY|supportsTaskLoopback|network_access\s*[:=]\s*true/)
  }
})
