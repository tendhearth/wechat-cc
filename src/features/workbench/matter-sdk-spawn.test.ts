import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { createClaudeAgentProvider, makeWorkbenchClaudeCanUseTool } from '../../adapters/executors/claude/claude-agent-provider'
import { workbenchClaudeOptions } from './wire'
import { makeWorkbenchService } from './service'
import { makeWorkbenchStore } from '../../adapters/store/workbench/store'
import { makeMatterStore } from '../../adapters/store/matters-store'
import { createProviderRegistry } from '../../app/provider-registry'
import { MANAGED_NATIVE_CAPABILITIES } from '../../domain/workbench/executor-capabilities'
import { openTestDb } from '../../lib/db'
import { removeTempDir } from '../../lib/test-temp'

const native = vi.hoisted(() => ({
  initialized: undefined as string[] | undefined,
  argv: [] as string[],
  request: undefined as undefined | ((message: unknown) => Promise<any>),
}))
// Only the external CLI boundary is replaced: the provider, runtime, SDK and
// in-process MCP server all run their real initialization and tools/list.
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>()
  const { EventEmitter } = await import('node:events')
  const { PassThrough } = await import('node:stream')
  return { ...original, spawn: (command: string, args: string[], options: any) => {
    if (!args.includes('/offline/ledger-claude.js')) return original.spawn(command, args, options)
    native.argv = args
    const child = new EventEmitter() as any
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
    child.killed = false; child.exitCode = null
    child.kill = () => { child.killed = true; child.exitCode = 0; child.emit('exit', 0); child.stdout.end(); return true }
    options.signal.addEventListener('abort', () => child.kill(), { once: true })
    let buffer = '', seq = 0
    const waiting = new Map<string, (response: any) => void>()
    const send = (message: unknown) => child.stdout.write(`${JSON.stringify(message)}\n`)
    native.request = message => new Promise(resolve => {
      const request_id = `offline-${++seq}`
      waiting.set(request_id, resolve)
      send({ type: 'control_request', request_id, request: { subtype: 'mcp_message', server_name: 'wechat-cc-matter', message } })
    })
    child.stdin.on('data', (data: Buffer) => {
      buffer += data.toString()
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
        if (!line) continue
        const message = JSON.parse(line)
        if (message.type === 'control_request') {
          if (message.request.subtype === 'initialize') native.initialized = message.request.sdkMcpServers
          send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } })
        } else if (message.type === 'control_response') {
          waiting.get(message.response.request_id)?.(message.response)
          waiting.delete(message.response.request_id)
        }
      }
    })
    return child
  } }
})
afterEach(() => { native.initialized = undefined; native.request = undefined; native.argv = [] })

it.skipIf(process.platform === 'win32')('handoff reaches the real Claude SDK with the notebook allowed and lists both tools over MCP', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ledger-sdk-')), db = openTestDb()
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' })
  git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid')
  writeFileSync(join(root, 'handoff.txt'), 'synthetic baton'); git('add', '.'); git('commit', '-m', 'seed')
  const store = makeWorkbenchStore(db), matters = makeMatterStore(db), registry = createProviderRegistry()
  let spawned: Options | undefined, ledger = false
  registry.register('codex', { async spawn() { return { async *dispatch() {
    yield { kind: 'text' as const, text: 'handoff.txt is ready' }
    yield { kind: 'result' as const, sessionId: 'first', numTurns: 1, durationMs: 1 }
  }, async close() {} } } }, { canResume: () => false, workbench: MANAGED_NATIVE_CAPABILITIES })
  const token = 'offline-notebook-canary'
  registry.register('claude', createClaudeAgentProvider({ sdkOptionsForProject: async (_alias, path, _tier, _chat, _env, instructions, context) => {
    ledger = context?.matterLedger === true
    const spec = ledger ? { command: 'unused', env: { WECHAT_INTERNAL_API: 'http://127.0.0.1:1', WECHAT_SESSION_TOKEN: token } } : null
    spawned = await workbenchClaudeOptions({ cwd: path, executable: 'node', pathToClaudeCodeExecutable: '/offline/ledger-claude.js' }, instructions ?? '', makeWorkbenchClaudeCanUseTool(undefined, undefined, [], [], ledger), { servers: {}, omitted: [] }, undefined, context?.preparationSignal, spec)
    return spawned
  } }), { canResume: () => false, workbench: MANAGED_NATIVE_CAPABILITIES })
  const service = makeWorkbenchService({ store, matters, registry, stateDir: root, ownerChatId: () => 'owner' })
  try {
    const task = service.create({ path: root, providerId: 'codex', text: 'first' })
    await expect.poll(() => service.detail(task.id).task.status).toBe('completed')
    await service.matterHandoff(task.id, 'claude', 'read the notebook')
    await expect.poll(() => native.initialized).toEqual(['wechat-cc-matter'])
    expect(ledger).toBe(true)
    expect(spawned?.mcpServers?.['wechat-cc-matter']).toMatchObject({ type: 'sdk', name: 'wechat-cc-matter' })
    expect(spawned?.allowedTools).toEqual(['mcp__wechat-cc-matter__matter_notes', 'mcp__wechat-cc-matter__matter_note'])
    expect(native.argv.includes('--strict-mcp-config')).toBe(true)
    expect(native.argv.includes('--allowedTools')).toBe(true)
    expect(native.argv.some(arg => arg.includes(token))).toBe(false)
    const initialize = await native.request!({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'offline', version: '1' } } })
    expect(initialize.subtype).toBe('success')
    await native.request!({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const listed = await native.request!({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    expect(listed.response.mcp_response.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(['matter_note', 'matter_notes'])
    expect(listed.response.mcp_response.result.tools.every((tool: { _meta?: Record<string, unknown> }) => tool._meta?.['anthropic/alwaysLoad'] === true)).toBe(true)
  } finally { await service.shutdown(); db.close(); removeTempDir(root) }
})
