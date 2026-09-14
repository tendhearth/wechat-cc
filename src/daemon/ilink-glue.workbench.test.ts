import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeConversationStore } from '../core/conversation-store'
import { openTestDb } from '../lib/db'
import { makeMessagesStore } from '../lib/messages-store'
import { makeIlinkAdapter, type Account } from './ilink-glue'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function fixture(accounts?: Account[]) {
  const db = openTestDb()
  const configured = accounts ?? [{ id: 'acct-original', botId: 'bot', userId: 'user', baseUrl: 'https://ilink.invalid', token: 'account-secret', syncBuf: '' }]
  const adapter = makeIlinkAdapter({
    stateDir: mkdtempSync(join(tmpdir(), 'wcc-workbench-')),
    accounts: configured,
    db,
    conversationStore: makeConversationStore(db),
  })
  return { adapter, db, messages: makeMessagesStore(db) }
}

const notice = {
  id: 'notice-1', taskId: 'task-1', runId: 'run-1', ownerChatId: 'chat-owner',
  accountId: 'acct-original', text: '任务完成。',
}

describe('IlinkAdapter workbench transport', () => {
  it('resolves a chat account only from a persisted route to an exact configured account', () => {
    const { adapter } = fixture()
    expect(adapter.chatAccountId!('chat-owner')).toBeNull()
    adapter.routeChatToAccount('chat-owner', 'acct-original')
    expect(adapter.chatAccountId!('chat-owner')).toBe('acct-original')
    adapter.routeChatToAccount('chat-owner', 'removed-account')
    expect(adapter.chatAccountId!('chat-owner')).toBeNull()
  })

  it('preflights binding before reading account credentials or reaching the wire', async () => {
    let tokenReads = 0
    const account = {
      id: 'acct-original', botId: 'bot', userId: 'user', baseUrl: 'https://ilink.invalid', syncBuf: '',
      get token() { tokenReads++; return 'must-not-be-read' },
    }
    const { adapter } = fixture([account])
    adapter.routeChatToAccount('chat-owner', 'acct-rebound')
    globalThis.fetch = vi.fn() as unknown as typeof fetch
    await expect(adapter.sendWorkbenchNotice!(notice)).resolves.toEqual({ status: 'blocked', reason: 'binding_changed' })
    expect(tokenReads).toBe(0)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('never falls back to another account when the original account disappeared', async () => {
    const { adapter } = fixture([{ id: 'acct-other', botId: 'bot', userId: 'user', baseUrl: 'https://other.invalid', token: 'other-secret', syncBuf: '' }])
    adapter.routeChatToAccount('chat-owner', 'acct-original')
    adapter.captureContextToken('chat-owner', 'context')
    globalThis.fetch = vi.fn() as unknown as typeof fetch
    await expect(adapter.sendWorkbenchNotice!(notice)).resolves.toEqual({ status: 'blocked', reason: 'account_unavailable' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('defers before dispatch when the original chat context is missing', async () => {
    const { adapter } = fixture()
    adapter.routeChatToAccount('chat-owner', 'acct-original')
    globalThis.fetch = vi.fn() as unknown as typeof fetch
    await expect(adapter.sendWorkbenchNotice!(notice)).resolves.toEqual({ status: 'deferred', reason: 'missing_context' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it.each(['', 'x'.repeat(4001)])('blocks invalid text without dispatch', async text => {
    const { adapter } = fixture()
    adapter.routeChatToAccount('chat-owner', 'acct-original')
    adapter.captureContextToken('chat-owner', 'context')
    globalThis.fetch = vi.fn() as unknown as typeof fetch
    await expect(adapter.sendWorkbenchNotice!({ ...notice, text })).resolves.toEqual({ status: 'blocked', reason: 'invalid_text' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('uses the notice id once on the wire and audits accepted text as workbench memory', async () => {
    const { adapter, messages } = fixture()
    adapter.routeChatToAccount('chat-owner', 'acct-original')
    adapter.captureContextToken('chat-owner', 'context')
    globalThis.fetch = vi.fn(async () => new Response('{"errcode":0}')) as unknown as typeof fetch
    await expect(adapter.sendWorkbenchNotice!(notice)).resolves.toEqual({ status: 'accepted' })
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    const body = JSON.parse(String((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1].body))
    expect(body.msg.client_id).toBe('notice-1')
    await expect(messages.listRange('chat-owner', { limit: 10 })).resolves.toEqual([
      expect.objectContaining({ chatId: 'chat-owner', direction: 'out', kind: 'text', text: '任务完成。', source: 'workbench' }),
    ])
  })

  it('keeps a known server acceptance accepted when audit storage fails', async () => {
    const { adapter, db } = fixture()
    adapter.routeChatToAccount('chat-owner', 'acct-original')
    adapter.captureContextToken('chat-owner', 'context')
    db.close()
    globalThis.fetch = vi.fn(async () => new Response('{"ret":0}')) as unknown as typeof fetch
    await expect(adapter.sendWorkbenchNotice!(notice)).resolves.toEqual({ status: 'accepted' })
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })
})
