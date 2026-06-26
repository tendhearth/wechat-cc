/**
 * wechat-mcp ilink-bound message family (RFC 03 P1.B B1) — reply / reply_voice
 * / send_file / edit_message / broadcast. The "reply-tool family" detected by
 * both providers' replyToolCalled flag. Split out of main.ts; behavior verbatim.
 *
 * RFC 03 P3: the daemon sets WECHAT_PARTICIPANT_TAG to the providerId on this
 * MCP child; `reply` forwards it so internal-api can prefix `[Claude]`/`[Codex]`
 * in parallel + chatroom modes (ignored in solo).
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { InternalApiClient } from './client'
import { passthroughErrorResult } from './tool-helpers'

const PARTICIPANT_TAG = process.env.WECHAT_PARTICIPANT_TAG

export function registerMessagingTools(server: McpServer, client: InternalApiClient): void {
  server.registerTool(
    'reply',
    {
      title: 'Reply text to a wechat user',
      description: '给当前微信用户回复文本。chat_id 必填。长文本会自动分段。',
      inputSchema: { chat_id: z.string(), text: z.string() },
    },
    async ({ chat_id, text }) => {
      try {
        const r = await client.request<unknown>('POST', '/v1/wechat/reply', {
          chat_id, text,
          ...(PARTICIPANT_TAG ? { participant_tag: PARTICIPANT_TAG } : {}),
        })
        return { content: [{ type: 'text', text: JSON.stringify(r) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'reply')
      }
    },
  )

  server.registerTool(
    'reply_voice',
    {
      title: 'Reply via voice message',
      description: '用语音回复用户。仅在用户明确要求语音回复时使用（"念一下"/"语音回复"/"speak it" 等）。文本 ≤ 500 字；不适合代码块、长 URL、结构化列表。',
      inputSchema: { chat_id: z.string(), text: z.string() },
    },
    async ({ chat_id, text }) => {
      try {
        const r = await client.request<unknown>('POST', '/v1/wechat/reply_voice', { chat_id, text })
        return { content: [{ type: 'text', text: JSON.stringify(r) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'reply_voice')
      }
    },
  )

  server.registerTool(
    'send_file',
    {
      title: 'Send a local file to a wechat user',
      description: '给当前用户发送文件（本地绝对路径）。',
      inputSchema: { chat_id: z.string(), path: z.string() },
    },
    async ({ chat_id, path }) => {
      try {
        const r = await client.request<unknown>('POST', '/v1/wechat/send_file', { chat_id, path })
        return { content: [{ type: 'text', text: JSON.stringify(r) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'send_file')
      }
    },
  )

  server.registerTool(
    'edit_message',
    {
      title: 'Edit a previously-sent message',
      description: '编辑已发送的消息（需要 msg_id）。',
      inputSchema: { chat_id: z.string(), msg_id: z.string(), text: z.string() },
    },
    async ({ chat_id, msg_id, text }) => {
      try {
        const r = await client.request<unknown>('POST', '/v1/wechat/edit_message', { chat_id, msg_id, text })
        return { content: [{ type: 'text', text: JSON.stringify(r) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'edit_message')
      }
    },
  )

  server.registerTool(
    'broadcast',
    {
      title: 'Broadcast text to all online users',
      description: '向所有在线用户群发文本。account_id 可选（不填则默认主账号）。',
      inputSchema: { text: z.string(), account_id: z.string().optional() },
    },
    async (args) => {
      try {
        const r = await client.request<unknown>('POST', '/v1/wechat/broadcast', args)
        return { content: [{ type: 'text', text: JSON.stringify(r) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'broadcast')
      }
    },
  )
}
