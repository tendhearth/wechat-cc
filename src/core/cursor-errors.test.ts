/**
 * Cursor 边界产码(arch backlog #4 第 2 步)。真实原文来自 #188 的样本
 * (`diagnostics/__fixtures__/provider-errors/cursor.json`,沙箱诱发:临时 HOME、假 key、死代理)。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { acpErrorCode, cursorPrintErrorCode, stripAnsi } from './cursor-errors'
import { AcpRequestError } from './acp/rpc'
import { cursorOneShotEval, type CursorSpawnFn } from './cursor-eval'
import { providerErrorCodeOf } from '../lib/provider-error-code'

const samples = JSON.parse(readFileSync(join(__dirname, '../daemon/diagnostics/__fixtures__/provider-errors/cursor.json'), 'utf8')) as Array<{ id: string; message: string; errorCode: string | null; status?: number; droppedStructure?: Record<string, unknown> }>
const byId = (id: string) => samples.find(s => s.id === id)!

describe('print 模式(一次性评估)—— 每条真实样本的码与 fixture 一致', () => {
  it.each(samples.filter(s => s.id.endsWith('.cheap_eval')).map(s => [s.id, s] as const))('%s', (_id, s) => {
    expect(cursorPrintErrorCode(s.message) ?? null).toBe(s.errorCode)
  })
  it('三句固定输出:key 无效 ⇒ auth_rejected;连不上 Cursor API ⇒ network;催升级 ⇒ quota', () => {
    expect(cursorPrintErrorCode(byId('cursor.bad_key.cheap_eval').message)).toBe('auth_rejected')
    expect(cursorPrintErrorCode(byId('cursor.net_proxy.cheap_eval').message)).toBe('network')
    expect(cursorPrintErrorCode('Upgrade your plan to continue')).toBe('quota')
  })
  it('剥掉 ANSI 颜色再认', () => {
    expect(stripAnsi('\u001b[31m✗ Failed to reach the Cursor API.\u001b[0m')).toBe('✗ Failed to reach the Cursor API.')
    expect(cursorPrintErrorCode('\u001b[33m⚠ Warning: The provided API key is invalid.\u001b[0m')).toBe('auth_rejected')
  })
})

describe('ACP JSON-RPC 错误', () => {
  const rpc = (code: number, message: string, data?: unknown) => new AcpRequestError({ code, message, data } as never)
  it('-32000 ⇒ auth_failed(cursor-agent 要先 agent login)', () => {
    const raw = byId('cursor.not_logged_in.acp_raw')
    expect(acpErrorCode(rpc(-32000, raw.message, { message: raw.droppedStructure?.['error.data.message'] }))).toBe('auth_failed')
  })
  it('-32603 + `Failed to initialize session services`:假 key 与死代理逐字相同 ⇒ provider_error,不猜', () => {
    for (const id of ['cursor.bad_key.acp', 'cursor.net_proxy.acp']) {
      const d = byId(id).droppedStructure!
      expect(acpErrorCode(rpc(d['error.code'] as number, 'Internal error', { message: d['error.data.message'] }))).toBe('provider_error')
    }
    expect(acpErrorCode(rpc(-32603, 'Internal error'))).toBe('provider_error')
  })
  it('data 说清了原因就用它;不是 ACP 错误 ⇒ undefined', () => {
    expect(acpErrorCode(rpc(-32603, 'Internal error', { message: 'Failed to reach the Cursor API' }))).toBe('network')
    expect(acpErrorCode(rpc(-32602, 'Invalid params'))).toBe('invalid_request')
    expect(acpErrorCode(new Error('acp_process_exited: 1'))).toBeUndefined()
  })
})

describe('cursorOneShotEval 带码抛出(之前:全判 unknown)', () => {
  const spawnWith = (stdout: string, exit: number, stderr: string): CursorSpawnFn => () => ({
    stdout: (async function* () { if (stdout) yield stdout })(),
    exited: Promise.resolve(exit),
    stderr: async () => stderr,
    kill: () => {},
  })
  it.each([
    ['cursor.bad_key.cheap_eval', 'auth_rejected'],
    ['cursor.net_proxy.cheap_eval', 'network'],
    ['cursor.not_logged_in.cheap_eval', 'auth_failed'],
  ] as const)('%s ⇒ %s', async (id, code) => {
    const stderr = byId(id).message.replace(/^cursor-agent exited 1: /, '')
    const err = await cursorOneShotEval(spawnWith('', 1, stderr), 'auto', 'x').catch(e => e)
    expect(providerErrorCodeOf(err)).toBe(code)
    expect((err as Error).message).toMatch(/^cursor-agent exited 1: /)
  })
})
