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
    'send_sticker',
    {
      title: 'Send a sticker from the local library',
      description: '按 tag 从本地表情库随机选一张表情包图片发到对话(内联图片)。情绪强/庆祝/安慰的时刻用,一次最多一张;若 tag 无匹配会返回可用 tags,换个 tag 或改用文字。',
      inputSchema: { chat_id: z.string(), tag: z.string() },
    },
    async ({ chat_id, tag }) => {
      try {
        const r = await client.request<unknown>('POST', '/v1/wechat/send_sticker', { chat_id, tag })
        return { content: [{ type: 'text', text: JSON.stringify(r) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'send_sticker')
      }
    },
  )

  server.registerTool(
    'search_online_sticker',
    {
      title: 'Search the internet for a sticker and send it',
      description: '按情绪联网找一张表情包发到对话并自动收进本地库。mood 用中文情绪词，query 用英文关键词效果最好；本地同类已攒够时会直接发本地表情。',
      inputSchema: { chat_id: z.string(), mood: z.string(), query: z.string() },
    },
    async ({ chat_id, mood, query }) => {
      try {
        const r = await client.request<unknown>('POST', '/v1/wechat/search_online_sticker', { chat_id, mood, query })
        return { content: [{ type: 'text', text: JSON.stringify(r) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'search_online_sticker')
      }
    },
  )

  server.registerTool(
    'search_online_sticker_candidates',
    {
      title: 'Search sticker candidates for visual selection',
      description: '联网搜索多张候选表情并返回预览，不发送。先根据语境看图选择最匹配的一张，再调用 send_online_sticker_candidate。',
      inputSchema: { query: z.string() },
    },
    async ({ query }) => {
      try {
        const r = await client.request<{ candidates?: Array<{ id: string; url: string }> }>('POST', '/v1/wechat/search_online_sticker_candidates', { query })
        const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [{ type: 'text', text: JSON.stringify(r) }]
        for (const candidate of (r.candidates ?? []).slice(0, 6)) {
          try {
            const response = await fetch(candidate.url)
            if (!response.ok) continue
            const mimeType = response.headers.get('content-type')?.split(';')[0] ?? 'image/gif'
            if (!mimeType.startsWith('image/')) continue
            const data = Buffer.from(await response.arrayBuffer()).toString('base64')
            content.push({ type: 'image', data, mimeType })
          } catch { /* one bad preview must not hide the others */ }
        }
        return { content }
      } catch (err) { return passthroughErrorResult(err, 'search_online_sticker_candidates') }
    },
  )

  server.registerTool(
    'send_online_sticker_candidate',
    {
      title: 'Send a selected online sticker candidate',
      description: '发送已视觉确认的联网表情，并在发送成功后收进本地库。仅在比较候选图片后调用。',
      inputSchema: { chat_id: z.string(), mood: z.string(), id: z.string(), url: z.string() },
    },
    async ({ chat_id, mood, id, url }) => {
      try {
        const r = await client.request<unknown>('POST', '/v1/wechat/send_online_sticker_candidate', { chat_id, mood, id, url })
        return { content: [{ type: 'text', text: JSON.stringify(r) }] }
      } catch (err) { return passthroughErrorResult(err, 'send_online_sticker_candidate') }
    },
  )

  server.registerTool(
    'sticker_feedback',
    {
      title: 'Record sticker feedback',
      description: '记录用户对刚发表情包的反馈，让后续选择更懂用户。用户说“这张不错/喜欢”用 positive；说“不是这个/太夸张/不喜欢”用 negative。',
      inputSchema: { chat_id: z.string(), signal: z.enum(['positive', 'negative']), file: z.string().optional() },
    },
    async ({ chat_id, signal, file }) => {
      try {
        const r = await client.request<unknown>('POST', '/v1/wechat/sticker_feedback', { chat_id, signal, ...(file ? { file } : {}) })
        return { content: [{ type: 'text', text: JSON.stringify(r) }] }
      } catch (err) { return passthroughErrorResult(err, 'sticker_feedback') }
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
