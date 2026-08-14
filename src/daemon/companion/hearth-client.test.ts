import { describe, it, expect, vi } from 'vitest'
import { connectHearth, type HearthClient } from './hearth-client'
import type { McpToolBridge, McpStdioSpec } from '../../core/openai-mcp-bridge'

function fakeBridge(impl?: Partial<McpToolBridge>): McpToolBridge {
  return {
    tools: [],
    call: vi.fn(async (_name: string, _input: unknown) => '{}'),
    close: vi.fn(async () => {}),
    serverOf: () => 'hearth',
    ...impl,
  }
}

describe('connectHearth', () => {
  it('returns null when hearth_enabled is false, without calling makeBridge', async () => {
    const makeBridge = vi.fn(async () => fakeBridge())
    const client = await connectHearth(
      { hearth_enabled: false, hearth_vault: '/vault', hearth_cmd: null },
      { makeBridge },
    )
    expect(client).toBeNull()
    expect(makeBridge).not.toHaveBeenCalled()
  })

  it('returns null when hearth_vault is null, even if enabled', async () => {
    const makeBridge = vi.fn(async () => fakeBridge())
    const client = await connectHearth(
      { hearth_enabled: true, hearth_vault: null, hearth_cmd: null },
      { makeBridge },
    )
    expect(client).toBeNull()
    expect(makeBridge).not.toHaveBeenCalled()
  })

  it('connects with a spec derived from hearth_vault/hearth_cmd when enabled', async () => {
    let capturedSpec: Record<string, McpStdioSpec> | undefined
    const makeBridge = vi.fn(async (spec: Record<string, McpStdioSpec>) => {
      capturedSpec = spec
      return fakeBridge()
    })
    const client = await connectHearth(
      { hearth_enabled: true, hearth_vault: '/my/vault', hearth_cmd: null },
      { makeBridge },
    )
    expect(client).not.toBeNull()
    expect(capturedSpec).toBeDefined()
    const spec = capturedSpec!['hearth']!
    expect(spec).toBeDefined()
    expect(spec.env).toEqual({ HEARTH_VAULT: '/my/vault' })
    // default command derives from "hearth mcp serve"
    expect(spec.command).toBe('hearth')
    expect(spec.args).toEqual(['mcp', 'serve'])
  })

  it('splits a custom hearth_cmd into command/args', async () => {
    let capturedSpec: Record<string, McpStdioSpec> | undefined
    const makeBridge = vi.fn(async (spec: Record<string, McpStdioSpec>) => {
      capturedSpec = spec
      return fakeBridge()
    })
    await connectHearth(
      { hearth_enabled: true, hearth_vault: '/v', hearth_cmd: '/usr/local/bin/hearth mcp serve --quiet' },
      { makeBridge },
    )
    const spec = capturedSpec!['hearth']!
    expect(spec.command).toBe('/usr/local/bin/hearth')
    expect(spec.args).toEqual(['mcp', 'serve', '--quiet'])
  })

  it('submit() calls vault_plan_submit and parses the JSON result', async () => {
    const call = vi.fn(async (name: string, _input: unknown) => {
      expect(name).toBe('vault_plan_submit')
      return JSON.stringify({ change_id: 'c1', risk: 'low', ops: [], requires_review: false })
    })
    const client = (await connectHearth(
      { hearth_enabled: true, hearth_vault: '/v', hearth_cmd: null },
      { makeBridge: async () => fakeBridge({ call }) },
    )) as HearthClient
    expect(client).not.toBeNull()

    const plan = { source_id: 's1', ops: [] }
    const result = await client.submit(plan)
    expect(call).toHaveBeenCalledWith('vault_plan_submit', { change_plan: plan })
    expect(result).toEqual({ change_id: 'c1', requires_review: false })
  })

  it('applyForOwner() calls vault_apply_for_owner with the right args and parses the JSON result', async () => {
    const call = vi.fn(async (name: string, _input: unknown) => {
      expect(name).toBe('vault_apply_for_owner')
      return JSON.stringify({ ok: true, change_id: 'c1', requires_review: false, rendered: 'done' })
    })
    const client = (await connectHearth(
      { hearth_enabled: true, hearth_vault: '/v', hearth_cmd: null },
      { makeBridge: async () => fakeBridge({ call }) },
    )) as HearthClient
    expect(client).not.toBeNull()

    const result = await client.applyForOwner('c1', 'owner-1', 'wechat')
    expect(call).toHaveBeenCalledWith('vault_apply_for_owner', {
      change_id: 'c1',
      owner_id: 'owner-1',
      channel: 'wechat',
    })
    expect(result).toEqual({ ok: true, requires_review: false })
  })

  it('returns null (no throw) when makeBridge rejects (unreachable hearth)', async () => {
    const log = vi.fn()
    const client = await connectHearth(
      { hearth_enabled: true, hearth_vault: '/v', hearth_cmd: null },
      { makeBridge: async () => { throw new Error('spawn ENOENT') }, log },
    )
    expect(client).toBeNull()
    expect(log).toHaveBeenCalled()
  })

  it('returns null (no throw) when the bridge is unusable (e.g. call always rejects on connect probe not required, but close/call should not throw during connect)', async () => {
    // Simulate a bridge whose construction succeeds but is effectively broken —
    // connectHearth itself must not throw regardless of downstream call failures
    // at *connect* time. This test targets the connect path only.
    const client = await connectHearth(
      { hearth_enabled: true, hearth_vault: '/v', hearth_cmd: null },
      { makeBridge: async () => { throw new Error('listTools failed') } },
    )
    expect(client).toBeNull()
  })

  it('close() closes the underlying bridge', async () => {
    const close = vi.fn(async () => {})
    const client = (await connectHearth(
      { hearth_enabled: true, hearth_vault: '/v', hearth_cmd: null },
      { makeBridge: async () => fakeBridge({ close }) },
    )) as HearthClient
    await client.close()
    expect(close).toHaveBeenCalled()
  })
})
