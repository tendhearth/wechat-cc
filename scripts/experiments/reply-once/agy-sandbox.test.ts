import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { agentMarkdown, assertBxProtected, sandboxAgyArgs, sandboxMcpEnv, startFakeInternalApi, writeAgySandboxWorkspace, AGY_SANDBOX_AGENT, WECHAT_MCP_MAIN } from './agy-sandbox'

describe('agy 沙盒(回复交付第 2 步)', () => {
  it('agent 定义:不继承全局定制、不继承全局 MCP;frontmatter 里没有 mcpServers(写了 agy 就找不到这个 agent)', () => {
    const md = agentMarkdown('/abs/plugin')
    expect(md).toContain('inheritCustomizations: false')
    expect(md).toContain('inheritMcp: false')
    expect(md).toContain('plugins: ["/abs/plugin"]')
    expect(md).not.toMatch(/mcpServers/)
  })

  it('工作区:插件里的 MCP 是生产的 wechat MCP 入口,env 同 daemon 写进全局配置的形状;daemon 臂多一个 WECHAT_REPLY_DELIVERY', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-sbx-'))
    const api = { url: 'http://127.0.0.1:9', token: 't', tokenFile: '/x', close: async () => {} }
    const agentDir = writeAgySandboxWorkspace(dir, { mode: 'daemon', api, stateDir: '/state' })
    const cfg = JSON.parse(readFileSync(join(agentDir, 'plugin', 'mcp_config.json'), 'utf8'))
    expect(cfg.mcpServers.wechat.args).toEqual([WECHAT_MCP_MAIN])
    expect(existsSync(WECHAT_MCP_MAIN)).toBe(true)
    expect(cfg.mcpServers.wechat.env).toMatchObject({ WECHAT_SESSION_TIER: 'trusted', WECHAT_REPLY_DELIVERY: 'daemon', WECHAT_INTERNAL_API: api.url, WECHAT_STATE_DIR: '/state' })
    expect(sandboxMcpEnv({ mode: 'tool', api, stateDir: '/s' }).WECHAT_REPLY_DELIVERY).toBeUndefined()
    expect(readFileSync(join(agentDir, 'agent.md'), 'utf8')).toContain(join(agentDir, 'plugin'))
  })

  it('参数:--new-project 换成沙盒项目,加 --agent 与 --sandbox', () => {
    expect(sandboxAgyArgs(['-p', 'hi', '--new-project', '--dangerously-skip-permissions'], 'P1'))
      .toEqual(['-p', 'hi', '--project', 'P1', '--dangerously-skip-permissions', '--agent', AGY_SANDBOX_AGENT, '--sandbox'])
    expect(sandboxAgyArgs(['-p', 'hi', '--conversation', 'c'], 'P1')).not.toContain('--project')
  })

  it('bx 不是 protected + healthy ⇒ 抛(整批中止);找不到 bx ⇒ 抛', async () => {
    const exec = (out: object) => async () => ({ stdout: JSON.stringify(out), stderr: '', exitCode: 0 })
    await expect(assertBxProtected({ bin: '/bx', exec: exec({ protection_state: 'protected', tunnel_healthy: true }) })).resolves.toMatch(/保护/)
    await expect(assertBxProtected({ bin: '/bx', exec: exec({ protection_state: 'unprotected', tunnel_healthy: true }) })).rejects.toThrow(/中止/)
    await expect(assertBxProtected({ bin: '/bx', exec: exec({ protection_state: 'protected', tunnel_healthy: false }) })).rejects.toThrow(/中止/)
    await expect(assertBxProtected({ bin: null })).rejects.toThrow(/bx/)
  })

  it('假 internal API:令牌对不上 ⇒ 401;对上 ⇒ handler 的答案', async () => {
    const api = await startFakeInternalApi(mkdtempSync(join(tmpdir(), 'agy-api-')), async (m, p, b) => ({ m, p, b }))
    try {
      expect((await fetch(`${api.url}/v1/x`, { headers: { Authorization: 'Bearer nope' } })).status).toBe(401)
      const r = await fetch(`${api.url}/v1/turn/attach`, { method: 'POST', headers: { Authorization: `Bearer ${api.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'voice' }) })
      expect(await r.json()).toEqual({ m: 'POST', p: '/v1/turn/attach', b: { kind: 'voice' } })
    } finally { await api.close() }
  })
})
