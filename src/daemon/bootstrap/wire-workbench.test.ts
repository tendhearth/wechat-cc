import { expect, it, vi } from 'vitest'
import { workbenchClaudeOptions } from './wire-workbench'

it('does not inherit companion memory, MCP servers or daemon permission bypass into office work', async () => {
  const permit = vi.fn(async () => ({ behavior: 'allow' as const }))
  const base = { cwd:'/project',model:'existing-model',permissionMode:'bypassPermissions' as const,mcpServers:{ private:{ command:'private-memory' } },systemPrompt:'private life memory',canUseTool:permit,settingSources:['project' as const,'local' as const] }
  const options=workbenchClaudeOptions(base,'task-only instructions',permit)
  expect(options.permissionMode).toBe('default')
  expect(options.mcpServers).toEqual({})
  expect(options.settingSources).toEqual(['project','local'])
  expect(options.strictMcpConfig).toBe(true)
  expect(options.allowDangerouslySkipPermissions).toBe(false)
  expect(options.hooks).toEqual({})
  expect(options.systemPrompt).toEqual({ type:'preset',preset:'claude_code',append:'task-only instructions' })
  expect(options.model).toBe('existing-model')
  const decision=await options.canUseTool!('mcp__wechat__reply',{text:'publish'}, { signal:new AbortController().signal,toolUseID:'id' })
  expect(decision.behavior).toBe('deny')
})

it('inherits native tools through exact server asks but never inherits companion execution settings', () => {
  const options = workbenchClaudeOptions({ cwd:'/project', model:'native-model', allowedTools:['*'], agents:{ personal:{ description:'private',prompt:'private memory' } }, env:{ PATH:'/bin', ANTHROPIC_API_KEY:'native-auth', WECHAT_SESSION_TOKEN:'private' }, settings:{ permissions:{ defaultMode:'bypassPermissions' } } }, 'task instructions', vi.fn(), { servers:{ catalog:{ command:'catalog-server' } }, omitted:[] })
  expect(options.mcpServers).toEqual({ catalog:{ command:'catalog-server' } })
  expect(options.settings).toMatchObject({ disableAllHooks:true, disableSkillShellExecution:true, permissions:{ defaultMode:'default',disableBypassPermissionsMode:'disable',ask:expect.arrayContaining(['mcp__catalog__*','Bash']) } })
  expect(options.allowedTools).toEqual([])
  expect(options.agents).toBeUndefined()
  expect(options.env).not.toHaveProperty('WECHAT_SESSION_TOKEN')
  expect(options.env?.ANTHROPIC_API_KEY === 'native-auth').toBe(true)
})

it('neutralizes private disk settings environment names at flag scope without overriding ordinary native auth', () => {
  const options=workbenchClaudeOptions({cwd:'/project',env:{CATALOG_API_KEY:'native-tool-auth'}},'',vi.fn(),{
    servers:{catalog:{command:'catalog-server'}},omitted:[],
    privateEnvironmentKeys:['WECHAT_SETTINGS_PROOF','hearth_settings_proof','WXVAULT_SETTINGS_PROOF','WxGraph_SETTINGS_PROOF'],
  })
  expect(options.settings).toMatchObject({env:{
    WECHAT_SETTINGS_PROOF:'',hearth_settings_proof:'',WXVAULT_SETTINGS_PROOF:'',WxGraph_SETTINGS_PROOF:'',
  }})
  expect(options.env?.CATALOG_API_KEY).toBe('native-tool-auth')
  expect(options.settings).not.toHaveProperty('env.CATALOG_API_KEY')
})

it('passes merged native MCP allow and deny policy at flag scope', () => {
  const nativeMcpPolicy={allowedMcpServers:[{serverName:'catalog'},{serverName:'extra'}],deniedMcpServers:[{serverUrl:'https://blocked.example/*'}]}
  const options=workbenchClaudeOptions({cwd:'/project'},'',vi.fn(),{servers:{catalog:{command:'catalog-server'}},omitted:[],nativeMcpPolicy})
  expect(options.settings).toMatchObject(nativeMcpPolicy)
})
