import { expect, it, vi } from 'vitest'
import { workbenchClaudeOptions } from './wire-workbench'

it('does not inherit companion memory, MCP servers or daemon permission bypass into office work', async () => {
  const permit = vi.fn(async () => ({ behavior: 'allow' as const }))
  const base = { cwd:'/project',model:'existing-model',permissionMode:'bypassPermissions' as const,mcpServers:{ private:{ command:'private-memory' } },systemPrompt:'private life memory',canUseTool:permit,settingSources:['project' as const,'local' as const] }
  const options=workbenchClaudeOptions(base,'task-only instructions',permit)
  expect(options.permissionMode).toBe('default')
  expect(options.mcpServers).toEqual({})
  expect(options.settingSources).toEqual([])
  expect(options.hooks).toEqual({})
  expect(options.systemPrompt).toEqual({ type:'preset',preset:'claude_code',append:'task-only instructions' })
  expect(options.model).toBe('existing-model')
  const decision=await options.canUseTool!('mcp__wechat__reply',{text:'publish'}, { signal:new AbortController().signal,toolUseID:'id' })
  expect(decision.behavior).toBe('deny')
})
