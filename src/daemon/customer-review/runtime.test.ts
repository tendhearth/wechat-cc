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

  it('uses the daemon default provider and opens no bridge until asked', async () => {
    const b = bridge()
    const connect = vi.fn(async () => b)
    const runtime = await startCustomerReviewRuntime({
      stateDir: '/unused', db, registry: registry(), defaultProviderId: 'codex',
    }, { loadSpecs: () => ({ wxvault: SPEC }), connect })
    expect(runtime).not.toBeNull()
    // Boot must not touch wxvault: it happens before wireMain(), so anything
    // slow here is dead air on WeChat.
    expect(connect).not.toHaveBeenCalled()

    const id = await runtime!.service.createReview({
      contact: { id: 'wxid_customer', displayName: '测试客户', kind: 'private' },
      rangeFrom: '2026-04-15', rangeTo: '2026-07-15',
    })
    expect(await runtime!.service.getReview(id)).toMatchObject({ provider: 'codex' })
    await runtime!.stop()
    await runtime!.stop()
  })

  it('opens a fresh bridge per operation and always closes it', async () => {
    // A long-lived bridge pinned wxvault's boot-time snapshot (macOS Archive
    // loads once) AND kept sqlite handles open while `plugin setup wxvault`
    // truncates and rewrites those same files.
    const bridges: ReturnType<typeof bridge>[] = []
    const connect = vi.fn(async () => { const b = bridge(); bridges.push(b); return b })
    const runtime = await startCustomerReviewRuntime({
      stateDir: '/unused', db, registry: registry(), defaultProviderId: 'codex',
    }, { loadSpecs: () => ({ wxvault: SPEC }), connect })

    await runtime!.service.searchContacts('测试')
    await runtime!.service.searchContacts('测试')
    expect(connect).toHaveBeenCalledTimes(2)
    expect(bridges).toHaveLength(2)
    for (const b of bridges) expect(b.close).toHaveBeenCalledTimes(1)
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

  it('closes a wxvault bridge missing required read tools and surfaces it on use', async () => {
    const b = bridge(['list_conversations'])
    const runtime = await startCustomerReviewRuntime({
      stateDir: '/unused', db, registry: registry(), defaultProviderId: 'codex',
    }, { loadSpecs: () => ({ wxvault: SPEC }), connect: async () => b })
    // Startup succeeds now — the tool check moved to first use, where the
    // caller gets a real error instead of a silent 503 from boot.
    expect(runtime).not.toBeNull()
    await expect(runtime!.service.searchContacts('x')).rejects.toThrow(/required read tools/)
    expect(b.close).toHaveBeenCalledTimes(1)
  })

  it('gives up on a hung wxvault handshake instead of hanging the caller', async () => {
    // The MCP SDK's own fallback is 60s per request × 2 requests. Boot no
    // longer waits on this at all, but a request still must not hang forever.
    const b = bridge()
    let release: (v: typeof b) => void = () => {}
    const runtime = await startCustomerReviewRuntime({
      stateDir: '/unused', db, registry: registry(), defaultProviderId: 'codex',
    }, {
      loadSpecs: () => ({ wxvault: SPEC }),
      connect: () => new Promise(res => { release = res }),
    })
    expect(runtime).not.toBeNull()

    const started = Date.now()
    await expect(runtime!.service.searchContacts('x')).rejects.toThrow(/exceeded/)
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
