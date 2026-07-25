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
})
