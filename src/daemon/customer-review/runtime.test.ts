import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openTestDb, type Db } from '../../lib/db'
import { createProviderRegistry } from '../../core/provider-registry'
import type { AgentProvider } from '../../core/agent-provider'
import type { McpToolBridge } from '../../core/openai-mcp-bridge'
import { startCustomerReviewRuntime } from './runtime'

const SPEC = { command: '/fake/wxvault', args: [] }

function provider(cheapEval?: (prompt: string) => Promise<string>): AgentProvider {
  return { spawn: async () => { throw new Error('not used') }, ...(cheapEval ? { cheapEval } : {}) }
}

function bridge(toolNames = ['list_conversations', 'get_messages']): McpToolBridge {
  return {
    tools: toolNames.map(name => ({ name, description: name, parameters: {} })),
    call: vi.fn(async name => name === 'list_conversations' ? '[]' : JSON.stringify({
      conversation: '测试客户', username: 'wxid_customer', kind: '单聊', count: 0, messages: [],
    })),
    close: vi.fn(async () => {}),
    serverOf: () => 'wxvault',
  }
}

describe('customer review daemon runtime', () => {
  let db: Db
  beforeEach(() => { db = openTestDb() })
  afterEach(() => db.close())

  function registry() {
    const r = createProviderRegistry()
    r.register('claude', provider(async () => JSON.stringify({ version: 1, commitments: [] })), {
      displayName: 'Claude', canResume: () => false,
    })
    r.register('codex', provider(async () => JSON.stringify({ version: 1, commitments: [] })), {
      displayName: 'Codex', canResume: () => false,
    })
    return r
  }

  it('uses the daemon default provider and closes its dedicated wxvault bridge', async () => {
    const b = bridge()
    const runtime = await startCustomerReviewRuntime({
      stateDir: '/unused', db, registry: registry(), defaultProviderId: 'codex',
    }, {
      loadSpecs: () => ({ wxvault: SPEC }),
      connect: async () => b,
    })
    expect(runtime).not.toBeNull()
    const id = await runtime!.service.createReview({
      contact: { id: 'wxid_customer', displayName: '测试客户', kind: 'private' },
      rangeFrom: '2026-04-15', rangeTo: '2026-07-15',
    })
    expect(await runtime!.service.getReview(id)).toMatchObject({ provider: 'codex' })
    await runtime!.stop()
    await runtime!.stop()
    expect(b.close).toHaveBeenCalledTimes(1)
  })

  it('stays disabled without wxvault or without an evaluation provider', async () => {
    const connect = vi.fn(async () => bridge())
    expect(await startCustomerReviewRuntime({
      stateDir: '/unused', db, registry: registry(), defaultProviderId: 'codex',
    }, { loadSpecs: () => ({}), connect })).toBeNull()
    expect(connect).not.toHaveBeenCalled()

    const empty = createProviderRegistry()
    empty.register('codex', provider(), { displayName: 'Codex', canResume: () => false })
    expect(await startCustomerReviewRuntime({
      stateDir: '/unused', db, registry: empty, defaultProviderId: 'codex',
    }, { loadSpecs: () => ({ wxvault: SPEC }), connect })).toBeNull()
    expect(connect).not.toHaveBeenCalled()
  })

  it('closes and disables a wxvault bridge missing required read tools', async () => {
    const b = bridge(['list_conversations'])
    expect(await startCustomerReviewRuntime({
      stateDir: '/unused', db, registry: registry(), defaultProviderId: 'codex',
    }, { loadSpecs: () => ({ wxvault: SPEC }), connect: async () => b })).toBeNull()
    expect(b.close).toHaveBeenCalledTimes(1)
  })

  it('gives up on a hung wxvault handshake instead of holding daemon boot', async () => {
    // This runs BEFORE wireMain(), so a hung handshake means nobody polls
    // WeChat. The MCP SDK's own fallback is 60s per request × 2 requests.
    const b = bridge()
    let release: (v: typeof b) => void = () => {}
    const started = Date.now()
    const runtime = await startCustomerReviewRuntime({
      stateDir: '/unused', db, registry: registry(), defaultProviderId: 'codex',
    }, {
      loadSpecs: () => ({ wxvault: SPEC }),
      connect: () => new Promise(res => { release = res }),
    })
    expect(runtime).toBeNull()
    expect(Date.now() - started).toBeLessThan(30_000)
    // A late bridge must be closed, not left holding the decrypted sqlite.
    release(b)
    await new Promise(r => setTimeout(r, 10))
    expect(b.close).toHaveBeenCalled()
  }, 40_000)

  it('never lets a startup throw take the daemon down', async () => {
    // loadPlugins()/bundledPluginsDir()/evaluator() used to sit outside the
    // try, so a throw reached main.ts's catch → await shutdown() → daemon exits.
    const lines: string[] = []
    const runtime = await startCustomerReviewRuntime({
      stateDir: '/unused', db, registry: registry(), defaultProviderId: 'codex',
      log: (_tag, line) => { lines.push(line) },
    }, { loadSpecs: () => { throw new Error('plugin manifest is corrupt') } })
    expect(runtime).toBeNull()
    expect(lines.join('\n')).toMatch(/plugin manifest is corrupt/)
  })
})
