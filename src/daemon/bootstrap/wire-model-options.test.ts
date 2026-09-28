import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TIER_PROFILES } from '../../core/user-tier'
import { wireModelOptions } from './wire-model-options'

const dir = () => mkdtempSync(join(tmpdir(), 'wmo-'))
const spec = { command: 'x', args: [], env: { A: '1' } }
const noPlugins = { wechatStdioForClaude: null, delegateStdioForClaude: null, pluginMcpForClaude: {} }

describe('wireModelOptions', () => {
  it('sdkOptionsForProject:cwd / wechat+delegate stdio(会话 env 合并进去)/ preset 提示 / canUseTool', () => {
    const s = wireModelOptions({ stateDir: dir() }, {
      plugins: { wechatStdioForClaude: spec, delegateStdioForClaude: spec, pluginMcpForClaude: {} },
      permissionMode: 'strict',
      buildCanUseTool: () => (async () => ({ behavior: 'allow' })) as any,
      claudeBin: undefined,
    })
    const o = s.sdkOptionsForProject('P', '/p', TIER_PROFILES.admin, 'chat-1', { WECHAT_SESSION_TOKEN: 't' }, 'hello')
    expect(o.cwd).toBe('/p')
    expect((o.mcpServers as any).wechat.env).toMatchObject({ A: '1', WECHAT_SESSION_TOKEN: 't' })
    expect((o.mcpServers as any).delegate.type).toBe('stdio')
    expect((o.systemPrompt as any).append).toBe('hello')
    expect(typeof o.canUseTool).toBe('function')
    expect(o.settingSources).toEqual(['project', 'local'])
    expect(o.pathToClaudeCodeExecutable).toBeUndefined()
  })
  it('没钉模型时 currentModelFor 报各家默认名,claude 走 currentClaudeModel', () => {
    const s = wireModelOptions({ stateDir: dir() }, { plugins: noPlugins, permissionMode: 'strict', buildCanUseTool: () => (() => {}) as any, claudeBin: undefined })
    expect(s.currentModelFor('claude')).toBe(s.currentClaudeModel())
    expect(typeof s.currentModelFor('cursor')).toBe('string')
    expect(typeof s.currentModelFor('agy')).toBe('string')
    expect(s.currentModelFor('openai')).toBeUndefined()
  })
  it('claudeBin 给了就进 pathToClaudeCodeExecutable', () => {
    const s = wireModelOptions({ stateDir: dir() }, { plugins: noPlugins, permissionMode: 'dangerously', buildCanUseTool: () => (() => {}) as any, claudeBin: '/bin/claude' })
    expect(s.sdkOptionsForProject('P', '/p', TIER_PROFILES.admin, 'c').pathToClaudeCodeExecutable).toBe('/bin/claude')
  })
})
