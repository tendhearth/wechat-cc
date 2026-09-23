import {expect,it} from 'vitest'
import {workbenchClaudeAuthEnv} from './workbench-claude-config'

it('reuses only authentication configuration and prefers explicit process settings',()=>{
  const result=workbenchClaudeAuthEnv({env:{ANTHROPIC_API_KEY:'saved-key',ANTHROPIC_BASE_URL:'https://configured.example',DANGEROUS_FLAG:'1'},hooks:{startup:'unwanted'}},{ANTHROPIC_API_KEY:'process-key'})
  expect(result).toEqual({ANTHROPIC_API_KEY:'process-key',ANTHROPIC_BASE_URL:'https://configured.example'})
  expect(result).not.toHaveProperty('DANGEROUS_FLAG')
})

it('does not import malformed settings, empty credentials or unrelated environment',()=>{
  expect(workbenchClaudeAuthEnv(null,{HOME:'/home/user'})).toEqual({})
  expect(workbenchClaudeAuthEnv({env:{ANTHROPIC_API_KEY:42,ANTHROPIC_AUTH_TOKEN:''}},{})).toEqual({})
})
