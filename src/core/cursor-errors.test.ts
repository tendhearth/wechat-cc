/**
 * Cursor 边界产码(arch backlog #4 第 2 步)。真实原文来自 #188 的样本
 * (`diagnostics/__fixtures__/provider-errors/cursor.json`,沙箱诱发:临时 HOME、假 key、死代理)。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { acpErrorCode, cursorAcpInbandError, cursorPrintErrorCode, stripAnsi } from './cursor-errors'
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

/**
 * cursor-agent acp 把一轮里的失败**写进助理消息**(stopReason 仍是 end_turn)。原文取自 cursor-agent
 * 2026.09.02-c22c1a3 的 ACP 服务端(processPrompt 的 catch:一次 sendAgentMessageChunk,前面固定 `\n\n`)
 * 和 2026-09-17 真机录到的 c4both。只认**整块**:一个 chunk 从头到尾就是这句。
 */
describe('ACP 带内错误(cursorAcpInbandError,一整块 agent_message_chunk)', () => {
  const LOOPING = '\n\nError: NonRetriableError: Agent Looping Detected The model got stuck in a repeating response pattern, so this turn was stopped. Please try again with a different model or start a new conversation. If the problem persists, please contact support.'
  it('真机录到的 Agent Looping Detected ⇒ provider_error,message 是去掉空行的原文', () => {
    expect(cursorAcpInbandError(LOOPING)).toEqual({ code: 'provider_error', message: LOOPING.slice(2) })
  })
  it.each([
    ['Please sign in to continue', 'auth_failed'],
    ['Upgrade your plan to continue', 'quota'],
    ['Add a payment method to continue', 'quota'],
    ['Check your settings to continue', 'provider_error'],
    ['Error: [unauthenticated] Backend rejected authentication. Verify this is a User API Key for the same endpoint/environment, then rerun with --debug for request-level auth logs.', 'auth_rejected'],
    ['Error: RetriableError: [unavailable] getaddrinfo ENOTFOUND api2.cursor.sh', 'network'],
    ['Error: RetriableError: [aborted] Client network socket disconnected before secure TLS connection was established', 'network'],
    ['Error: RetriableError: [deadline_exceeded] the operation timed out', 'network'],
    ['Error: RetriableError: [resource_exhausted] too many requests', 'rate_limited'],
    ['Error: RetriableError: [internal] upstream failure', 'server_error'],
    ['Error: RetriableError: [invalid_argument] prompt too long', 'invalid_request'],
    ['Error: RetriableError: [permission_denied] blocked', 'auth_rejected'],
    ['Error: RetriableError: read ECONNRESET', 'network'],
    ['Error: NonRetriableError: Conversation data missing', 'provider_error'],
    ['Error: Error: something broke', 'provider_error'],
  ] as const)('固定句式 %s ⇒ %s', (body, code) => {
    expect(cursorAcpInbandError(`\n\n${body}`)?.code).toBe(code)
  })
  it('正文里提到这些词 ⇒ 不是错误(不做子串猜测)', () => {
    for (const prose of [
      '我检查过了，没有出现 Agent Looping Detected，也没有 looping。',
      '\n\n模型提示 Error: NonRetriableError: Agent Looping Detected 的时候换个模型就好。',
      'Please sign in to continue', // 没有 CLI 的 `\n\n` 前缀:可能是模型说的
      '\n\nPlease sign in to continue using the dashboard.',
      '\n\nUpgrade your plan to continue.',
      '\n\nError: Tool execution error. MCP error -32602: Structured content does not match',
      '\n\nError: ',
      '\n\nError: something went wrong',
      'Error: NonRetriableError: Agent Looping Detected',
      '',
    ]) expect(cursorAcpInbandError(prose), JSON.stringify(prose)).toBeNull()
  })
})
