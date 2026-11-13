import { afterEach, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { claudeSdkMcp } from './claude-sdk-mcp'
import { InternalApiError, createInternalApiClient } from './wechat/client'
import { formatErrorShort } from './wechat/tool-helpers'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it.each([
  ['wechat', 'ping', {}],
  ['wechat', 'schedule_reminder', { chat_id: 'owner', text: 'OWNER_MESSAGE_CANARY', delay_seconds: 60 }],
  ['wechat', 'cancel_reminder', { chat_id: 'owner', reminder_id: 'r1' }],
  ['wechat', 'list_reminders', { chat_id: 'OWNER_MESSAGE_CANARY' }],
  ['delegate', 'delegate_codex', { prompt: 'OWNER_MESSAGE_CANARY' }],
] as const)('%s %s logs only status/error code with its own prefix', async (name, tool, args) => {
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  vi.stubGlobal('fetch', async () => Response.json({ error: 'module_off', token: 'TOKEN_CANARY', detail: 'OWNER_MESSAGE_CANARY' }, { status: 503 }))
  const config = await claudeSdkMcp(name, { command: 'unused', env: { WECHAT_INTERNAL_API: 'http://offline.invalid', WECHAT_DELEGATE_PEER: 'codex' } }, { WECHAT_SESSION_TOKEN: 'TOKEN_CANARY', WECHAT_SESSION_TIER: 'trusted' })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'logging-test', version: '1' })
  await config.instance.connect(st)
  await client.connect(ct)
  try {
    await client.callTool({ name: tool, arguments: args })
    const lines = stderr.mock.calls.map(call => String(call[0]))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(`[${name}-mcp]`)
    expect(lines[0]).toContain('503')
    expect(lines[0]).toContain('module_off')
    expect(lines.some(line => /TOKEN_CANARY|OWNER_MESSAGE_CANARY/.test(line))).toBe(false)
  } finally { await client.close() }
})

it('stderr summaries omit query strings, arbitrary error messages and unrecognized error bodies', () => {
  const errors = [
    new InternalApiError('unused', 503, '/v1/search?q=OWNER_MESSAGE_CANARY', { error: 'TOKEN_CANARY', detail: 'OWNER_MESSAGE_CANARY' }),
    new Error('TOKEN_CANARY OWNER_MESSAGE_CANARY'),
    'OWNER_MESSAGE_CANARY',
  ]
  for (const error of errors) expect(/TOKEN_CANARY|OWNER_MESSAGE_CANARY/.test(formatErrorShort(error))).toBe(false)
})

it('401 retry logging never includes a sensitive request query', async () => {
  const lines: string[] = []
  const client = createInternalApiClient({
    baseUrl: 'http://offline.invalid', tokenFilePath: '', sessionToken: 'TOKEN_CANARY', logger: line => lines.push(line),
    fetchImpl: vi.fn(async () => Response.json({ error: 'unauthorized' }, { status: 401 })) as unknown as typeof fetch,
  })
  await client.request('GET', '/v1/search?q=OWNER_MESSAGE_CANARY').catch(() => {})
  expect(lines).toHaveLength(1)
  expect(lines.some(line => /TOKEN_CANARY|OWNER_MESSAGE_CANARY/.test(line))).toBe(false)
})
