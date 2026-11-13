import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { wireModelOptions } from './wire-model-options'
import { delegateStdioMcpSpec, wechatStdioMcpSpec } from './mcp-specs'
import { TIER_PROFILES } from '../../domain/user-tier'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { claudeSdkMcp } from '../../mcp-servers/claude-sdk-mcp'
import { createClaudeAgentProvider } from '../../adapters/executors/claude/claude-agent-provider'

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

it('Claude SDK spawn argv and general env exclude both core MCP session tokens', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'chat-token-argv-'))
  const token = 'CLAUDE_CHAT_ARGV_SECRET_CANARY'
  const internalApi = { baseUrl: 'http://127.0.0.1:1', tokenFilePath: join(stateDir, 'unused-token') }
  try {
    const { sdkOptionsForProject } = wireModelOptions({ stateDir }, {
      plugins: {
        wechatStdioForClaude: wechatStdioMcpSpec(internalApi, 'claude'),
        delegateStdioForClaude: delegateStdioMcpSpec(internalApi, 'codex'),
        pluginMcpForClaude: { thirdParty: { type: 'stdio', command: '/offline/plugin', args: [] } },
      },
      permissionMode: 'strict', buildCanUseTool: () => async () => ({ behavior: 'allow' }), claudeBin: undefined,
    })
    const options = await sdkOptionsForProject('P', stateDir, TIER_PROFILES.admin, 'owner', {
      WECHAT_SESSION_TOKEN: token, WECHAT_SESSION_TIER: 'admin',
    })
    let captured: { args: string[]; env: NodeJS.ProcessEnv } | undefined
    try {
      const run = query({ prompt: 'offline capture', options: {
        ...options, executable: 'node', pathToClaudeCodeExecutable: '/offline/fake-claude.js',
        spawnClaudeCodeProcess: opts => { captured = opts; throw Error('captured_offline_spawn') },
      } })
      for await (const event of run) void event
    } catch (error) { expect((error as Error).message).toContain('captured_offline_spawn') }
    expect(captured?.args).toContain('/offline/fake-claude.js')
    expect(captured!.args.join(' ')).not.toContain(token)
    expect(Object.values(captured!.env).some(v => v?.includes(token))).toBe(false)
    expect(options.mcpServers!.thirdParty).not.toHaveProperty('env.WECHAT_SESSION_TOKEN')
  } finally { rmSync(stateDir, { recursive: true, force: true }) }
})

async function connect(config: McpSdkServerConfigWithInstance) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await config.instance.connect(serverTransport)
  const client = new Client({ name: 'offline', version: '1' })
  await client.connect(clientTransport)
  return client
}

it('parent MCP sessions retain tier tool gates, provider routing and isolated wechat/delegate bearer closures', async () => {
  const calls: { path: string; token: string | null; body: unknown }[] = []
  vi.stubEnv('WECHAT_SESSION_TOKEN', 'unrelated-ambient-token')
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ path: new URL(url).pathname + new URL(url).search, token: new Headers(init.headers).get('authorization'), body: init.body ? JSON.parse(String(init.body)) : undefined })
    return Response.json(url.includes('/health') ? { ok: true, daemon_pid: 42 } : { ok: true, status: 'running' })
  })
  const spec = { command: 'unused', env: { WECHAT_INTERNAL_API: 'http://offline.invalid', WECHAT_INTERNAL_TOKEN_FILE: '/unused', WECHAT_PARTICIPANT_TAG: 'claude', WECHAT_DELEGATE_PEER: 'codex' } }
  const clients: Client[] = []
  try {
    for (const tier of ['admin', 'trusted', 'guest'] as const) {
      const config = await claudeSdkMcp('wechat', spec, { WECHAT_SESSION_TOKEN: tier + '-token', WECHAT_SESSION_TIER: tier })
      const client = await connect(config); clients.push(client)
      const names = (await client.listTools()).tools.map(t => t.name)
      expect(names).toContain('ping')
      expect(names.includes('model_set')).toBe(tier === 'admin')
      expect(names.includes('message')).toBe(tier === 'admin')
      expect(names.includes('matter_handoff')).toBe(tier === 'admin')
      expect(names.includes('provider_switch')).toBe(tier !== 'guest')
      for (const old of ['reply', 'reply_voice', 'broadcast']) expect(names).not.toContain(old)
      await client.callTool({ name: 'ping', arguments: {} })
      if (tier === 'admin') {
        await client.callTool({ name: 'model_get', arguments: {} })
        await client.callTool({ name: 'model_set', arguments: { model: 'fixture-model' } })
      }
    }
    const delegate = await connect(await claudeSdkMcp('delegate', spec, { WECHAT_SESSION_TOKEN: 'delegate-token' })); clients.push(delegate)
    expect((await delegate.listTools()).tools.map(t => t.name)).toEqual(['delegate_codex'])
    await delegate.callTool({ name: 'delegate_codex', arguments: { prompt: 'offline opinion' } })
    // Reusing an earlier session after constructing others must keep its bearer.
    await clients[0]!.callTool({ name: 'ping', arguments: {} })
    expect(calls.filter(c => c.path === '/v1/health').map(c => c.token)).toEqual(['Bearer admin-token', 'Bearer admin-token', 'Bearer trusted-token', 'Bearer guest-token', 'Bearer admin-token'])
    expect(calls).toContainEqual({ path: '/v1/model?provider=claude', token: 'Bearer admin-token', body: undefined })
    expect(calls).toContainEqual({ path: '/v1/model', token: 'Bearer admin-token', body: { model: 'fixture-model', provider: 'claude' } })
    expect(calls).toContainEqual({ path: '/v1/delegate', token: 'Bearer delegate-token', body: { peer: 'codex', prompt: 'offline opinion', depth: 0 } })
  } finally { await Promise.all(clients.map(c => c.close())) }
})

it('closing a parent MCP transport aborts in-flight HTTP work instead of leaving terminal polling alive', async () => {
  let pendingSignal: AbortSignal | undefined
  let started = false
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    started = true
    pendingSignal = init.signal ?? undefined
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
    })
  })
  const config = await claudeSdkMcp('wechat', { command: 'unused', env: { WECHAT_INTERNAL_API: 'http://offline.invalid', WECHAT_INTERNAL_TOKEN_FILE: '/unused' } }, { WECHAT_SESSION_TOKEN: 'private-token', WECHAT_SESSION_TIER: 'trusted' })
  const client = await connect(config)
  const work = client.callTool({ name: 'ping', arguments: {} }).catch(() => undefined)
  await expect.poll(() => started).toBe(true)
  await client.close()
  expect(pendingSignal?.aborted).toBe(true)
  await work
})

it.each([undefined, 'old-session'])('Claude conversation spawn sanitizes ambient env and preserves resume (%s)', async resumeSessionId => {
  vi.stubEnv('WECHAT_SESSION_TOKEN', 'CLAUDE_AMBIENT_SECRET_CANARY')
  let captured: { args: string[]; env: NodeJS.ProcessEnv } | undefined
  const abortController = new AbortController()
  const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({ abortController }), queryImpl: input => query({ ...input, options: {
    ...input.options, executable: 'node', pathToClaudeCodeExecutable: '/offline/fake-claude.js',
    spawnClaudeCodeProcess: opts => { captured = opts; throw Error('captured_offline_spawn') },
  } }) })
  await expect(provider.spawn({ alias: 'p', path: '/offline' }, { chatId: 'owner', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', resumeSessionId })).rejects.toThrow('captured_offline_spawn')
  expect(captured).toBeDefined()
  expect(abortController.signal.aborted).toBe(true)
  expect([...captured!.args, ...Object.values(captured!.env)].some(v => v?.includes('SECRET_CANARY'))).toBe(false)
  if (resumeSessionId) expect(captured!.args).toEqual(expect.arrayContaining(['--resume', resumeSessionId]))
})
