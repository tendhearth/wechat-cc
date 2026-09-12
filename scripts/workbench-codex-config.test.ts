import { expect, it } from 'vitest'
import { workbenchCodexConfig } from './workbench-codex-config'
it('disables every discovered MCP without copying credentials', () => {
  const config=workbenchCodexConfig([{name:'personal',enabled:true,env:{SECRET:'private'}}])
  expect(config).toEqual({features:{plugins:false,apps:false,hooks:false},mcp_servers:{personal:{enabled:false}}})
  expect(JSON.stringify(config)).not.toContain('private')
})
it('fails closed for an unexpected discovery response', () => {
  for(const value of [null,{},[{}],[{name:''}],[{name:'unsafe.name'}]])expect(()=>workbenchCodexConfig(value)).toThrow()
  expect(workbenchCodexConfig([]).mcp_servers).toEqual({})
})
