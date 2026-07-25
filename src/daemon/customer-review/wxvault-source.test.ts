import { describe, expect, it } from 'vitest'
import {
  CustomerChatSourceError,
  WxvaultCustomerChatSource,
  createEvidenceKey,
  normalizeWxvaultConversation,
  normalizeWxvaultMessage,
  normalizeWxvaultMessagesResponse,
  normalizeWxvaultTime,
} from './wxvault-source'
import type { WxvaultToolBridge } from './wxvault-source'

const PRIVATE_CONVERSATION = {
  conversation: '张总',
  username: 'wxid_zhang',
  kind: '单聊',
  last_time: '2026-07-12 14:35:00',
  preview: '好的，等你新版',
}

const RAW_RESPONSE = {
  conversation: '张总',
  username: 'wxid_zhang',
  kind: '单聊',
  count: 2,
  messages: [
    {
      time: '2026-07-12 14:32:00',
      sender: '我',
      type: 'text',
      text: '我这周把新版报价整理好发你',
    },
    {
      time: '2026-07-12 14:35:00',
      sender: '张总',
      type: 'text',
      text: '好的，等你新版',
    },
  ],
}

describe('normalizeWxvaultConversation', () => {
  it('maps a private conversation to the customer-review contact shape', () => {
    expect(normalizeWxvaultConversation(PRIVATE_CONVERSATION)).toEqual({
      id: 'wxid_zhang',
      displayName: '张总',
      kind: 'private',
      lastMessageAt: '2026-07-12T14:35:00',
      preview: '好的，等你新版',
    })
  })

  it('filters groups and official accounts from the first-version scope', () => {
    expect(normalizeWxvaultConversation({ ...PRIVATE_CONVERSATION, kind: '群聊' })).toBeNull()
    expect(normalizeWxvaultConversation({ ...PRIVATE_CONVERSATION, kind: '公众号' })).toBeNull()
  })

  it('filters malformed contacts without a stable id or display name', () => {
    expect(normalizeWxvaultConversation({ ...PRIVATE_CONVERSATION, username: '' })).toBeNull()
    expect(normalizeWxvaultConversation({ ...PRIVATE_CONVERSATION, conversation: '' })).toBeNull()
  })
})

describe('normalizeWxvaultMessage', () => {
  it('identifies owner and contact messages', () => {
    const mine = normalizeWxvaultMessage(RAW_RESPONSE.messages[0]!, { conversationId: 'wxid_zhang' })
    const theirs = normalizeWxvaultMessage(RAW_RESPONSE.messages[1]!, { conversationId: 'wxid_zhang' })
    expect(mine).toMatchObject({ isFromMe: true, sender: '我' })
    expect(theirs).toMatchObject({ isFromMe: false, sender: '张总' })
  })

  it('normalizes local time and preserves a usable media path without requiring text', () => {
    const message = normalizeWxvaultMessage({
      time: '2026-07-12 15:00:00',
      sender: '张总',
      type: 'image',
      text: null,
      file: { path: '/private/local/image.jpg', exists: true },
    }, { conversationId: 'wxid_zhang' })
    expect(message).toMatchObject({
      time: '2026-07-12T15:00:00',
      text: '',
      type: 'image',
      filePath: '/private/local/image.jpg',
    })
  })

  it('uses safe fallbacks for missing sender and type', () => {
    const message = normalizeWxvaultMessage({ time: '2026-07-12 15:00:00' }, { conversationId: 'wxid_zhang' })
    expect(message).toMatchObject({ sender: '未知发送者', type: 'unknown', text: '', isFromMe: false })
  })
})

describe('evidence identity', () => {
  const base = {
    conversationId: 'wxid_zhang',
    time: '2026-07-12T14:32:00',
    sender: '我',
    type: 'text',
    text: '发送新版报价',
  }

  it('is deterministic for the same normalized evidence', () => {
    expect(createEvidenceKey(base)).toBe(createEvidenceKey({ ...base }))
    expect(createEvidenceKey(base)).toMatch(/^[a-f0-9]{24}$/)
  })

  it('changes when contact, time, or text changes', () => {
    const key = createEvidenceKey(base)
    expect(createEvidenceKey({ ...base, conversationId: 'wxid_li' })).not.toBe(key)
    expect(createEvidenceKey({ ...base, time: '2026-07-12T14:33:00' })).not.toBe(key)
    expect(createEvidenceKey({ ...base, text: '发送旧版报价' })).not.toBe(key)
  })
})

describe('normalizeWxvaultMessagesResponse', () => {
  it('normalizes messages and defensively enforces the selected date range', () => {
    const messages = normalizeWxvaultMessagesResponse({
      ...RAW_RESPONSE,
      count: 3,
      messages: [
        { ...RAW_RESPONSE.messages[0], time: '2026-06-30 23:59:59' },
        ...RAW_RESPONSE.messages,
      ],
    }, {
      contactId: 'wxid_zhang',
      from: '2026-07-01',
      to: '2026-07-31',
    })
    expect(messages).toHaveLength(2)
    expect(messages.every(message => message.conversationId === 'wxid_zhang')).toBe(true)
  })

  it('rejects groups, ambiguous names, plugin errors, and mismatched conversation ids', () => {
    const input = { contactId: 'wxid_zhang', from: '2026-07-01', to: '2026-07-31' }
    expect(() => normalizeWxvaultMessagesResponse({ ...RAW_RESPONSE, kind: '群聊' }, input))
      .toThrow(CustomerChatSourceError)
    expect(() => normalizeWxvaultMessagesResponse({ ambiguous: ['张总 A', '张总 B'] }, input))
      .toThrow(/more than one/)
    expect(() => normalizeWxvaultMessagesResponse({ error: '这里可能含敏感插件详情' }, input))
      .toThrow('wxvault could not read the selected conversation')
    expect(() => normalizeWxvaultMessagesResponse({ ...RAW_RESPONSE, username: 'wxid_other' }, input))
      .toThrow(/invalid conversation response/)
  })

  it('does not include private plugin text in surfaced error messages', () => {
    const sensitive = '真实聊天正文不应出现在错误中'
    try {
      normalizeWxvaultMessagesResponse({ error: sensitive }, {
        contactId: 'wxid_zhang', from: '2026-07-01', to: '2026-07-31',
      })
      throw new Error('expected normalization to fail')
    } catch (error) {
      expect(String(error)).not.toContain(sensitive)
    }
  })
})

describe('normalizeWxvaultTime', () => {
  it('rejects malformed and impossible local timestamps', () => {
    expect(() => normalizeWxvaultTime('not-a-time')).toThrow(/invalid message time/)
    expect(() => normalizeWxvaultTime('2026-02-31 12:00:00')).toThrow(/invalid message time/)
  })
})

function fakeBridge(handler: (tool: string, input?: unknown) => unknown): WxvaultToolBridge {
  return {
    async call(tool, input) {
      const result = handler(tool, input)
      return typeof result === 'string' ? result : JSON.stringify(result)
    },
  }
}

describe('WxvaultCustomerChatSource', () => {
  it('calls list_conversations with a trimmed query and maps only private contacts', async () => {
    const calls: Array<{ tool: string; input: unknown }> = []
    const source = new WxvaultCustomerChatSource(fakeBridge((tool, input) => {
      calls.push({ tool, input })
      return [
        PRIVATE_CONVERSATION,
        { ...PRIVATE_CONVERSATION, username: 'room@chatroom', kind: '群聊' },
        { ...PRIVATE_CONVERSATION, username: 'gh_news', kind: '公众号' },
      ]
    }))

    await expect(source.searchContacts('  张总  ')).resolves.toEqual([{
      id: 'wxid_zhang',
      displayName: '张总',
      kind: 'private',
      lastMessageAt: '2026-07-12T14:35:00',
      preview: '好的，等你新版',
    }])
    expect(calls).toEqual([{
      tool: 'list_conversations',
      input: { query: '张总', limit: 20 },
    }])
  })

  it('calls get_messages with the stable contact id, selected range, and bounded limit', async () => {
    const calls: Array<{ tool: string; input: unknown }> = []
    const source = new WxvaultCustomerChatSource(fakeBridge((tool, input) => {
      calls.push({ tool, input })
      return RAW_RESPONSE
    }), { messageLimit: 500 })

    const messages = await source.getMessages({
      contactId: 'wxid_zhang',
      from: '2026-07-01',
      to: '2026-07-31',
      limit: 9_999,
    })
    expect(messages).toHaveLength(2)
    expect(calls).toEqual([{
      tool: 'get_messages',
      input: {
        conversation: 'wxid_zhang',
        limit: 500,
        after: '2026-07-01 00:00:00',
        before: '2026-07-31 23:59:59',
      },
    }])
  })

  it('preserves explicit times while expanding date-only ranges for wxvault', async () => {
    const calls: Array<{ tool: string; input: any }> = []
    const source = new WxvaultCustomerChatSource(fakeBridge((tool, input) => {
      calls.push({ tool, input })
      return RAW_RESPONSE
    }))
    await source.getMessages({
      contactId: 'wxid_zhang',
      from: '2026-07-12 14:00:00',
      to: '2026-07-12 15:00:00',
    })
    expect(calls[0]?.input).toMatchObject({
      after: '2026-07-12 14:00:00',
      before: '2026-07-12 15:00:00',
    })
  })

  it('supports a custom owner label without exposing it to wxvault parameters', async () => {
    const source = new WxvaultCustomerChatSource(fakeBridge(() => ({
      ...RAW_RESPONSE,
      messages: [{ ...RAW_RESPONSE.messages[0], sender: 'Moxiu' }],
    })), { ownerLabel: 'Moxiu' })
    const messages = await source.getMessages({
      contactId: 'wxid_zhang', from: '2026-07-01', to: '2026-07-31',
    })
    expect(messages[0]?.isFromMe).toBe(true)
  })

  it('rejects malformed JSON and invalid top-level payloads', async () => {
    const malformed = new WxvaultCustomerChatSource(fakeBridge(() => '{private chat text'))
    await expect(malformed.searchContacts('张')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })

    const wrongList = new WxvaultCustomerChatSource(fakeBridge(() => ({ contacts: [] })))
    await expect(wrongList.searchContacts('张')).rejects.toThrow(/invalid conversation list/)

    const wrongMessages = new WxvaultCustomerChatSource(fakeBridge(() => []))
    await expect(wrongMessages.getMessages({
      contactId: 'wxid_zhang', from: '2026-07-01', to: '2026-07-31',
    })).rejects.toThrow(/invalid conversation response/)
  })

  it('maps bridge failures to a safe domain error without leaking the original message', async () => {
    const secret = 'child process leaked a private chat line'
    const source = new WxvaultCustomerChatSource({
      async call() { throw new Error(secret) },
    })
    try {
      await source.searchContacts('张')
      throw new Error('expected source call to fail')
    } catch (error) {
      expect(error).toMatchObject({ code: 'WXVAULT_ERROR' })
      expect(String(error)).not.toContain(secret)
    }
  })
})
