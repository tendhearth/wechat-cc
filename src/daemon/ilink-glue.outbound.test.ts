/**
 * sendMessage → outbound health hook (spec 2026-08-22-outbound-health Task 2).
 *
 * Constructs makeIlinkAdapter directly (same style as ilink-glue.test.ts)
 * pointed at a real startFakeIlink() HTTP server, so ilinkSendMessage makes
 * a real wire round-trip. This is lighter than booting the full daemon via
 * __e2e__/harness.ts: no accounts-on-disk, no SDK fakes, no poll loop — and
 * it runs under the default `bun --bun vitest run` config (harness-based
 * __e2e__ tests are excluded from that config and only run under
 * `test:e2e`). Reuses the fake-ilink-server import across the __e2e__
 * boundary, which is fine — it's just a module import, not the e2e-only
 * test *file* itself.
 *
 * The fake server's sendmessage failure toggle (failSendMessage /
 * succeedSendMessage) defaults to errcode -6 ("auth failed"), a
 * non-retryable code per isRetryableSendError — this keeps the test fast
 * by skipping ilinkSendMessage's 1s retry backoff.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeIlinkAdapter, type Account } from './ilink-glue'
import { openTestDb, type Db } from '../lib/db'
import { makeConversationStore } from '../adapters/store/conversation-store'
import type { ConversationStore } from '../ports/conversation-store'
import { startFakeIlink, type FakeIlinkHandle } from './__e2e__/fake-ilink-server'
import {makeMessagesStore} from '../lib/messages-store'
import { makePermissionAnswer } from './permission-answer'
import { WECHAT_PERMISSION_INCOMPLETE } from '../ports/wechat'

function newAdapterDeps(): { db: Db; conversationStore: ConversationStore } {
  const db = openTestDb()
  const conversationStore = makeConversationStore(db)
  return { db, conversationStore }
}

describe('ilink-glue sendMessage → outboundHealth', () => {
  let fake: FakeIlinkHandle

  beforeEach(async () => {
    fake = await startFakeIlink()
  })

  afterEach(async () => {
    await fake.stop()
  })

  function newAdapter() {
    const stateDir = mkdtempSync(join(tmpdir(), 'wcc-outbound-'))
    const acct: Account = { id: 'A1', botId: 'b', userId: 'ubot', baseUrl: fake.baseUrl, token: 'T', syncBuf: '' }
    return makeIlinkAdapter({ stateDir, accounts: [acct], ...newAdapterDeps() })
  }

  it('starts unknown before any send', () => {
    const a = newAdapter()
    expect(a.outboundHealth()).toMatchObject({ state: 'unknown', consecutiveFailures: 0 })
  })

  it('preserves explicit workbench origin in the full outbound audit while splitting transport text',async()=>{
    const deps=newAdapterDeps(),stateDir=mkdtempSync(join(tmpdir(),'wcc-workbench-outbound-'))
    const adapter=makeIlinkAdapter({stateDir,accounts:[{id:'A1',botId:'b',userId:'ubot',baseUrl:fake.baseUrl,token:'T',syncBuf:''}],...deps})
    try{
      adapter.captureContextToken('chat-1','tok-1')
      const text='original private tool details '.repeat(220)
      expect((await adapter.sendMessage('chat-1',text,{source:'workbench'})).error).toBeUndefined()
      const rows=await makeMessagesStore(deps.db).listRange('chat-1',{limit:5})
      expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({source:'workbench',text})
    }finally{await adapter.flush();deps.db.close()}
  })

  it('keeps a wire error that echoes approval content out of logs, health and error replies', async () => {
    const adapter = newAdapter()
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      adapter.captureContextToken('chat-1', 'tok-1')
      const fixture = 'PRIVATE_APPROVAL_COMMAND /test/path PRIVATE_FILE_FRAGMENT'
      const text = `示例 · 112233aa\n〔请求 1234567890abcdef〕\n$ ${fixture}`
      fake.failSendMessage({ errcode: -6, errmsg: text })
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await adapter.sendMessage('chat-1', text, { source: 'workbench', historyText: '待批：运行命令' })
        expect(result.error === 'ilink/sendmessage errcode=-6').toBe(true)
      }
      expect(adapter.outboundHealth().lastError).toBe('ilink/sendmessage errcode=-6')
      expect(write.mock.calls.some(([line]) => String(line).includes('PRIVATE_APPROVAL_COMMAND'))).toBe(false)
      expect(write.mock.calls.some(([line]) => String(line).includes('sendmessage gave up'))).toBe(true)
    } finally {
      write.mockRestore()
      await adapter.flush()
    }
  })

  it('routes blocked code feedback with the inbound account and context, and reports a failed send as unconsumed', async () => {
    const inbound = await startFakeIlink()
    const deps = newAdapterDeps()
    const adapter = makeIlinkAdapter({
      stateDir: mkdtempSync(join(tmpdir(), 'wcc-feedback-')),
      accounts: [fake, inbound].map((server, i) => ({
        id: String(i), botId: 'bot', userId: 'bot', baseUrl: server.baseUrl, token: 'fixture', syncBuf: '',
      })),
      ...deps,
    })
    const logs: string[] = []
    const answer = vi.fn(() => true)
    const consume = makePermissionAnswer({ ilink: adapter, log: (_tag, line) => logs.push(line) })
    try {
      adapter.markChatActive('owner', '0')
      adapter.captureContextToken('owner', 'expired-context')
      const card = `待批：权限请求\n${WECHAT_PERMISSION_INCOMPLETE}\n回「n 01」拒绝。`
      const decision = adapter.registerPendingPermission('request', 10_000, { chatId: 'owner', prompt: 'fixture' }, {
        onDecision: answer,
        renderWechatCard: () => ({ text: card, marker: '1234567890abcdef', complete: false, historyText: 'fixture' }),
      })
      const message = { chatId: 'owner', accountId: '1', contextToken: 'fresh-context', text: 'y 01' }
      expect(await consume(message)).toBe(true)
      expect(fake.outbox()).toHaveLength(0)
      expect(inbound.outbox()).toHaveLength(1)
      expect(inbound.outbox()[0]).toMatchObject({ text: card, raw: { msg: { context_token: 'fresh-context' } } })
      expect(adapter.resolveAccountId('owner')).toBe('0')
      inbound.failSendMessage()
      expect(await consume({ ...message })).toBe(false)
      expect(inbound.failedSends()).toEqual([{ chatId: 'owner', text: WECHAT_PERMISSION_INCOMPLETE }])
      expect(inbound.outbox()).toHaveLength(1)
      expect(logs).toEqual(['consumed reply from chat=owner'])
      expect(answer).not.toHaveBeenCalled()
      expect(adapter.resolvePermission('request', 'deny')).toBe(true)
      await expect(decision).resolves.toBe('deny')
    } finally {
      await adapter.flush()
      await inbound.stop()
      deps.db.close()
    }
  })

  // 2026-10-02 真机:模型调 reply 时 text 只有空白,`!text` 拦不住,微信那头就是一条空气泡。
  it('whitespace-only text never reaches the wire (no blank WeChat bubble)', async () => {
    const a = newAdapter()
    a.captureContextToken('chat-1', 'tok-1')
    for (const t of ['', '   ', '\n', ' \n\t ']) {
      const r = await a.sendMessage('chat-1', t)
      expect(r.error).toBe('empty text')
    }
    expect(fake.outbox()).toHaveLength(0)
  })

  it('a successful wire send flips state to ok', async () => {
    const a = newAdapter()
    a.captureContextToken('chat-1', 'tok-1')
    const r = await a.sendMessage('chat-1', 'hi')
    expect(r.error).toBeUndefined()
    const snap = a.outboundHealth()
    expect(snap.state).toBe('ok')
    expect(snap.consecutiveFailures).toBe(0)
    expect(snap.lastOkAt).not.toBeNull()
  })

  it('wire failures degrade after the default threshold (2); a later success recovers to ok', async () => {
    const a = newAdapter()
    a.captureContextToken('chat-1', 'tok-1')
    fake.failSendMessage({ errcode: -6, errmsg: 'auth failed' })

    const r1 = await a.sendMessage('chat-1', 'one')
    expect(r1.error).toBeTruthy()
    // First failure alone must not cross the threshold yet.
    expect(a.outboundHealth().state).toBe('unknown')
    expect(a.outboundHealth().consecutiveFailures).toBe(1)

    const r2 = await a.sendMessage('chat-1', 'two')
    expect(r2.error).toBeTruthy()
    const degraded = a.outboundHealth()
    expect(degraded.state).toBe('degraded')
    expect(degraded.consecutiveFailures).toBe(2)
    expect(degraded.lastError).toContain('auth failed')

    fake.succeedSendMessage()
    const r3 = await a.sendMessage('chat-1', 'three')
    expect(r3.error).toBeUndefined()
    const recovered = a.outboundHealth()
    expect(recovered.state).toBe('ok')
    expect(recovered.consecutiveFailures).toBe(0)
  })

  it('empty text does not touch the tracker (early return before the wire)', async () => {
    const a = newAdapter()
    a.captureContextToken('chat-1', 'tok-1')
    const before = a.outboundHealth()
    const r = await a.sendMessage('chat-1', '')
    expect(r.error).toBe('empty text')
    expect(a.outboundHealth()).toEqual(before)
  })

  it('an unroutable chat (client-side error) does not touch the tracker', async () => {
    const a = newAdapter()
    const before = a.outboundHealth()
    const r = await a.sendMessage('unknown-chat-never-seen', 'hi')
    expect(r.error).toBeTruthy()
    expect(a.outboundHealth()).toEqual(before)
  })
})
