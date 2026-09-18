import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { AcpRequestError, createAcpConnection } from './rpc'

function harness(overrides: Partial<Parameters<typeof createAcpConnection>[2]> = {}) {
  const stdin = new PassThrough(), stdout = new PassThrough()
  const written: any[] = []
  let pending = ''
  stdin.on('data', chunk => { pending += String(chunk); let i; while ((i = pending.indexOf('\n')) >= 0) { written.push(JSON.parse(pending.slice(0, i))); pending = pending.slice(i + 1) } })
  const onRequest = vi.fn(async () => ({ ok: true })), onNotification = vi.fn(), onFatal = vi.fn()
  const conn = createAcpConnection(stdin, stdout, { rpcTimeoutMs: 50, onRequest, onNotification, onFatal, ...overrides })
  const agent = (msg: unknown) => stdout.write(JSON.stringify(msg) + '\n')
  const flushed = () => new Promise(resolve => setTimeout(resolve, 0))
  return { conn, written, agent, onRequest, onNotification, onFatal, flushed, stdout }
}

describe('ACP JSON-RPC over stdio', () => {
  it('pairs responses by id and rejects error responses with code and data', async () => {
    const h = harness()
    const p1 = h.conn.request('initialize', { a: 1 }), p2 = h.conn.request('session/new', {})
    await h.flushed()
    expect(h.written).toEqual([{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { a: 1 } }, { jsonrpc: '2.0', id: 2, method: 'session/new', params: {} }])
    h.agent({ jsonrpc: '2.0', id: 2, result: { sessionId: 's' } })
    h.agent({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'auth', data: { x: 1 } } })
    await expect(p2).resolves.toEqual({ sessionId: 's' })
    const err = await p1.catch(e => e)
    expect(err).toBeInstanceOf(AcpRequestError); expect(err.code).toBe(-32000); expect(err.message).toBe('auth'); expect(err.data).toEqual({ x: 1 })
  })
  it('times out with the method name, and 0 means no timeout', async () => {
    const h = harness()
    await expect(h.conn.request('slow', {})).rejects.toThrow('acp_rpc_timeout: slow')
    const p = h.conn.request('session/prompt', {}, 0)
    await new Promise(resolve => setTimeout(resolve, 80))
    h.agent({ jsonrpc: '2.0', id: 2, result: { stopReason: 'end_turn' } })
    await expect(p).resolves.toEqual({ stopReason: 'end_turn' })
  })
  it('answers agent requests with result or error and routes notifications', async () => {
    const h = harness({ onRequest: vi.fn(async (method: string) => { if (method === 'fs/read_text_file') throw Object.assign(new Error('client capability not declared: fs/read_text_file'), { code: -32601 }); return { outcome: 'x' } }) })
    h.agent({ jsonrpc: '2.0', id: 'r1', method: 'session/request_permission', params: { p: 1 } })
    h.agent({ jsonrpc: '2.0', id: 'r2', method: 'fs/read_text_file', params: {} })
    h.agent({ jsonrpc: '2.0', method: 'session/update', params: { u: 1 } })
    await h.flushed(); await h.flushed()
    expect(h.written).toContainEqual({ jsonrpc: '2.0', id: 'r1', result: { outcome: 'x' } })
    expect(h.written).toContainEqual({ jsonrpc: '2.0', id: 'r2', error: { code: -32601, message: 'client capability not declared: fs/read_text_file' } })
    expect(h.onNotification).toHaveBeenCalledWith('session/update', { u: 1 })
  })
  it('reports fatal once on invalid JSON and on oversized lines', async () => {
    const h = harness()
    h.stdout.write('{not json\n'); h.stdout.write('{"also":"bad"\n')
    await h.flushed()
    expect(h.onFatal).toHaveBeenCalledTimes(1); expect(h.onFatal.mock.calls[0]![0].message).toBe('acp_invalid_protocol_message')
    const big = harness()
    big.stdout.write('x'.repeat(4 * 1024 * 1024 + 1))
    await big.flushed()
    expect(big.onFatal.mock.calls[0]![0].message).toBe('acp_line_too_long')
  })
  it('dispose rejects pending and later requests, and late agent requests get -32603', async () => {
    const h = harness()
    const p = h.conn.request('x', {}, 0)
    h.conn.dispose(new Error('acp_session_closed'))
    await expect(p).rejects.toThrow('acp_session_closed')
    await expect(h.conn.request('y', {})).rejects.toThrow('acp_session_closed')
    h.agent({ jsonrpc: '2.0', id: 'late', method: 'session/request_permission', params: {} })
    await h.flushed()
    expect(h.written.at(-1)).toEqual({ jsonrpc: '2.0', id: 'late', error: { code: -32603, message: 'acp_session_closed' } })
    expect(h.onRequest).not.toHaveBeenCalled()
  })
  it('reports write failure as fatal instead of throwing', async () => {
    const h = harness()
    const closed = new PassThrough(); closed.end()
    const conn2 = createAcpConnection(closed, new PassThrough(), { rpcTimeoutMs: 10, onRequest: async () => null, onNotification: () => {}, onFatal: h.onFatal })
    conn2.notify('session/cancel', {})
    await expect.poll(() => h.onFatal.mock.calls.length).toBeGreaterThan(0)
    expect(h.onFatal).toHaveBeenCalledWith(expect.objectContaining({ message: 'acp_protocol_write_failed' }))
  })
})
