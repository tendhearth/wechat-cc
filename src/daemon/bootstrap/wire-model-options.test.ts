import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TIER_PROFILES } from '../../domain/user-tier'
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

  // 安全(10-20):daemon 是 dangerously,但这次 spawn 被压成 strict(访客 / 定时任务)⇒ SDK 选项必须跟着这次 spawn 走。
  it('honours the spawn’s own permissionMode over the daemon-wide one', () => {
    const s = wireModelOptions({ stateDir: dir() }, { plugins: noPlugins, permissionMode: 'dangerously', buildCanUseTool: () => (() => {}) as any, claudeBin: undefined })
    const strict = s.sdkOptionsForProject('P', '/p', TIER_PROFILES.guest, 'guest-chat', undefined, undefined, { permissionMode: 'strict' })
    expect(strict.permissionMode).toBe('default')
    expect(strict.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Write', 'Edit']))
    const owner = s.sdkOptionsForProject('P', '/p', TIER_PROFILES.admin, 'owner', undefined, undefined, { permissionMode: 'dangerously' })
    expect(owner.permissionMode).toBe('bypassPermissions')
    expect(s.sdkOptionsForProject('P', '/p', TIER_PROFILES.admin, 'owner').permissionMode).toBe('bypassPermissions')
  })

  // 定时任务(10-20 终审):只读档的会话 —— 全局 dangerously 下也要 strict 的 SDK 选项;canUseTool 按这一档判
  // (不是按 chatId 取主人的 admin 档);不挂第三方插件 MCP。
  it('a JOB_PROFILE session: strict options, a profile-based gate, no plugin MCP', async () => {
    const { JOB_PROFILE } = await import('../../domain/user-tier')
    const owner = (async () => ({ behavior: 'allow' })) as any
    const s = wireModelOptions({ stateDir: dir() }, {
      plugins: { wechatStdioForClaude: spec, delegateStdioForClaude: spec, pluginMcpForClaude: { wxvault: { type: 'stdio', command: 'wx', args: [] } } as any },
      permissionMode: 'dangerously', buildCanUseTool: () => owner, claudeBin: undefined,
    })
    const o = s.sdkOptionsForProject('job:j1', '/p', JOB_PROFILE, 'owner', undefined, undefined, { permissionMode: 'strict' })
    expect(o.permissionMode).toBe('default')
    expect(o.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Write', 'Edit']))
    expect(Object.keys(o.mcpServers as object)).not.toContain('wxvault')
    expect(o.canUseTool).not.toBe(owner)
    const gate = o.canUseTool!
    const sig = { signal: new AbortController().signal } as any
    expect((await gate('WebSearch', { query: 'x' }, sig)).behavior).toBe('allow')
    expect((await gate('Read', { file_path: '/p/a' }, sig)).behavior).toBe('allow')
    expect((await gate('mcp__wechat__memory_read', {}, sig)).behavior).toBe('allow')
    for (const t of ['Bash', 'Write', 'Agent', 'Monitor', 'mcp__wechat__memory_write', 'mcp__wechat__message', 'mcp__wxvault__sync_wechat_data', 'mcp__wechat__config_set'])
      expect((await gate(t, { command: 'ls' }, sig)).behavior, t).toBe('deny')
    // 主人 / 访客这些标准档照旧用 buildCanUseTool
    expect(s.sdkOptionsForProject('P', '/p', TIER_PROFILES.admin, 'owner').canUseTool).toBe(owner)
  })

  // 2a 审 #408:无人看着 + 私密数据 + 外传通道 ⇒ 读只限项目目录、碰红线拒;读过本地文件后这一轮不再上网。
  it('JOB_PROFILE gate: reads stay in the project, red lines deny, and no network after a local read', async () => {
    const { JOB_PROFILE } = await import('../../domain/user-tier')
    const { homedir } = await import('node:os')
    const state = dir()
    const s = wireModelOptions({ stateDir: state }, { plugins: noPlugins, permissionMode: 'dangerously', buildCanUseTool: () => (async () => ({ behavior: 'allow' })) as any, claudeBin: undefined })
    const sig = { signal: new AbortController().signal } as any
    const fresh = () => s.sdkOptionsForProject('job:j1', '/w/proj', JOB_PROFILE, 'owner', undefined, undefined, { permissionMode: 'strict' }).canUseTool!
    const g1 = fresh()
    for (const input of [{ file_path: `${homedir()}/.ssh/id_rsa` }, { file_path: '/etc/passwd' }, { file_path: '/w/proj/../other/x' }, { file_path: `${state}/agent-config.json` }, { file_path: '/w/proj/.env' }])
      expect((await g1('Read', input, sig)).behavior, JSON.stringify(input)).toBe('deny')
    expect((await g1('Grep', { pattern: 'x', path: homedir() }, sig)).behavior).toBe('deny')
    expect((await g1('WebSearch', { query: 'issue' }, sig)).behavior).toBe('allow')
    expect((await g1('Read', { file_path: '/w/proj/README.md' }, sig)).behavior).toBe('allow')
    expect((await g1('Grep', { pattern: 'TODO' }, sig)).behavior).toBe('allow')          // 没写路径 = 项目目录
    expect((await g1('WebFetch', { url: 'https://x.example/?q=secret' }, sig)).behavior).toBe('deny')
    expect((await g1('WebSearch', { query: 'x' }, sig)).behavior).toBe('deny')
    // 每次 spawn 一个新闸门:污点不跨轮
    expect((await fresh()('WebFetch', { url: 'https://x.example/' }, sig)).behavior).toBe('allow')
  })
})
