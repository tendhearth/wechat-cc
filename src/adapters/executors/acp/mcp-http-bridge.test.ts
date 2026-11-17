import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { createMcpHttpBridge, mcpBearerMatches, type McpHttpBridge } from './mcp-http-bridge'
import { acpMcpServersFor } from './acp-cursor-chat'

const fixture = fileURLToPath(new URL('../../../test-support/fixtures/stdio-mcp-bridge.ts', import.meta.url))
const bridges: McpHttpBridge[] = []
afterEach(async () => { await Promise.all(bridges.splice(0).map(b => b.close())) })
const headersFor = (bridge: McpHttpBridge) => Object.fromEntries(bridge.servers[0]!.headers.map(h => [h.name, h.value]))
async function start(log = vi.fn()) {
  const childSpawn = vi.fn(spawn)
  const bridge = await createMcpHttpBridge(acpMcpServersFor({ wechat: { command: process.execPath, args: [...(process.versions.bun ? [] : ['--experimental-strip-types']), fixture] } }, { WECHAT_SESSION_TIER: 'trusted', WECHAT_SESSION_TOKEN: 'offline-internal-token' }), { cwd: process.cwd(), spawn: childSpawn as unknown as typeof spawn, log })
  bridges.push(bridge)
  return { bridge, childSpawn, log }
}

describe.runIf(process.platform !== 'win32')('session stdio → Streamable HTTP MCP', () => {
  it('authenticates correct/wrong/missing tokens with constant-time fixed-size comparisons', () => {
    expect(mcpBearerMatches('Bearer correct', 'correct')).toBe(true)
    for (const wrong of [undefined, '', 'Bearer wrong', 'correct', 'Bearer correct ']) expect(mcpBearerMatches(wrong, 'correct')).toBe(false)
  })
  it('uses loopback, only headers carry its random credential, and no logs/argv/env contain it', async () => {
    const { bridge, childSpawn, log } = await start()
    const entry = bridge.servers[0]!, token = entry.headers[0]!.value.slice(7)
    expect(Buffer.from(token, 'base64url')).toHaveLength(32)
    expect(entry).toMatchObject({ type: 'http', name: 'wechat', headers: [{ name: 'Authorization', value: expect.stringMatching(/^Bearer /) }] })
    expect(new URL(entry.url).hostname).toBe('127.0.0.1')
    expect(new URL(entry.url).search).toBe('')
    expect(entry.url.includes(token)).toBe(false)
    const [command, args, opts] = childSpawn.mock.calls[0]!
    expect(JSON.stringify([command, args]).includes(token)).toBe(false)
    expect(Object.values(opts!.env!).some(v => v?.includes(token))).toBe(false)
    expect(opts!.env!.WECHAT_SESSION_TOKEN).toBe('offline-internal-token')
    expect(opts!.env!.WECHAT_SESSION_TIER).toBe('trusted')
    expect(log.mock.calls.every(row => !row.join(' ').includes(token))).toBe(true)
    expect(bridge.redact(`echo ${token}`)).toBe('echo [redacted]')
    for (const path of [entry.url, entry.url.replace('/mcp/0', '/unknown')]) {
      expect((await fetch(path)).status).toBe(401)
      expect((await fetch(path, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401)
    }
    expect((await fetch(entry.url, { headers: { ...headersFor(bridge), Origin: 'https://untrusted.example' } })).status).toBe(403)
  })
  it('passes initialize, tools/list, tools/call and SSE notifications through the real MCP client', async () => {
    const { bridge } = await start()
    const client = new Client({ name: 'offline-test', version: '1' }, { capabilities: {} })
    const notifications: unknown[] = []
    client.setNotificationHandler(LoggingMessageNotificationSchema, n => { notifications.push(n.params.data) })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(bridge.servers[0]!.url), { requestInit: { headers: headersFor(bridge) } }))
      expect((await client.listTools()).tools.map(t => t.name)).toEqual(['echo'])
      const args = { text: '保留原文', nested: { untouched: true } }
      expect(await client.callTool({ name: 'echo', arguments: args })).toEqual({ content: [{ type: 'text', text: JSON.stringify(args) }] })
      await expect.poll(() => notifications.filter(n => n === 'offline notification')).toEqual(['offline notification'])
    } finally { await client.close() }
  })
  it('keeps notifications with concurrent POST requests when no GET stream exists', async () => {
    const { bridge } = await start()
    const url = bridge.servers[0]!.url
    const headers: Record<string, string> = { ...headersFor(bridge), Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }
    const init = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'offline', version: '1' } } }) })
    headers['Mcp-Session-Id'] = init.headers.get('mcp-session-id')!
    await init.text()
    const responses = await Promise.all([2, 3].map(id => fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'delayed', arguments: { id } } }) }).then(r => r.text())))
    expect(responses.every(text => text.includes('offline notification'))).toBe(true)
    expect(responses.join('').match(/offline notification/g)).toHaveLength(2)
    expect(responses[0]).toContain('"id":2')
    expect(responses[1]).toContain('"id":3')
  })
  it('closes already-started children when a later MCP child fails to spawn', async () => {
    const childSpawn = vi.fn(spawn)
    await expect(createMcpHttpBridge(acpMcpServersFor({ wechat: { command: process.execPath, args: [...(process.versions.bun ? [] : ['--experimental-strip-types']), fixture] }, delegate: { command: '/offline/missing-mcp' } }), { cwd: process.cwd(), spawn: childSpawn as unknown as typeof spawn })).rejects.toThrow('mcp_bridge_start_failed')
    const pid = childSpawn.mock.results[0]!.value.pid!
    expect(() => process.kill(pid, 0)).toThrow()
  })
  it('queues unsolicited notifications until a GET SSE stream connects without a pending POST', async () => {
    const { bridge } = await start()
    const url = bridge.servers[0]!.url
    const headers: Record<string, string> = { ...headersFor(bridge), Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }
    const init = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'offline', version: '1' } } }) })
    headers['Mcp-Session-Id'] = init.headers.get('mcp-session-id')!
    await init.text()
    expect((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })).status).toBe(202)
    // Wait for the fake server to emit its unsolicited message with no POST/GET consumer.
    await new Promise(resolve => setTimeout(resolve, 60))
    const stream = await fetch(url, { headers })
    expect(stream.status).toBe(200)
    const reader = stream.body!.getReader()
    try {
      const event = await reader.read()
      expect(new TextDecoder().decode(event.value)).toContain('idle notification')
    } finally { await reader.cancel() }
  })
  it('rejects the revoked credential with 401 while teardown waits, then closes the listener', async () => {
    const { bridge } = await start()
    const client = new Client({ name: 'offline-test', version: '1' }, { capabilities: {} })
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.servers[0]!.url), { requestInit: { headers: headersFor(bridge) } }))
    const closed = bridge.close()
    expect(bridge.active).toBe(false)
    expect((await fetch(bridge.servers[0]!.url, { headers: headersFor(bridge) })).status).toBe(401)
    await closed
    await client.close()
    await expect(fetch(bridge.servers[0]!.url, { headers: headersFor(bridge) })).rejects.toThrow()
  })
  it('rotates tokens per new/resumed bridge and revokes the old endpoint', async () => {
    const { bridge: old } = await start(), { bridge: next } = await start()
    const oldAuth = headersFor(old)
    expect((await fetch(next.servers[0]!.url, { headers: oldAuth })).status).toBe(401)
    await old.close()
    expect(old.active).toBe(false)
    await expect(fetch(old.servers[0]!.url, { headers: oldAuth })).rejects.toThrow()
    expect((await fetch(next.servers[0]!.url)).status).toBe(401)
  })
  it('closes the endpoint when a stdio process exits and logs no bearer', async () => {
    const { bridge, log } = await start()
    const client = new Client({ name: 'offline-test', version: '1' }, { capabilities: {} })
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.servers[0]!.url), { requestInit: { headers: headersFor(bridge) } }))
    const call = client.callTool({ name: 'exit' }).catch(() => undefined)
    await expect.poll(() => bridge.active).toBe(false)
    await bridge.close()
    await client.close()
    await call
    await expect(fetch(bridge.servers[0]!.url, { headers: headersFor(bridge) })).rejects.toThrow()
    const token = bridge.servers[0]!.headers[0]!.value.slice(7)
    expect(log).toHaveBeenCalledWith('MCP', 'Grok MCP transport stopped')
    expect(log.mock.calls.every(row => !row.join(' ').includes(token))).toBe(true)
  })
})
